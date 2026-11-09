"""Package/replay Ellenville #64's complete source review without network or model calls."""
import argparse
import hashlib
import json
from pathlib import Path
import sys
import tempfile
import zipfile

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT / 'tools/live-audit'))
from cross_documents import load_sources
from full_review import aggregate, verify_state

REVIEW = 'f3855e2408eb437e84e45e0c1319c02e'
RESULT = '0a59d1543b5844ed8a0268f5e9425748'
BASE = f'full-reviews/{REVIEW}'
DEST = ROOT / 'docs/validation'


def digest(data):
    return hashlib.sha256(data).hexdigest()


def package(root, destination):
    state = json.loads((root / BASE / 'state.json').read_bytes())
    extraction = f"extractions/1002/{state['extraction_id']}/manifest.json"
    manifest = json.loads((root / extraction).read_bytes())
    paths = [Path(BASE) / 'state.json', Path(extraction), Path(manifest['collection_manifest'])]
    paths += [Path(s['snapshot']['artifact_path']) for s in state['sources']]
    paths += [p.relative_to(root) for p in (root / BASE / 'results').glob('*.json')]
    paths += [p.relative_to(root) for p in (root / BASE / 'human-decisions').glob('*.json')]
    # Preserve exact inbox decisions only when tied to a packaged original result.
    result_hashes = {digest((root / p).read_bytes()) for p in paths if p.parent.as_posix() == BASE + '/results'}
    for path in (root / 'review-inbox-decisions').glob('*.json'):
        if json.loads(path.read_bytes()).get('result_sha256') in result_hashes:
            paths.append(path.relative_to(root))
    entries = {p.as_posix(): (root / p).read_bytes() for p in paths}
    entries['package-manifest.json'] = json.dumps({p: digest(b) for p, b in sorted(entries.items())}, indent=2).encode()
    with zipfile.ZipFile(destination, 'w', zipfile.ZIP_DEFLATED) as archive:
        for path, data in sorted(entries.items()):
            archive.writestr(zipfile.ZipInfo(path, (2026, 11, 9, 0, 0, 0)), data, compress_type=zipfile.ZIP_DEFLATED)


def reproduce(root):
    state_bytes = (root / BASE / 'state.json').read_bytes()
    state = json.loads(state_bytes)
    fresh, unavailable = load_sources('1002', state['extraction_id'], root)
    verify_state(state, fresh)
    for gap in unavailable:
        if gap not in state['unavailable']:
            state['unavailable'].append(gap)
    findings, coverage, gaps = aggregate(state)
    original_path = root / BASE / 'results' / (RESULT + '.json')
    original = json.loads(original_path.read_bytes())
    if (original['hospital_key'] != state['hospital_key'] or original['review_id'] != REVIEW
            or original['result_id'] != RESULT or original['extraction_id'] != state['extraction_id']
            or original['snapshots'] != [s['snapshot'] for s in state['sources']]):
        raise ValueError('Preserved result identity differs from verified source review')
    if findings != original['findings'] or coverage != original['coverage'] or gaps != original['gaps']:
        raise ValueError('Recomputed full review differs from preserved result; create a new review revision')
    snapshots = {s['snapshot']['snapshot_id']: s['snapshot'] for s in fresh}
    def enrich(citation):
        snapshot = snapshots[citation['snapshot_id']]
        return dict(citation, sha256=snapshot['sha256'], url=snapshot['url'],
                    retrieved_at=snapshot['retrieved_at'], reviewed_at=original['checked_at'])
    for finding in findings:
        finding['evidence'] = [enrich(c) for c in finding['evidence']]
        finding['coverage_gaps'] = gaps
    psa_evidence = [enrich(dict(snapshot_id=s['snapshot']['snapshot_id'], locator=p['locator'], quote=p['text']))
                    for s in fresh for p in s['segments']
                    if s['snapshot']['document_type'] in ('policy_statement', 'policy_summary')
                    and ('Ulster' in p['text'] or 'primary service area' in p['text'])]
    findings.insert(0, dict(measure_id='posted_materials.primary_service_area_boundaries_compliant',
        result='unclear', reason_code='insufficient_evidence', evidence=psa_evidence,
        observed=dict(listed_counties=['Ulster', 'Dutchess', 'Orange', 'Sullivan', 'Delaware', 'Greene', 'Columbia']),
        expected='Emergency financial aid for NY residents; medically necessary services under applicable commissioner PSA criteria.',
        unresolved_questions=[original['psa']['unresolved_question'],
            'Verify the 2007 DOH county-of-location table and whether it remains applicable on 2026-11-09, including later revisions and any hospital-specific boundary changes. The PDF was discovered but original bytes could not be captured in this follow-up.',
            'Obtain a separate human decision on the governing rule and the exact hospital finding. A matching county list or source URL is not approval.'],
        coverage_gaps=gaps, rule_approval='pending'))
    history = [dict(path=p.relative_to(root).as_posix(), sha256=digest(p.read_bytes()))
               for p in sorted((root / BASE / 'results').glob('*.json'))]
    return dict(version='ellenville-full-review-replay-v1', hospital_key='1002',
        source_reviewed_at=original['checked_at'], follow_up_date='2026-11-09',
        state_sha256=digest(state_bytes), original_result_sha256=digest(original_path.read_bytes()),
        original_result_path=original_path.relative_to(root).as_posix(), original_results=history,
        human_review='pending', review_kind='verified replay of prior model review; no new human decision',
        findings=findings, coverage=coverage, gaps=gaps, source_reviews=original['source_reviews'],
        review_history=[dict(source_id=s['source_id'], revisions=s['reviews']) for s in state['sources']],
        snapshots=original['snapshots'], psa_authority=original['psa'],
        limitations=['This replay verifies all 52 source units (landing page plus 51 PDF pages), not a new website-wide completeness claim.',
                    'All historical model revisions are retained; revalidation of citations does not certify their interpretation.',
                    'Integrated grading and exact-subject human decisions remain separate.'])


