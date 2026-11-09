"""Validate #24 summary-only envelopes, review coverage and original-byte citations.

Run with --root .audit/live to also check the locally saved public snapshots.
Without --root this checks the committed contract and review provenance only.
Neither mode grants human approval or certifies model interpretation.
"""
import argparse
import hashlib
import json
from pathlib import Path

from jsonschema import Draft202012Validator, FormatChecker
from extraction import extract_bytes, PARSER
from posting import verified_snapshot

ROOT = Path(__file__).resolve().parents[2]
MEASURES = {
    'policy_summary.primary_service_area_described',
    'policy_summary.means_of_applying_explained',
    'policy_summary.income_levels_included',
}


def verify(envelope, review, root=None):
    schema = json.loads((ROOT / 'schemas/live-audit-v1.schema.json').read_bytes())
    Draft202012Validator(schema, format_checker=FormatChecker()).validate(envelope)
    if review['parser_version'] != PARSER:
        raise ValueError('Re-review required after parser change')
    if (envelope['reference_version'] != review['review_id'] or envelope['review_date'] != review['review_date']
            or envelope['assessment']['completed_at'] != review['checked_at']):
        raise ValueError('Result and review provenance differ')
    findings = envelope['assessment']['findings']
    if len(findings) != 3 or {f['measure_id'] for f in findings} != MEASURES:
        raise ValueError('Exactly the three summary measures are required')
    snapshots = {s['snapshot_id']: s for s in envelope['snapshots']}
    if len(snapshots) != len(envelope['snapshots']) or any(s['document_type'] != 'policy_summary' for s in snapshots.values()):
        raise ValueError('Only distinct designated summary sources are allowed')
    docs = review['hospitals'][envelope['hospital_key']]['documents']
    if len(docs) != len(snapshots) or {d['snapshot_id'] for d in docs} != set(snapshots):
        raise ValueError('Source review coverage differs from findings')
    citations = []
    for doc in docs:
        if doc['role'] != 'policy_summary' or not doc['visual_review_complete'] or not doc['language']:
            raise ValueError('Summary role, language and visual coverage required')
        if not doc['reviewed_pages'] or len(set(doc['reviewed_pages'])) != len(doc['reviewed_pages']):
            raise ValueError('Complete distinct page coverage required')
        for name in ('title_evidence', 'campus_evidence'):
            if doc[name]['snapshot_id'] != doc['snapshot_id']:
                raise ValueError('Scope evidence must cite this summary')
            citations.append(doc[name])
    for finding in findings:
        if {c['snapshot_id'] for c in finding['evidence']} != set(snapshots):
            raise ValueError('Each measure requires evidence from every reviewed language')
        outcomes = {d['measure_results'][finding['measure_id']] for d in docs}
        expected = next(iter(outcomes)) if len(outcomes) == 1 else 'unclear'
        if finding['result'] != expected:
            raise ValueError('Aggregate result differs from language-specific reviews')
        if finding['result'] == 'no' and not finding.get('search_notes'):
            raise ValueError('Absence finding requires complete search notes')
        citations.extend(finding['evidence'])
    for citation in citations:
        doc = next(d for d in docs if d['snapshot_id'] == citation['snapshot_id'])
        if not citation['quote'].strip() or citation['locator'] not in doc['reviewed_pages']:
            raise ValueError('Citation must identify reviewed content')
    if root is not None:
        for doc in docs:
            source = snapshots[doc['snapshot_id']]
            _, raw = verified_snapshot(root, source, 'policy_summary')
            pages = extract_bytes(raw, Path(source['artifact_path']).suffix)
            if any(p['status'] != 'extracted' for p in pages) or [p['locator'] for p in pages] != doc['reviewed_pages']:
                raise ValueError('Review does not cover every source page')
            text = {p['locator']: p['text'] for p in pages}
            for citation in (c for c in citations if c['snapshot_id'] == doc['snapshot_id']):
                if citation['quote'] not in text[citation['locator']]:
                    raise ValueError('Quote does not match the original source page')
    return dict(hospital_key=envelope['hospital_key'], sources=len(docs),
                reviewed_pages=sum(len(d['reviewed_pages']) for d in docs),
                citations=len(citations), original_bytes_verified=root is not None)


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--root', type=Path)
    args = parser.parse_args()
    directory = ROOT / 'docs/audit-format/summaries'
    review = json.loads((directory / 'review.json').read_bytes())
    reports = [verify(json.loads((directory / f'{key}.json').read_bytes()), review, args.root) for key in ('1002', '362')]
    if args.root:
        # Independently bind the newly discovered summary page and PDF captures.
        discovery = review['discovery']
        parent = args.root / 'snapshots' / (discovery['discovery_parent_sha256'] + '.html')
        parent_bytes = parent.read_bytes()
        if hashlib.sha256(parent_bytes).hexdigest() != discovery['discovery_parent_sha256']:
            raise ValueError('Discovery parent hash mismatch')
        records = discovery['records']
        from urllib.parse import urlsplit
        from documents import Links
        if urlsplit(records[0]['url']).path not in parent_bytes.decode('utf-8'):
            raise ValueError('Summary page was not linked by saved landing')
        _, html = verified_snapshot(args.root, records[0], 'landing_page')
        links = Links(records[0]['url'])
        links.feed(html.decode('utf-8'))
        for record in records[1:]:
            verified_snapshot(args.root, record, 'policy_summary')
            if record['url'] not in links.links:
                raise ValueError('Summary PDF absent from captured summary page')
            if not any(s['sha256'] == record['sha256'] and s['url'] == record['url'] for s in
                       json.loads((directory / '362.json').read_bytes())['snapshots']):
                raise ValueError('Discovery and summary source differ')
    print(json.dumps(reports, indent=2))


if __name__ == '__main__':
    main()
