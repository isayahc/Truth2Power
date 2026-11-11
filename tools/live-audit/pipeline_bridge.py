"""Bounded worker bridge to the existing collector and extractor. No model calls."""
from collections import Counter
from concurrent.futures import Future, ThreadPoolExecutor
from typing import Any
from usage import measured, usage
from run_budget import current, RunBudget
import argparse
import hashlib
import json
import os
import uuid
from pathlib import Path
from documents import collect, Links, Bounds
from extraction import (PARSER, PDF_VERSION, extract_bytes, extract_collection, layout_inventory,
                        prepared_path, read_prepared, snapshot_bytes)
from evidence_workers import explicit_identity, review_source

class CollectionFailure(ValueError):
    def __init__(self, code, diagnostic=None):
        super().__init__(code)
        self.code = code
        self.diagnostic = diagnostic or {}

SOURCE_FAILURE_CODES = {'source_host_blocked', 'unsafe_destination', 'redirect_loop', 'redirect_limit', 'tls_certificate_invalid', 'website_verification_required', 'dns_resolution_failed', 'retrieval_timeout', 'invalid_content', 'resource_limit'}


def save(path, data):
    path.parent.mkdir(parents=True, exist_ok=True)
    temporary = path.with_name(path.name + '.' + uuid.uuid4().hex + '.tmp')
    try:
        with temporary.open('xb') as stream:
            stream.write(data)
            stream.flush()
            os.fsync(stream.fileno())
        try:
            os.link(temporary, path)
            measured("artifacts_written")
            measured("storage_bytes", len(data))
        except FileExistsError:
            if path.read_bytes() != data:
                raise ValueError('immutable_artifact_collision')
            measured('artifact_reuses')
    finally:
        temporary.unlink(missing_ok=True)


def page_anchors(raw: bytes, base: str) -> list[dict]:
    """Resolve public anchor locators against this capture's final page URL."""
    links = Links(base, all_links=True)
    links.feed(raw.decode("utf-8", errors="replace"))
    return [dict(locator="link " + url, text=next((label for label in labels if label), ""), status="extracted")
            for url, labels in links.links.items()]


