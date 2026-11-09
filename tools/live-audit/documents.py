"""Bounded, same-host resource discovery extending the original immutable collector."""
import hashlib
import json
import re
import uuid
import io
import zipfile
import socket
import ssl
import ipaddress
import http.client
import time
import threading
import queue as queues
from collections import deque
from dataclasses import dataclass, asdict
from datetime import datetime, timezone
from html.parser import HTMLParser
from pathlib import Path
from urllib.parse import urldefrag, urljoin, urlsplit, urlunsplit
from urllib.error import HTTPError

LIMIT = 12 * 1024 * 1024
MAX_DOCUMENTS = 100


def now():
    return datetime.now(timezone.utc).isoformat()


def normalize_url(url):
    """Drop fragments and canonicalize HTTPS authority only; keep path case and query order."""
    url = urldefrag(url)[0]
    p = urlsplit(url)
    if p.scheme == 'https' and not p.username and not p.password and p.hostname:
        authority = ('[' + p.hostname + ']') if ':' in p.hostname else p.hostname
        if p.port not in {None, 443}:
            authority += ':' + str(p.port)
        return urlunsplit((p.scheme, authority, p.path or '/', p.query, ''))
    return url


class Links(HTMLParser):
    """Keep document anchors, including duplicate labels and languages."""
    def __init__(self, base, all_links=False):
        super().__init__()
        self.base, self.links, self.current = base, {}, None
        self.all_links = all_links
        self.truncated = False
        self.base_seen = False
        self.late_base = False

    def handle_starttag(self, tag, attrs):
        if tag == "base" and not self.base_seen and dict(attrs).get("href"):
            if self.links:
                # Do not certify earlier anchors using a base that the browser would replace.
                self.links.clear()
                self.late_base = True
            self.base_seen = True
            self.base = urljoin(self.base, dict(attrs)["href"])
        if tag == "a":
            href = dict(attrs).get("href", "")
            try:
                url = normalize_url(urljoin(self.base, href))
            except ValueError:
                self.current = None
                return
            self.current = (url, []) if self.all_links or urlsplit(url).path.lower().endswith((".pdf", ".docx")) else None

    def handle_data(self, text):
        if self.current:
            self.current[1].append(text)

    def handle_endtag(self, tag):
        if tag == "a" and self.current:
            url, text = self.current
            if self.all_links and len(self.links) >= 5000 and url not in self.links:
                self.truncated = True
            else:
                self.links.setdefault(url, []).append(" ".join("".join(text).split()))
            self.current = None


def public_ip(value):
    address = ipaddress.ip_address(value)
    return address.is_global and not address.is_multicast and not address.is_reserved


def approved(url, host):
    parsed = urlsplit(url)
    if (parsed.scheme != "https" or parsed.hostname not in {host, "www." + host}
            or parsed.port not in {None, 443} or parsed.username or parsed.password
            or any(ord(c) < 33 for c in url) or "\\" in url):
        raise ValueError("Document or redirect is outside the roster site's HTTPS host")
    try:
        if not public_ip(parsed.hostname):
            raise ValueError("Private address prohibited")
    except ValueError as error:
        if str(error) == "Private address prohibited":
            raise
    if parsed.hostname in {"localhost", "metadata.google.internal"} or parsed.hostname.endswith((".local", ".internal")):
        raise ValueError("Internal hostname prohibited")
    return url


@dataclass(frozen=True)
class Bounds:
    depth: int = 3
    pages: int = 20
    documents: int = 100
    bytes_per_resource: int = LIMIT
    total_bytes: int = 64 * 1024 * 1024
    timeout: int = 20
    seconds: int = 120
    redirects: int = 5

    def __post_init__(self):
        caps = dict(depth=8, pages=100, documents=100, bytes_per_resource=LIMIT,
                    total_bytes=128 * 1024 * 1024, timeout=30, seconds=150, redirects=8)
        if any(type(v) is not int or v < 1 or v > caps[k] for k, v in asdict(self).items()):
            raise ValueError("Invalid traversal limits")


def public_addresses(host, timeout=20):
    # Native getaddrinfo has no timeout argument; a daemon lookup cannot hold the worker open.
    result = queues.Queue(maxsize=1)
    def lookup():
        try:
            result.put(socket.getaddrinfo(host, 443, type=socket.SOCK_STREAM))
        except Exception as error:
            result.put(error)
    threading.Thread(target=lookup, daemon=True).start()
    try:
        rows = result.get(timeout=timeout)
    except queues.Empty:
        raise TimeoutError("DNS deadline reached") from None
    if isinstance(rows, Exception):
        raise rows
    addresses = sorted({row[4][0] for row in rows})
    if not addresses or any(not public_ip(a) for a in addresses):
        raise ValueError("DNS resolved to a non-public address")
    return addresses


