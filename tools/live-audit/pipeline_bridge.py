"""Bounded worker bridge to the existing collector and extractor. No model calls."""
from collections import Counter
from usage import measured, usage
from run_budget import current, RunBudget
import argparse
import hashlib
import json
import os
import uuid
from pathlib import Path
from documents import collect, LIMIT, Links, Bounds
from extraction import extract_collection, extract_bytes, layout_inventory

class CollectionFailure(ValueError):
    def __init__(self, code, diagnostic=None):
        super().__init__(code)
        self.code = code
        self.diagnostic = diagnostic or {}

SOURCE_FAILURE_CODES = {'source_host_blocked', 'unsafe_destination', 'redirect_loop', 'redirect_limit', 'tls_certificate_invalid', 'website_verification_required'}


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


def run(root, request):
    root = root.resolve()
    if request['mode'] == 'live':
        result = collect(request['hospital_key'], Path(__file__).resolve().parents[2], root, save, bounds=Bounds(**request.get('bounds', {})))
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
        extracted = extract_collection(request['hospital_key'], Path(result['manifest_file']).stem, root, save)
        return dict(collection=result['output'], extraction_manifest=str(Path(extracted['manifest_file']).relative_to(root)))
    sources = {}
    applications = []
    for source in request['sources']:
        snapshot = source.get('snapshot')
        if not snapshot:
            continue
        path = (root / snapshot['artifact_path']).resolve()
        if not path.is_relative_to(root) or path.stat().st_size > LIMIT:
            raise ValueError('invalid_snapshot_path_or_size')
        raw = path.read_bytes()
        if hashlib.sha256(raw).hexdigest() != snapshot['sha256']:
            raise ValueError('snapshot_hash_mismatch')
        # Preserve unknown bytes for later classification without interpreting their contents.
        if source.get('role') == 'unclassified' and path.suffix != '.html':
            sources[source['source_id']] = []
            continue
        try:
            segments = extract_bytes(raw, path.suffix)
        except Exception:
            sources[source['source_id']] = [dict(locator='Original document', text='', status='needs_review',
                                                  reason='unsupported_or_unreadable_document')]
            continue
        if path.suffix == '.html':
            parser = Links(snapshot.get('final_url', source['source_id']), all_links=True)
            parser.feed(raw.decode('utf-8', errors='replace'))
            segments += [dict(locator='link ' + url, text=next((label for label in labels if label), ''), status='extracted')
                         for url, labels in parser.links.items()]
        sources[source['source_id']] = segments
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
        return dict(sources=sources, application_reviews=applications)
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