def replay_archive(path):
    with tempfile.TemporaryDirectory() as temp, zipfile.ZipFile(path) as archive:
        root = Path(temp)
        names = archive.namelist()
        if len(set(names)) != len(names) or sum(i.file_size for i in archive.infolist()) > 50_000_000:
            raise ValueError('Invalid or oversized evidence package')
        manifest = json.loads(archive.read('package-manifest.json'))
        if set(names) != set(manifest) | {'package-manifest.json'}:
            raise ValueError('Evidence package inventory mismatch')
        for name, expected in manifest.items():
            target = (root / name).resolve()
            if not target.is_relative_to(root.resolve()):
                raise ValueError('Unsafe evidence path')
            data = archive.read(name)
            if digest(data) != expected:
                raise ValueError('Evidence package hash mismatch')
            target.parent.mkdir(parents=True, exist_ok=True)
            target.write_bytes(data)
        return reproduce(root)


def markdown(report):
    lines = ['# Ellenville: four-measure full-review evidence (#64)', '',
        'Reproduce: `.venv/Scripts/python.exe scripts/export-full-review.py`. Offline; no model calls.', '',
        'The ZIP preserves original source bytes, collection/extraction manifests, every source-review revision and historical results. The JSON adds URL/hash/date to every finding citation. This is verified replay of the 2026-11-08 model review, with a 2026-11-09 follow-up; human review remains pending.', '',
        '## Complete source coverage', '', '| Source | Language | Reviewed units | Status | Revisions |', '|---|---|---:|---|---:|']
    for c in report['coverage']:
        lines.append(f"| {c['source_id']} | {c['language']} | {len(c['reviewed_pages'])}/{c['total_pages']} | {c['status']} | {c['source_review_revisions']} |")
    lines += ['', 'Ten sources reviewed for eligibility, one fully read privacy notice excluded with scope evidence. Total: landing page plus 51 PDF pages, five languages, 22 model-review revisions. Delivery alone is not review.', '', '## Findings and precise blockers', '']
    for f in report['findings']:
        lines += [f"### `{f['measure_id']}` — {f['result']}", '']
        if 'explanation' in f:
            lines += [f['explanation'], '']
        for question in f['unresolved_questions']:
            lines.append('- ' + question)
        lines += ['']
    lines += ['## Favorable evidence and context', '',
        '- Policies/applications permit applications during collections. “Timely” completion after Medicaid denial and Russian “data collection” wording need interpretation; neither is automatically a fixed submission deadline.',
        '- English policy excludes assets; income from assets and income documentation do not establish an asset eligibility test. Resource-exhaustion and Spanish asset wording remain reconciliation questions.',
        '- Policies and applications prohibit immigration-based eligibility restrictions. The Ukrainian phrase is not treated as a definite exclusion. The law’s Medicaid-application exception for immigration-ineligible patients also merits reviewer attention; the historical draft did not separately decide it.',
        '- Appeal deadlines, processing periods, collection waiting periods and approval duration remain distinct timing contexts in the saved observations.', '',
        '## External follow-up', '',
        '- The linked 2021 policy returned HTTP 404 again on 2026-11-09. It remains a coverage gap, not a finding that the hospital has no policy. Obtain the document or authoritative withdrawal/supersession confirmation.',
        '- See [rule and interpretation questions](issue-64-review-questions.md) for current statute context, the discovered DOH service-area guidance lead, retrieval limitations and decisions needed.',
        '- #20/#67 subject-matter agreement and exact-result approval remain pending. Do not close #64 or promote these drafts based on passing software checks.', '']
    return '\n'.join(lines)


if __name__ == '__main__':
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--capture-root', type=Path)
    args = parser.parse_args()
    archive = DEST / 'ellenville-full-review-evidence.zip'
    if args.capture_root:
        package(args.capture_root, archive)
    report = replay_archive(archive)
    (DEST / 'ellenville-full-review.json').write_text(json.dumps(report, ensure_ascii=False, indent=2) + '\n', encoding='utf-8', newline='\n')
    (DEST / 'ellenville-full-review.md').write_text(markdown(report), encoding='utf-8', newline='\n')
    print(json.dumps(dict(sources=len(report['coverage']), findings=len(report['findings']),
                         outcomes=[f['result'] for f in report['findings']], human_review=report['human_review'])))
