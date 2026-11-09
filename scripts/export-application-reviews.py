"""Reproduce seven source-specific reviews from immutable offline evidence (no model/network)."""
import argparse
import hashlib
import json
from pathlib import Path
import sys
import zipfile

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT / 'tools/live-audit'))
from applications import evaluate, REFERENCE
from extraction import extract_bytes, layout_inventory
from template_comparison import component_review, align, attach_application_context, translated_visual_context


def package(root, destination):
    spec = json.loads((ROOT / 'references/whole-form-wave-one-v1.json').read_bytes())
    paths = [root / 'reference-captures/9d1674693c5249fa854b159cf2010f3a.json']
    hashes = [spec['reference_sha256'], spec['reference_render']['sha256']]
    for hospital in spec['hospitals'].values():
        render = hospital.get('application_render', {})
        if render.get('sha256'):
            hashes.append(render['sha256'])
    for digest in hashes:
        paths += list((root / 'snapshots').glob(digest + '.*'))
    for folder in ('application-reviews', 'template-comparisons', 'review-inbox-decisions'):
        paths += list((root / folder).rglob('*.json'))
    with zipfile.ZipFile(destination, 'w', zipfile.ZIP_DEFLATED) as archive:
        for path in sorted(set(paths)):
            info = zipfile.ZipInfo(path.relative_to(root).as_posix(), (2026, 11, 9, 0, 0, 0))
            archive.writestr(info, path.read_bytes(), compress_type=zipfile.ZIP_DEFLATED)


def build(pilot, reference_package):
    reference = json.loads(REFERENCE.read_bytes())
    with zipfile.ZipFile(reference_package) as archive:
        capture = json.loads(archive.read('reference-captures/9d1674693c5249fa854b159cf2010f3a.json'))
        raw = archive.read(capture['snapshot']['artifact_path'])
        if hashlib.sha256(raw).hexdigest() != capture['snapshot']['sha256'] or capture['snapshot']['sha256'] != '558cb8933ccabf12a6b86acea145f1077cebd4c9e71fc108bacf2d07f333811a':
            raise ValueError('Official reference checksum mismatch')
        official = extract_bytes(raw, '.docx')
        history = [dict(path=n, sha256=hashlib.sha256(archive.read(n)).hexdigest(), artifact=json.loads(archive.read(n)))
                   for n in archive.namelist() if n.startswith('application-reviews/') and '/results/' in n]
    spec = json.loads((ROOT / 'references/whole-form-wave-one-v1.json').read_bytes())
    inventory = json.loads((ROOT / 'docs/audit-format/wave-one-document-inventory.json').read_bytes())
    reviews = []
    with zipfile.ZipFile(pilot) as archive:
        for hospital in ('1002', '362'):
            bundle = json.loads(archive.read('assessments/' + hospital + '.json'))
            for source in bundle['input']['sources']:
                if source['role'] != 'application':
                    continue
                snapshot = source['snapshot']
                data = archive.read(snapshot['artifact_path'])
                if hashlib.sha256(data).hexdigest() != snapshot['sha256']:
                    raise ValueError('Application checksum mismatch')
                segments = extract_bytes(data, Path(snapshot['artifact_path']).suffix)
                findings, status = evaluate(dict(snapshot=snapshot, segments=segments), '2026-11-09', reference, source['language'])
                comparison = component_review(segments, official, source['language'])
                english = spec['hospitals'].get(hospital)
                visual = english if english['source_sha256'] == snapshot['sha256'] else None
                comparison['preserved_english_visual_review'] = visual
                comparison['translated_visual_review'] = translated_visual_context(dict(snapshot=snapshot, segments=segments), hospital, source['language'])
                attach_application_context(findings, comparison)
                comparison['line_alignment'] = align(dict(snapshot=capture['snapshot'], segments=official), dict(snapshot=snapshot, segments=segments)) if source['language'] == 'en' else None
                comparison['differences'] = [dict(category='substantive_numeric_change' if hospital == '1002' else 'reference_arithmetic_correction',
                    detail='2024 table, rows 1–7; compare printed cells against 2026 HHS.' if hospital == '1002' else
                    'Six-person 300%: hospital $133,080; official $133,880; HHS arithmetic $133,080. Do not penalize the correction.'),
                    dict(category='customization_rule_unresolved', detail='AD/AH scoring overlap.' if hospital == '1002' else 'Campus list, MRN field, eighth household row and corrected arithmetic.'),
                    dict(category='formatting_not_equivalence', detail='Pagination and structural anchors cannot establish translated semantic equivalence. English visual findings preserved where hash-bound.')]
                reviews.append(dict(hospital_key=hospital, source_id=source['source_id'], language=source['language'], role='application',
                    applicability=[d for h in inventory['hospitals'] if h['hospital_key'] == hospital for d in h['documents'] if d.get('sha256') == snapshot['sha256'] and d.get('status') == 'content_confirmed'],
                    snapshot=snapshot, status=status, review_date='2026-11-09', human_review='pending',
                    reference_sha256=hashlib.sha256(REFERENCE.read_bytes()).hexdigest(),
                    extraction=segments, layout=layout_inventory(data, Path(snapshot['artifact_path']).suffix), findings=findings, template_comparison=comparison,
                    historical_records=[dict(path=h['path'], sha256=h['sha256'], result_id=h['artifact']['result_id'],
                        reference_sha256=h['artifact']['reference_sha256'], review_date=h['artifact'].get('review_date'),
                        human_review=h['artifact'].get('human_review'),
                        results={f['measure_id']: f['result'] for f in h['artifact']['findings']})
                        for h in history if any(s['sha256'] == snapshot['sha256'] for s in h['artifact']['snapshots'])]))
    return dict(version='wave-one-application-coverage-v1', reference=capture, reviews=reviews,
                limitations=['Source-language model-assisted pattern design is not certified translation.',
                             'Qualitative drafts and structural presence do not establish whole-form equivalence or human approval.'])