def download(url, host, bounds=None, trace=None):
    """Pin the validated public IP for each TLS connection; never use proxies or a second DNS lookup."""
    bounds = bounds or Bounds()
    deadline = time.monotonic() + bounds.timeout
    for hop in range(bounds.redirects + 1):
        approved(url, host)
        parsed = urlsplit(url)
        address = public_addresses(parsed.hostname, max(0.001, deadline - time.monotonic()))[0]
        remaining = deadline - time.monotonic()
        if remaining <= 0:
            raise TimeoutError("Download deadline reached")
        connection = http.client.HTTPSConnection(parsed.hostname, timeout=remaining)
        try:
            sock = socket.create_connection((address, 443), timeout=remaining)
            connection.sock = ssl.create_default_context().wrap_socket(sock, server_hostname=parsed.hostname)
            connection.request("GET", parsed.path + ("?" + parsed.query if parsed.query else "") or "/",
                               headers={"User-Agent": "Truth2Power public document collection", "Accept-Encoding": "identity"})
            response = connection.getresponse()
            if response.status in {301, 302, 303, 307, 308}:
                target = approved(urldefrag(urljoin(url, response.getheader("Location", "")))[0], host)
                if trace is not None:
                    trace.append(dict(source_url=url, final_url=target, http_status=response.status))
                url = target
                continue
            if response.status != 200:
                raise HTTPError(url, response.status, "Resource unavailable", response.headers, None)
            chunks, size = [], 0
            while True:
                remaining = deadline - time.monotonic()
                if remaining <= 0:
                    raise TimeoutError("Download deadline reached")
                if connection.sock:
                    connection.sock.settimeout(remaining)
                part = response.read1(min(65536, bounds.bytes_per_resource + 1 - size))
                if not part:
                    break
                chunks.append(part)
                size += len(part)
                if size > bounds.bytes_per_resource:
                    raise ValueError("Resource byte limit reached")
            return b"".join(chunks), url, response.headers.get_content_type()
        finally:
            connection.close()
    raise ValueError("Redirect limit reached")


