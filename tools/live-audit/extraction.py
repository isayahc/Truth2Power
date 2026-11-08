"""Extract citation-located text from immutable collection snapshots, without AI or OCR."""
import hashlib
import io
import json
import logging
import re
import uuid
from html.parser import HTMLParser
from pathlib import Path

from pypdf import PdfReader, __version__ as PDF_VERSION
from documents import LIMIT, now

PARSER = "document-text-v1"
MAX_PAGES = 200
MAX_TEXT = 2_000_000


class VisibleText(HTMLParser):
    """Remove non-content HTML without executing scripts or loading resources."""
    def __init__(self):
        super().__init__(convert_charrefs=True)
        self.hidden = []
        self.parts = []

    def handle_starttag(self, tag, attrs):
        if tag in {"script", "style", "head", "template"}:
            self.hidden.append(tag)
        if not self.hidden and tag in {"p", "div", "br", "li", "tr", "h1", "h2", "h3", "section"}:
            self.parts.append("\n")

    def handle_endtag(self, tag):
        if self.hidden and self.hidden[-1] == tag:
            self.hidden.pop()
        elif not self.hidden:
            self.parts.append("\n" if tag in {"p", "div", "li", "tr", "h1", "h2", "h3", "section"} else " ")

    def handle_data(self, data):
        if not self.hidden:
            self.parts.append(data)


def clean(text):
    text = text.replace("\x00", "").replace("\r", "\n")
    return "\n".join(line for line in (re.sub(r"[^\S\n]+", " ", s).strip()
                                     for s in text.splitlines()) if line)


def segment(text, locator):
    text = clean(text)
    usable = sum(c.isalnum() for c in text) >= 20 and text.count("\ufffd") <= len(text) * 0.05
    return dict(locator=locator, text=text, status="extracted" if usable else "needs_review",
                reason=None if usable else "empty_or_sparse_or_garbled_text")


def extract_bytes(data, suffix):
    if suffix == ".html":
        parser = VisibleText()
        parser.feed(data.decode("utf-8", errors="replace"))
        return [segment("".join(parser.parts), "HTML text (saved landing page)")]
    if suffix != ".pdf" or not data.startswith(b"%PDF-"):
        raise ValueError("unsupported_or_invalid_document")
    # Avoid third-party parser warnings containing source document contents.
    logger = logging.getLogger("pypdf")
    previous = logger.disabled
    logger.disabled = True
    try:
        reader = PdfReader(io.BytesIO(data))
        if reader.is_encrypted:
            raise ValueError("encrypted_pdf")
        if len(reader.pages) > MAX_PAGES:
            raise ValueError("page_limit_exceeded")
        pages, total = [], 0
        for number, page in enumerate(reader.pages, 1):
            try:
                text = page.extract_text() or ""
                total += len(text)
                if total > MAX_TEXT:
                    raise ValueError("text_limit_exceeded")
                pages.append(segment(text, f"page {number}"))
            except Exception as error:
                pages.append(dict(locator=f"page {number}", text="", status="needs_review",
                                  reason="page_extraction_failed", error_type=type(error).__name__))
        return pages
    finally:
        logger.disabled = previous


def extract_collection(hospital_key, collection_id, output, save):
    if not re.fullmatch(r"\d{1,8}", hospital_key) or not re.fullmatch(r"[0-9a-f]{32}", collection_id):
        raise ValueError("Use a hospital ID and saved collection ID")
    source = Path("collections") / hospital_key / (collection_id + ".json")
    manifest = json.loads((output / source).read_text(encoding="utf-8"))
    if manifest["hospital_key"] != hospital_key:
        raise ValueError("Collection hospital mismatch")
    run_id = uuid.uuid4().hex
    directory = Path("extractions") / hospital_key / run_id
    results = []
    records = [manifest.get("landing_page") or {"source_url": manifest["landing_url"], "status": "failed"}]
    records += manifest["documents"]
    started = now()
    for index, record in enumerate(records):
        result = dict(source_url=record.get("source_url", record.get("url")),
                      snapshot_sha256=record.get("sha256"), status="needs_review")
        results.append(result)
        if record.get("status") == "failed":
            result["reason"] = "source_not_downloaded"
            result["http_status"] = record.get("http_status")
            continue
        try:
            digest = record["sha256"]
            suffix = ".html" if index == 0 else ".pdf"
            expected = Path("snapshots") / (digest + suffix)
            if not re.fullmatch(r"[0-9a-f]{64}", digest) or record["artifact_path"] != expected.as_posix():
                raise ValueError("invalid_snapshot_path")
            path = output / expected
            if not path.resolve().is_relative_to(output.resolve()) or path.stat().st_size > LIMIT:
                raise ValueError("invalid_snapshot_size_or_path")
            data = path.read_bytes()
            if hashlib.sha256(data).hexdigest() != digest:
                raise ValueError("snapshot_hash_mismatch")
            segments = extract_bytes(data, suffix)
            if sum(len(s["text"]) for s in segments) > MAX_TEXT:
                raise ValueError("text_limit_exceeded")
            review = [s["locator"] for s in segments if s["status"] == "needs_review"]
            status = "extracted" if segments and not review else "needs_review"
            text_path = directory / f"{index}-{digest}.json"
            payload = dict(parser=PARSER, pypdf_version=PDF_VERSION, source_url=result["source_url"],
                           snapshot_sha256=digest, snapshot_path=expected.as_posix(), segments=segments)
            save(output / text_path, json.dumps(payload, ensure_ascii=False, indent=2).encode("utf-8"))
            result.update(status=status, text_path=text_path.as_posix(), segment_count=len(segments),
                          character_count=sum(len(s["text"]) for s in segments), review_locators=review)
            if status == "needs_review":
                result["reason"] = "no_usable_text_or_pages_require_review"
        except Exception as error:
            result.update(reason=str(error) if isinstance(error, ValueError) else "extraction_failed",
                          error_type=type(error).__name__)
    review_count = sum(r["status"] == "needs_review" for r in results)
    manifest_path = directory / "manifest.json"
    payload = dict(schema_version="1.0", parser=PARSER, pypdf_version=PDF_VERSION,
                   hospital_key=hospital_key, collection_manifest=source.as_posix(),
                   attempted_at=started, completed_at=now(),
                   status="needs_review" if review_count else "complete", documents=results)
    save(output / manifest_path, json.dumps(payload, indent=2).encode("utf-8"))
    report = (f"Hospital {hospital_key}: {len(results) - review_count}/{len(results)} sources extracted without review flags; "
              f"{review_count} need human review.\nExtraction manifest: {output / manifest_path}\n" +
              "\n".join(f"{r['status']}: {r['source_url']}" + (f" ({r['reason']})" if "reason" in r else "") for r in results) +
              "\nPDF locators preserve original page numbers. No OCR, translation or compliance findings. "
              "Sparse/blank pages are flagged conservatively; text presence does not prove completeness or correct table structure.")
    return dict(report=report, manifest_file=str(output / manifest_path), document_count=len(results), review_count=review_count)