def markdown(report):
    lines = ['# Wave 1 source-specific application coverage', '',
             'Reproduce with `python scripts/export-application-reviews.py`. Inputs: the portable pilot ZIP and `application-reference-evidence.zip`. No network or model calls.', '',
             'These are 42 source-specific drafts, not 42 approved findings. Original-language quotations, linked income/discount rows, exact source locators, extraction metadata, historical records and reference citations are in `wave-one-application-reviews.json`.', '',
             '| Hospital | Language | Segments | AD | AE | AG | AH | AI | AJ |', '|---|---|---:|---|---|---|---|---|---|']
    for r in report['reviews']:
        lines.append('| ' + ' | '.join([r['hospital_key'], r['language'], str(len(r['extraction']))] + [f['result'] for f in r['findings']]) + ' |')
    lines += ['', '## Immutable source identities', '']
    for r in report['reviews']:
        lines += [f"- **{r['hospital_key']} / {r['language']}**: {r['source_id']}",
                  f"  - SHA-256 `{r['snapshot']['sha256']}`; retrieved {r['snapshot']['retrieved_at']}; publisher date {r['snapshot'].get('publisher_updated_at') or 'unknown'}.",
                  f"  - {len(r['historical_records'])} preserved historical application records; campus/role classification retained from the exact-byte inventory."]
    lines += ['', '## Findings and remaining decisions', '',
              '- Ellenville: all five forms print 2024 income tables (21 linked cells each), including $60,240 for one person at 400%. AH is no for each document against 2026 HHS; household size 8 is not printed. AD remains unclear pending the AD/AH overlap rule.',
              '- Little Falls: both forms print 2026 rows 1–8 (24 cells each). The six-person 300% cell is $133,080, consistent with HHS arithmetic; the official English form prints $133,880. Neither reference is rewritten.',
              '- All seven documents have source-specific assistance contacts, income/discount bands, explicit eligibility through 400%, and a 5% gross-monthly-income installment statement. The separate 2% interest limit is not used as the installment cap.',
              '- English whole-form visual reviews from #78 remain hash-bound and preserved, including all 80 reference units and Little Falls drawings. English rendering is not a pending blocker.',
              '- Translated comparisons cover eleven sections and ten fields using original-language anchors. A missing anchor means not established, not absent. These checks do not establish every translated field or declaration as semantically equivalent to an authoritative translated template. DOCX table/cell/grid/section inventories and PDF page dimensions are preserved alongside extraction.',
              '- PDF extraction retains actual page locators (Ellenville en/es/pl/uk/ru: 5/6/6/6/7 pages). Little Falls DOCX body is one structural segment per language; rendered pagination remains unverified for Spanish. Drawing metadata is retained; English visual conclusions are not transferred to Spanish.',
              '- All 25 original translated Ellenville PDF pages have hash-bound model visual review: writable fields, checkbox pairs, signatures and table continuations are visible, with no observed clipping. Exact source quotations retain semantic questions about Spanish expired insurance, Polish eligibility/income wording, Ukrainian language-footnote/immigration wording, and Russian collection timing/proof wording. These are not certified translations or human approvals. Little Falls Spanish DOCX visual layout remains unverified.',
              '- Little Falls campus/MRN additions, eighth row and corrected official arithmetic require a cited customization rule. Formatting alone does not produce noncompliance.',
              '- AE/AG are qualitative source-specific presence drafts. Existing independent-review and complete-scope gates remain in force in the integrated grader. AD and all institutional grades remain pending.', '',
              '## Reference compatibility', '',
              'Historical HHS SHA-256 `ca97094c4f6c7a4336428e615cfec96d2951a7b4e7d5e92f6bc0def81c1d141d` is reconstructed exactly by CRLF serialization of the current reference. LF SHA-256 is `a5d7f1a25efdc18e4b1907dde8a5923bd249276b1a521a975f0a966e0a481973`. Parsed content is identical. The classifier accepts only these reconstructed representations with matching embedded content/version; arbitrary reserialization, substantive changes and missing non-current embedded references are rejected. Original hashes and decisions remain unchanged; no approval transfers.', '']
    return '\n'.join(lines)


if __name__ == '__main__':
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--capture-root', type=Path)
    args = parser.parse_args()
    folder = ROOT / 'docs/validation'
    reference_package = folder / 'application-reference-evidence.zip'
    if args.capture_root:
        package(args.capture_root, reference_package)
    report = build(folder / 'pilot-wave-one-evidence.zip', reference_package)
    (folder / 'wave-one-application-reviews.json').write_text(json.dumps(report, ensure_ascii=False, indent=2) + '\n', encoding='utf-8', newline='\n')
    (folder / 'wave-one-application-coverage.md').write_text(markdown(report), encoding='utf-8', newline='\n')
    print(json.dumps({'applications': len(report['reviews']), 'findings': sum(len(r['findings']) for r in report['reviews'])}))
