"""Verify #25 descriptive PSA quotes against saved bytes; never compute a grade."""
import json
from pathlib import Path

from extraction import extract_bytes
from posting import verified_snapshot

ROOT = Path(__file__).resolve().parents[2]


def verify(root):
    context = json.loads((ROOT / 'references/wave-one-reporting-context-v1.json').read_bytes())
    count = 0
    for key, hospital in context['hospitals'].items():
        records = json.loads((ROOT / f'docs/audit-format/posting/collections/{key}.json').read_bytes())['documents']
        for statement in hospital['statements']:
            citation = statement['evidence']
            record = next(r for r in records if r.get('sha256') == citation['sha256'] and r['url'] == citation['url'])
            _, raw = verified_snapshot(root, record, statement['document_type'])
            text = {p['locator']: p['text'] for p in extract_bytes(raw, '.pdf') if p['status'] == 'extracted'}
            if citation['quote'] not in text[citation['locator']]:
                raise ValueError('PSA citation does not match original page')
            reported = statement['reported_counties'] if statement['geography_type'] == 'counties' else statement['reported_places']
            if not all(name in citation['quote'] for name in reported):
                raise ValueError('Reported geography not present in cited text')
            if statement['geography_type'] != 'counties' and statement['reported_counties'] is not None:
                raise ValueError('Localities must not become inferred counties')
            count += 1
    return dict(hospitals=len(context['hospitals']), verified_psa_citations=count, grades_computed=0)


if __name__ == '__main__':
    import argparse
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--root', type=Path, required=True)
    args = parser.parse_args()
    print(json.dumps(verify(args.root), indent=2))
