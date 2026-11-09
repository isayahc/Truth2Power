"""Export the two committed public-evidence assessments for clean-checkout replay."""
import argparse
import hashlib
import json
import sqlite3
import zipfile
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]

BLOCKERS = {
    'U': 'Source discovery; conflicting evidence; structured-observation coverage',
    'V': 'Governing policy; human review or authorization',
    'W': 'Language interpretation; structured-observation coverage; human review or authorization',
    'Y': 'Language interpretation; structured-observation coverage; human review or authorization',
    'Z': 'Language interpretation; structured-observation coverage; human review or authorization',
    'AD': 'Extraction or layout interpretation; language interpretation; governing policy; human review or authorization',
    'AE': 'Structured-observation coverage; language interpretation; human review or authorization',
    'AG': 'Structured-observation coverage; language interpretation; human review or authorization',
    'AH': 'Language interpretation; structured-observation coverage',
    'AI': 'Language interpretation; structured-observation coverage',
    'AJ': 'Language interpretation; structured-observation coverage',
    'AL': 'Structured-observation coverage; human review or authorization',
    'AM': 'Structured-observation coverage; human review or authorization',
    'AN': 'Structured-observation coverage; human review or authorization',
}


def export(store, destination):
    db = sqlite3.connect((store / 'audit.sqlite').resolve().as_uri() + '?mode=ro', uri=True)
    rows = db.execute("SELECT a.output FROM assessments a JOIN jobs j ON j.id=a.job WHERE j.rule='css-17-v1' AND j.year=2026 ORDER BY j.id DESC").fetchall()
    db.close()
    chosen = {}
    for row in rows:
        b = json.loads(row[0])
        key = b['input']['hospital_key']
        if not b['input']['synthetic'] and key in ('1002', '362') and key not in chosen:
            chosen[key] = b
    if set(chosen) != {'1002', '362'}:
        raise ValueError('Both completed Wave 1 jobs are required')
    entries = {}
    lines = ['# Wave 1 integrated assessment validation', '',
             'These are completed **software executions**, partial **evidence assessments**, and **unapproved** institutional results.', '',
             'Replay package: [`pilot-wave-one-evidence.zip`](pilot-wave-one-evidence.zip). It contains the existing grading input/report formats and all available original source snapshots. No new source or decision is invented.', '']
    lines += ['## Coverage compared with PR #88', '', '| Hospital | Before resolved / unclear | After resolved / unclear | Changed outcomes |', '|---|---:|---:|---|']
    for key, b in sorted(chosen.items()):
        unclear = len(b['report']['unresolved_measures'])
        before = '3 / 14'
        baseline_pass = {'R', 'S', 'T'}
        changes = [f"{f['css_column']}: {'yes' if f['css_column'] in baseline_pass else 'unclear'} → {f['result']}"
                   for f in b['report']['findings'] if f['result'] != ('yes' if f['css_column'] in baseline_pass else 'unclear')]
        lines.append(f'| {key} | {before} | {17-unclear} / {unclear} | ' + ('; '.join(changes) or 'None') + ' |')
    lines += ['', 'Source-specific coverage now includes all seven application languages and 42 drafts. See [application coverage](wave-one-application-coverage.md). Complete-scope and independent-review gates remain unchanged; no translation approval is inferred from numeric extraction. Earlier packages remain in git history; local prior assessments are append-only.', '']
    rubric = json.loads((ROOT / 'rubrics/css-17-v1.json').read_bytes())
    for key, b in sorted(chosen.items()):
        report, inp = b['report'], b['input']
        evidence_root = Path(b['root'])
        for source in inp['sources']:
            snapshot = source.get('snapshot')
            if not snapshot:
                continue
            path = (evidence_root / snapshot['artifact_path']).resolve()
            if not path.is_relative_to(evidence_root.resolve()):
                raise ValueError('Invalid snapshot path')
            raw = path.read_bytes()
            if hashlib.sha256(raw).hexdigest() != snapshot['sha256']:
                raise ValueError('Snapshot checksum mismatch')
            entries[snapshot['artifact_path']] = raw
        b['root'] = '.'  # The export is portable; absolute operator paths are not published.
        entries[f'assessments/{key}.json'] = (json.dumps(b, ensure_ascii=False, indent=2) + '\n').encode('utf-8')
        lines += [f'## Hospital {key}', '', f'- Revision: `{b["id"]}`', f'- Review date / reference year: {inp["review_date"]} / {inp["guideline_year"]}',
                  f'- Completed: {report["last_successful_assessment_at"]}; mode: {b["mode"]}. This is saved-evidence verification, not a new website capture.',
                  f'- 17 outcomes; {len(report["unresolved_measures"])} unresolved; human review **{report["human_review_status"]}**; institutional grade **{report["grade_status"]}**.', '',
                  '| Measure | Integrated outcome | Submitted bounded observation | Verified citations | Blocker categories | Coverage / next action |', '|---|---|---|---:|---|---|']
        for m, f in zip(rubric['measures'], report['findings']):
            action = f['reason'].replace('|', '\\|').replace('\n', ' ')
            # Full exact blockers and quotations remain in the existing report/input inside the archive.
            if len(action) > 260:
                action = action[:257] + '… (full blockers in report)'
            categories = BLOCKERS.get(m['css_column'], 'Source discovery; missing original evidence') if f['result'] == 'unclear' else 'Resolved posting evidence; institutional authorization still pending'
            if key == '362' and m['css_column'] == 'U':
                categories = 'Source discovery; structured-observation coverage (no verified conflict asserted)'
            if key == '1002' and m['css_column'] in ('W', 'Y', 'Z'):
                categories += '; missing original evidence (2021 policy)'
            lines.append(f'| {m["css_column"]} · {m["title"]} | {f["result"]} | {f["submitted_result"]} | {len(f["evidence"])} | {categories} | {action} |')
        lines += ['', '### Historical observation normalization', '']
        for n in b.get('normalization', []):
            reasons = [x['action'] for x in n.get('blockers', []) if x['code'] == 'invalid_or_missing_provenance'] + n.get('rejected', [])
            lines.append(f'- Producer `{n["producer_sha256"]}`: {len(n["accepted"])} reused observations. ' + ' '.join(reasons))
            if n.get('reference_binding'):
                binding = n['reference_binding']
                lines.append(f'  - Reference hash: producer `{binding["observed_sha256"]}`; current `{binding["expected_sha256"]}`. Compatibility: `{n.get("reference_compatibility", {}).get("reason", "not_verified")}`. No approval transfers.')
        lines += ['', '### New application observations', '']
        for review in b.get('application_reviews', []):
            lines.append(f'- {review["language"]}: {len(review["findings"])} source-specific drafts, {len(review["reviewed_segments"])} extracted segments, human review pending; `{review["snapshot"]["sha256"]}`.')
        for f in inp['findings']:
            if f['measure_id'] in ('application.fpl_guidelines', 'application.maximum_fpl', 'application.installments_cap'):
                lines.append(f'- `{f["measure_id"]}`: {len(f["observed"])} source-bound numeric observations; integrated `{next(r["result"] for r in report["findings"] if r["measure_id"] == f["measure_id"])}`.')
        lines += ['', '### Sources and language coverage', '', '| Role | Language | Coverage | Source / SHA-256 |', '|---|---|---|---|']
        for s in inp['sources']:
            digest = s['snapshot']['sha256'] if s.get('snapshot') else 'unavailable — no snapshot asserted'
            lines.append(f'| {s["role"]} | {s["language"]} | {s["status"]} | [{s["source_id"]}]({s["source_id"]}) · `{digest}` |')
        lines += ['', 'Where source evidence is available, findings retain exact quoted text and locator, source ID and snapshot hash. All findings retain expected values, review context and separate approval status; supported numeric observations retain their cells. Unavailable evidence stays explicitly unresolved rather than receiving a fabricated quotation. `producer_records` preserves the earlier draft labels and their evidence, even where the stricter integrated grader needs additional structured interpretation.', '']
    destination.mkdir(parents=True, exist_ok=True)
    with zipfile.ZipFile(destination / 'pilot-wave-one-evidence.zip', 'w', compression=zipfile.ZIP_DEFLATED) as archive:
        for name, data in sorted(entries.items()):
            info = zipfile.ZipInfo(name, (1980, 1, 1, 0, 0, 0))
            info.compress_type = zipfile.ZIP_DEFLATED
            archive.writestr(info, data)
    (destination / 'wave-one-pilot-results.md').write_text('\n'.join(lines) + '\n', encoding='utf-8', newline='\n')
    print(json.dumps(dict(hospitals=2, files=len(entries), snapshot_files=len(entries)-2, archive=str(destination / 'pilot-wave-one-evidence.zip'))))


if __name__ == '__main__':
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--store', type=Path, required=True)
    parser.add_argument('--out', type=Path, default=ROOT / 'docs/validation')
    args = parser.parse_args()
    export(args.store, args.out)