def representative_passages(segments: list[dict]) -> list[dict[str, str]]:
    """Supply short original passages from up to four evenly spaced readable locations."""
    windows = [(s, start) for s in segments if s["status"] == "extracted"
               for start in range(0, len(s["text"]), 700)]
    selected = windows if len(windows) <= 4 else [windows[i * (len(windows) - 1) // 3] for i in range(4)]
    return [dict(locator=part["locator"], quote=part["text"][start:start + 700]) for part, start in selected]


def prepare_capture(root: Path, record: dict, counters: Counter) -> str:
    """Extract and review an immutable source as the collector continues fetching."""
    token = usage.set(counters)
    try:
        raw = snapshot_bytes(root, record)
        original = record["source_url"]
        suffix = Path(record["artifact_path"]).suffix
        packet = dict(parser=PARSER, pypdf_version=PDF_VERSION, source_url=original,
                      snapshot_sha256=record["sha256"], snapshot_path=record["artifact_path"])
        try:
            segments = extract_bytes(raw, suffix)
        except Exception as error:
            packet["error"] = dict(reason=str(error) if isinstance(error, ValueError) else "extraction_failed",
                                   error_type=type(error).__name__)
        else:
            packet["segments"] = segments
            website = suffix == ".html"
            if website:
                packet["anchor_base"] = record.get("final_url") or original
                packet["anchors"] = page_anchors(raw, packet["anchor_base"])
            role = record.get("document_type") or ("landing_page" if website and record.get("depth") == 0 else "unclassified")
            source = dict(source_id=original, role=role, snapshot=record)
            packet["review_role"] = role
            packet["review"] = review_source(source, segments + packet.get("anchors", []), website)
        encoded = json.dumps(packet, ensure_ascii=False, separators=(",", ":")).encode("utf-8")
        receipt = hashlib.sha256(encoded).hexdigest()
        save(prepared_path(root, receipt), encoded)
        return receipt
    finally:
        usage.reset(token)


def collect_for_review(root: Path, request: dict) -> tuple[dict, dict[str, str]]:
    """Start webpage and file work on capture and publish one receipt per distinct original."""
    args = (request["hospital_key"], Path(__file__).resolve().parents[2], root, save)
    bounds = Bounds(**request.get("bounds", {}))
    if request.get("discovery_only"):
        return collect(*args, bounds=bounds), {}
    pages = ThreadPoolExecutor(1, "audit-web-review")
    files = ThreadPoolExecutor(1, "audit-file-review")
    futures: dict[str, Future[str]] = {}
    meters: list[Counter] = []

    def on_capture(record: dict) -> None:
        """Queue by original digest and format; URLs stay separate in the manifest."""
        path = record["artifact_path"]
        if path not in futures:
            counters = Counter()
            meters.append(counters)
            worker = pages if path.endswith(".html") else files
            futures[path] = worker.submit(prepare_capture, root, dict(record), counters)

    try:
        result = collect(*args, bounds=bounds, on_capture=on_capture)
        if result["output"].get("budget_stop") or result["output"]["status"] == "failed":
            return result, {}
        return result, {path: future.result() for path, future in futures.items()}
    finally:
        pages.shutdown(wait=True, cancel_futures=True)
        files.shutdown(wait=True, cancel_futures=True)
        for meter in meters:
            for unit, amount in meter.items():
                measured(unit, amount)


def run(root: Path, request: dict) -> dict[str, Any]:
    """Collect live evidence or review saved sources with their original locators."""
    root = root.resolve()
    if request['mode'] == 'live':
        result, prepared = collect_for_review(root, request)
        if result['output'].get('budget_stop'):
            return dict(collection=result['output'], budget_stop=result['output']['budget_stop'], manifest=Path(result['manifest_file']).name)
        if result['output']['status'] == 'failed':
            from urllib.parse import urlsplit, urlunsplit
            from documents import approved
            output = result['output']
            page = next((p for p in output.get('pages', []) if p.get('source_url') == output.get('landing_url')), {})
            raw_url = page.get('source_url') or output.get('landing_url')
            parsed = urlsplit(raw_url or '')
            source_url = None
            try:
                approved(raw_url, (parsed.hostname or '').removeprefix('www.'))
                source_url = urlunsplit((parsed.scheme, parsed.netloc, parsed.path, '', ''))
            except (ValueError, TypeError):
                pass
            diagnostic = dict(source_url=source_url, manifest_id=Path(result['manifest_file']).stem if result.get('manifest_file') else None)
            status = page.get('http_status', output.get('http_status'))
            if type(status) is int and 400 <= status <= 599:
                diagnostic['http_status'] = status
                if page.get('error_code') == 'website_verification_required':
                    raise CollectionFailure('website_verification_required', diagnostic)
                raise CollectionFailure('http_error', diagnostic)
            for page in result['output'].get('pages', []):
                if page.get('error_code') in SOURCE_FAILURE_CODES:
                    raise CollectionFailure(page['error_code'], diagnostic)
            raise CollectionFailure('collection_failed', diagnostic)
        if request.get('discovery_only'):
            return dict(collection=result['output'])
        # Preserve the collection extraction manifest for existing offline review tools.
        extracted = extract_collection(request['hospital_key'], Path(result['manifest_file']).stem, root, save, prepared=prepared)
        return dict(collection=result['output'], extraction_manifest=str(Path(extracted['manifest_file']).relative_to(root)),
                    file_text_status=extracted['file_text_status'], prepared_extractions=prepared)
    sources = {}
    applications = []
    reviews = {}
    file_text_status = {}
    # Old manifests and replay requests may have no derived receipt.
    # Reuse original-text parsing across URL aliases while keeping their links and roles separate.
    parsed: dict[str, list[dict] | None] = {}
    references = Counter(s["snapshot"]["artifact_path"] for s in request["sources"] if s.get("snapshot"))
    prepared = request.get("prepared_extractions") or {}
    for source in request['sources']:
        snapshot = source.get('snapshot')
        if not snapshot:
            continue
        path = Path(snapshot["artifact_path"])
        raw = snapshot_bytes(root, snapshot)
        receipt = prepared.get(snapshot["artifact_path"])
        packet = read_prepared(root, snapshot, receipt) if receipt else {}
        if packet:
            segments = packet.get("segments")
        elif snapshot["artifact_path"] in parsed:
            segments = parsed[snapshot["artifact_path"]]
        else:
            try:
                segments = extract_bytes(raw, path.suffix)
            except Exception:
                segments = None
            if references[snapshot["artifact_path"]] > 1:
                parsed[snapshot["artifact_path"]] = segments
        if segments is None:
            segments = [dict(locator="Original document", text="", status="needs_review",
                             reason="unsupported_or_unreadable_document")]
        if path.suffix in {'.pdf', '.docx'}:
            file_text_status[snapshot['sha256']] = 'extracted' if segments and all(p['status'] == 'extracted' for p in segments) else 'needs_review'
        base = snapshot.get('final_url', source['source_id'])
        if path.suffix == '.html':
            anchors = packet["anchors"] if packet.get("anchor_base") == base else page_anchors(raw, base)
            segments = segments + anchors
        identity = None
        if (request.get('application_review_date') and source.get('role') == 'unclassified'
                and path.suffix in {'.pdf', '.docx'} and source.get('allow_explicit_identity')):
            identity = explicit_identity(segments, source['hospital_key'])
            if identity:
                source = {**source, 'role': identity['role'], 'language': identity['language']}
        if request.get('application_review_date'):
            website = path.suffix == ".html"
            if "review" in packet and packet["review_role"] == source.get("role") and (not website or packet["anchor_base"] == base):
                review = {**packet["review"], "source_id": source["source_id"]}
            else:
                review = review_source(source, segments, website)
            if not website and source.get("role") == "unclassified":
                review["sample_passages"] = representative_passages(segments)
            reviews[source['source_id']] = review
            if identity:
                reviews[source['source_id']]['explicit_identity'] = identity
        # The grader consumes full text only for classified files and web pages.
        # Other files contribute bounded, located observations through their review.
        sources[source['source_id']] = ([] if source.get('role') == 'unclassified'
                                        and path.suffix != '.html' else segments)
        if request.get('application_review_date') and source['role'] == 'application':
            from applications import evaluate, REFERENCE
            findings, status = evaluate(dict(segments=segments, snapshot=snapshot), request['application_review_date'],
                                        json.loads(REFERENCE.read_bytes()), source['language'])
            from template_comparison import application_template_context, attach_application_context
            template = application_template_context(dict(segments=segments, snapshot=snapshot), source['hospital_key'], source['language']) if request['application_review_date'].startswith('2026-') else None
            if template:
                attach_application_context(findings, template)
            applications.append(dict(source_id=source['source_id'], hospital_key=source['hospital_key'],
                language=source['language'], snapshot=snapshot, findings=findings, status=status,
                parser_version='document-text-v5', profile_version='application-language-profiles-v1',
                reference_sha256=hashlib.sha256(REFERENCE.read_bytes()).hexdigest(), human_review='pending',
                template_comparison=template,
                layout=layout_inventory(raw, path.suffix),
                reviewed_segments=[p['locator'] for p in segments],
                drawings=[d for p in segments for d in p.get('drawings', [])]))
    if request.get('application_review_date'):
        return dict(sources=sources, reviews=reviews, application_reviews=applications, file_text_status=file_text_status)
    return sources


if __name__ == '__main__':
    import sys
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--root', type=Path, required=True)
    args = parser.parse_args()
    # Internal IPC output, not application logging. The Node worker logs metadata only.
    request = json.load(sys.stdin)
    if request.get("run_budget"):
        current.set(RunBudget(request["run_budget"]))
    if request.pop("meter", False):
        counters: Counter[str] = Counter()
        usage.set(counters)
        try:
            response = {"result": run(args.root, request)}
        except Exception as error:
            # Only allowlisted diagnostic codes cross the IPC boundary, never raw errors.
            response = {"failed": True, "error_code": error.code if isinstance(error, CollectionFailure) else None,
                        "diagnostic": error.diagnostic if isinstance(error, CollectionFailure) else None}
        print(json.dumps({**response, "usage": counters}, ensure_ascii=True))
    else:
        print(json.dumps(run(args.root, request), ensure_ascii=True))
