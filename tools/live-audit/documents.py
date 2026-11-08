"""Collect directly linked PDFs and DOCX from a roster assistance landing page."""
import hashlib
import json
import re
import uuid
import io
import zipfile
from datetime import datetime, timezone
from html.parser import HTMLParser
from pathlib import Path
from urllib.parse import urldefrag, urljoin, urlsplit
from urllib.request import HTTPRedirectHandler, Request, build_opener
from urllib.error import HTTPError

LIMIT = 12 * 1024 * 1024
MAX_DOCUMENTS = 100


def now():
    return datetime.now(timezone.utc).isoformat()


class Links(HTMLParser):
    """Keep document anchors, including duplicate labels and languages."""
    def __init__(self, base):
        super().__init__()
        self.base, self.links, self.current = base, {}, None

    def handle_starttag(self, tag, attrs):
        if tag == "a":
            href = dict(attrs).get("href", "")
            url = urldefrag(urljoin(self.base, href))[0]
            self.current = (url, []) if urlsplit(url).path.lower().endswith((".pdf", ".docx")) else None

    def handle_data(self, text):
        if self.current:
            self.current[1].append(text)

    def handle_endtag(self, tag):
        if tag == "a" and self.current:
            url, text = self.current
            self.links.setdefault(url, []).append(" ".join("".join(text).split()))
            self.current = None


def approved(url, host):
    parsed = urlsplit(url)
    if (parsed.scheme != "https" or parsed.hostname not in {host, "www." + host}
            or parsed.port not in {None, 443} or parsed.username or parsed.password):
        raise ValueError("Document or redirect is outside the roster site's HTTPS host")
    return url


def download(url, host):
    class Redirect(HTTPRedirectHandler):
        def redirect_request(self, req, fp, code, msg, headers, newurl):
            return super().redirect_request(req, fp, code, msg, headers, approved(newurl, host))

    request = Request(approved(url, host), headers={"User-Agent": "Truth2Power public document collection"})
    with build_opener(Redirect()).open(request, timeout=25) as response:
        data = response.read(LIMIT + 1)
        if len(data) > LIMIT:
            raise ValueError("Document exceeds 12 MiB limit")
        return data, approved(response.geturl(), host), response.headers.get_content_type()


def collect(hospital_key, root, output, save, fetch=download):
    """Persist an immutable attempt manifest, including failures and source URLs."""
    if not re.fullmatch(r"\d{1,8}", hospital_key):
        raise ValueError("Use a numeric hospital ID from the roster")
    roster = json.loads((root / "data/maps/hospitals.geojson").read_text(encoding="utf-8"))
    facility = next((f for f in roster["features"] if str(f["id"]) == hospital_key), None)
    if facility is None:
        raise ValueError("Hospital is not in the roster")
    url = facility["properties"]["assistance_url"]
    host = (urlsplit(url).hostname or "").removeprefix("www.")
    attempt = dict(schema_version="1.0", hospital_key=hospital_key, landing_url=url,
                   attempted_at=now(), status="failed", landing_page=None, documents=[],
                    limitations=["Direct .pdf/.docx anchors in saved HTML only; no JavaScript or recursive discovery. "
                                "External hosts require review. Downloading does not verify currency or campus applicability."])

    def snapshot(data, final_url, suffix, mime):
        digest = hashlib.sha256(data).hexdigest()
        path = Path("snapshots") / (digest + suffix)
        save(output / path, data)
        return dict(url=final_url, sha256=digest, artifact_path=path.as_posix(),
                    retrieved_at=now(), publisher_updated_at=None, content_type=mime, size_bytes=len(data))

    try:
        html, final_url, mime = fetch(url, host)
        if mime not in {"text/html", "application/xhtml+xml"}:
            raise ValueError("Landing page did not return HTML")
        attempt["landing_page"] = snapshot(html, final_url, ".html", mime)
        links = Links(final_url)
        links.feed(html.decode("utf-8", errors="replace"))
        for index, (source, labels) in enumerate(links.links.items()):
            record = dict(source_url=source, labels=labels, attempted_at=now(), status="failed")
            attempt["documents"].append(record)
            try:
                if index >= MAX_DOCUMENTS:
                    raise ValueError("100-document limit reached")
                approved(source, host)
                data, destination, content_type = fetch(source, host)
                suffix = Path(urlsplit(source).path).suffix.lower()
                if suffix == ".pdf" and not data.startswith(b"%PDF-"):
                    raise ValueError("Linked document is not a PDF")
                if suffix == ".docx":
                    with zipfile.ZipFile(io.BytesIO(data)) as archive:
                        if "word/document.xml" not in archive.namelist():
                            raise ValueError("Linked document is not a DOCX")
                record.update(snapshot(data, destination, suffix, content_type), status="saved")
            except Exception as error:
                record["error_type"] = type(error).__name__
                if isinstance(error, HTTPError):
                    record["http_status"] = error.code
                elif isinstance(error, ValueError):
                    record["reason"] = str(error)
        attempt["status"] = ("complete" if attempt["documents"] and
                             all(d["status"] == "saved" for d in attempt["documents"]) else "partial")
    except Exception as error:
        attempt["error_type"] = type(error).__name__
        if isinstance(error, HTTPError):
            attempt["http_status"] = error.code
    attempt["completed_at"] = now()
    path = output / "collections" / hospital_key / (uuid.uuid4().hex + ".json")
    save(path, json.dumps(attempt, indent=2, ensure_ascii=False).encode("utf-8"))
    saved = sum(d["status"] == "saved" for d in attempt["documents"])
    report = (f"Hospital {hospital_key}: {saved}/{len(attempt['documents'])} directly linked documents saved. "
              f"Collection status: {attempt['status']}.\nLanding page: {url}\nManifest: {path}\n"
              + "\n".join(f"{d['status']}: {d['source_url']}" +
                          (f" ({d['error_type']}, HTTP {d['http_status']})" if "http_status" in d
                           else f" ({d['error_type']})" if "error_type" in d else "")
                          for d in attempt["documents"])
              + "\nLimitations: " + " ".join(attempt["limitations"]))
    return dict(report=report, manifest_file=str(path), output=attempt)