def collect(hospital_key, root, output, save, fetch=download, bounds=None):
    """Persist an immutable attempt manifest, including failures and source URLs."""
    if not re.fullmatch(r"\d{1,8}", hospital_key):
        raise ValueError("Use a numeric hospital ID from the roster")
    roster = json.loads((root / "data/maps/hospitals.geojson").read_text(encoding="utf-8"))
    facility = next((f for f in roster["features"] if str(f["id"]) == hospital_key), None)
    if facility is None:
        raise ValueError("Hospital is not in the roster")
    url = facility["properties"]["assistance_url"]
    host = (urlsplit(url).hostname or "").removeprefix("www.")
    bounds = bounds or Bounds()
    inventory_path = root / "docs/audit-format/wave-one-document-inventory.json"
    known = []
    if inventory_path.exists():
        inventory = json.loads(inventory_path.read_bytes())
        known = [dict(d, hospital_key=h['hospital_key']) for h in inventory['hospitals'] for d in h['documents'] if d.get('status') == 'content_confirmed']
    summary_path = root / "docs/audit-format/changes/362-summary-posting.json"
    if summary_path.exists():
        summary = json.loads(summary_path.read_bytes())
        language_path = root / "docs/audit-format/summaries/362.json"
        languages = (json.loads(language_path.read_bytes())['assessment']['findings'][0]['observed']['documents']
                     if language_path.exists() else [])
        known += [dict(sha256=s['sha256'], type=s['document_type'], hospital_key=summary['hospital_key'],
                       language_label=next((d['language'] for d in languages if d['snapshot_id'] == s['snapshot_id']), 'und'),
                       evidence=[dict(locator=e['locator'], quote=e['quote']) for e in summary['assessment']['findings'][0]['evidence'] if e['snapshot_id'] == s['snapshot_id']])
                  for s in summary['snapshots'] if s['document_type'] == 'policy_summary']
    attempt = dict(schema_version="1.0", hospital_key=hospital_key, landing_url=url,
                   attempted_at=now(), status="failed", landing_page=None, documents=[],
                    pages=[], links=[], bounds=asdict(bounds),
                    limitations=["Bounded HTML-anchor traversal is not an exhaustive absence search. JavaScript-only resources require review; scripts are never executed. "
                                 "Only the roster host and its www alias are trusted, including redirects. Unknown campus/role/language requires review."])

    def snapshot(data, final_url, suffix, mime):
        digest = hashlib.sha256(data).hexdigest()
        path = Path("snapshots") / (digest + suffix)
        save(output / path, data)
        return dict(url=final_url, sha256=digest, artifact_path=path.as_posix(),
                    retrieved_at=now(), publisher_updated_at=None, content_type=mime, size_bytes=len(data))

    queue, visited, total = deque([(url, [], 0, None)]), set(), 0
    started = time.monotonic()
    while queue:
        source, labels, depth, parent = queue.popleft()
        if source in visited:
            continue
        visited.add(source)
        suffix = Path(urlsplit(source).path).suffix.lower()
        is_document = suffix in {".pdf", ".docx"}
        bucket = attempt["documents"] if is_document else attempt["pages"]
        record = dict(source_url=source, labels=labels, parent_url=parent, depth=depth,
                      attempted_at=now(), status="failed", classification="unverified")
        bucket.append(record)
        try:
            approved(source, host)
            if depth > bounds.depth or len(bucket) > (bounds.documents if is_document else bounds.pages):
                raise ValueError("Traversal depth or resource count limit reached")
            if time.monotonic() - started >= bounds.seconds or total >= bounds.total_bytes:
                raise ValueError("Traversal time or total byte limit reached")
            trace = []
            data, destination, mime = fetch(source, host, bounds, trace) if fetch is download else fetch(source, host)
            approved(destination, host)
            total += len(data)
            if len(data) > bounds.bytes_per_resource or total > bounds.total_bytes:
                raise ValueError("Traversal byte limit reached")
            if is_document:
                if suffix == ".pdf" and not data.startswith(b"%PDF-"):
                    raise ValueError("Linked document is not a PDF")
                if suffix == ".docx":
                    with zipfile.ZipFile(io.BytesIO(data)) as archive:
                        if "word/document.xml" not in archive.namelist():
                            raise ValueError("Linked document is not a DOCX")
            else:
                if mime not in {"text/html", "application/xhtml+xml"}:
                    raise ValueError("Resource page did not return HTML; classify manually")
                suffix = ".html"
            record.update(snapshot(data, destination, suffix, mime), final_url=destination, redirects=trace, status="saved")
            classified = next((d for d in known if d['sha256'] == record['sha256'] and d['hospital_key'] == hospital_key), None)
            if classified:
                record.update(classification="pinned_campus_inventory", document_type=classified['type'], language=classified['language_label'])
                record['classification_evidence'] = classified.get('evidence', [dict(locator=classified.get('locator'), quote=classified.get('quote'))])
            elif any(d['sha256'] == record['sha256'] for d in known):
                record["classification"] = "other_campus_requires_review"
            if source == url:
                attempt["landing_page"] = dict(record)
            if not is_document:
                links = Links(destination, all_links=True)
                links.feed(data.decode("utf-8", errors="replace"))
                if b"<script" in data.lower():
                    record["discovery_gap"] = "Scripts not executed; JavaScript-only links may be missing."
                if links.truncated:
                    record["link_limit_reached"] = True
                    attempt["limitations"].append("5000 unique anchors per page limit reached.")
                if links.late_base:
                    record["discovery_gap"] = "Late HTML base element: preceding anchors require review and were not traversed."
                for target, names in links.links.items():
                    if len(attempt["links"]) >= 5000:
                        attempt["limitations"].append("5000-link inventory limit reached; remaining anchors not traversed.")
                        break
                    relevant = (urlsplit(target).path.lower().endswith((".pdf", ".docx")) or
                                urlsplit(target).path.startswith(urlsplit(destination).path.rstrip('/') + '/') or
                                re.search(r"financial|assistance|charity|plain.language|documents|resources|/docs/|application|billing", target + " " + " ".join(names), re.I))
                    attempt["links"].append(dict(parent_url=source, parent_sha256=record["sha256"], target_url=target,
                                                 labels=names, disposition="candidate" if relevant else "out_of_scope"))
                    if relevant and target not in visited:
                        queue.append((target, names, depth + 1, source))
        except Exception as error:
            record["error_type"] = type(error).__name__
            if isinstance(error, HTTPError):
                record["http_status"] = error.code
                record["availability"] = "http_gone_not_confirmed_withdrawal" if error.code == 410 else "inaccessible"
            elif isinstance(error, ValueError):
                record["reason"] = str(error)
            if source == url:
                attempt["error_type"] = type(error).__name__
                if isinstance(error, HTTPError):
                    attempt["http_status"] = error.code
    if attempt["landing_page"]:
        attempt["status"] = "partial" if any(r["status"] != "saved" for r in attempt["pages"] + attempt["documents"]) or not attempt["documents"] else "complete"
    attempt["bytes_received"] = total
    attempt["completed_at"] = now()
    path = output / "collections" / hospital_key / (uuid.uuid4().hex + ".json")
    save(path, json.dumps(attempt, indent=2, ensure_ascii=False).encode("utf-8"))
    saved = sum(d["status"] == "saved" for d in attempt["documents"])
    report = (f"Hospital {hospital_key}: {saved}/{len(attempt['documents'])} linked documents saved through bounded traversal. "
              f"Collection status: {attempt['status']}.\nLanding page: {url}\nManifest: {path}\n"
              + "\n".join(f"{d['status']}: {d['source_url']}" +
                          (f" ({d['error_type']}, HTTP {d['http_status']})" if "http_status" in d
                           else f" ({d['error_type']})" if "error_type" in d else "")
                          for d in attempt["documents"])
               + "\nLimitations: " + " ".join(attempt["limitations"]))
    return dict(report=report, manifest_file=str(path), output=attempt)
