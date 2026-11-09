"""Offline source-specific regression tests; no translations, models or live requests."""
import copy
import hashlib
import json
from pathlib import Path
import unittest
import zipfile
from applications import evaluate, REFERENCE
from extraction import extract_bytes, layout_inventory
from language_profiles import parse_profile, discount_rows
from template_comparison import application_template_context, offline_template, translated_visual_context

ROOT = Path(__file__).resolve().parents[2]


class MultilingualApplications(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.sources = {}
        cls.reference = json.loads(REFERENCE.read_bytes())
        with zipfile.ZipFile(ROOT / 'docs/validation/pilot-wave-one-evidence.zip') as archive:
            for key in ('1002', '362'):
                bundle = json.loads(archive.read('assessments/' + key + '.json'))
                for source in bundle['input']['sources']:
                    if source['role'] == 'application':
                        snapshot = source['snapshot']
                        raw = archive.read(snapshot['artifact_path'])
                        assert hashlib.sha256(raw).hexdigest() == snapshot['sha256']
                        cls.sources[(key, source['language'])] = dict(snapshot=snapshot, segments=extract_bytes(raw, Path(snapshot['artifact_path']).suffix))

    def test_all_seven_six_measures_original_language_and_linked_cells(self):
        self.assertEqual(len(self.sources), 7)
        for (key, language), source in self.sources.items():
            with self.subTest(key=key, language=language):
                findings, status = evaluate(source, '2026-11-09', self.reference, language)
                self.assertEqual(status, 'reviewed')
                self.assertEqual([f['result'] for f in findings], ['unclear', 'yes', 'yes', 'no' if key == '1002' else 'yes', 'yes', 'yes'])
                for finding in findings:
                    for citation in finding['evidence']:
                        self.assertTrue(any(p['locator'] == citation['locator'] and citation['quote'] in p['text'] for p in source['segments']))
                fpl = findings[3]['observed']
                self.assertEqual(len(fpl['cells']), 21 if key == '1002' else 24)
                self.assertEqual(fpl['published_year'], 2024 if key == '1002' else 2026)
                self.assertEqual(len(findings[2]['observed']['discount_rows']), 3)

    def test_mutated_amount_year_duplicate_row_and_language_do_not_pass(self):
        source = copy.deepcopy(self.sources[('362', 'es')])
        original = source['segments'][0]['text']
        source['segments'][0]['text'] = original.replace('$133,080', '$133,880')
        self.assertEqual(evaluate(source, '2026-11-09', self.reference, 'es')[0][3]['result'], 'no')
        source['segments'][0]['text'] = original.replace('(2026)', '(2025)')
        self.assertEqual(evaluate(source, '2026-11-09', self.reference, 'es')[0][3]['result'], 'no')
        duplicate = original.replace('8 personas', '7 personas')
        self.assertIsNone(parse_profile('fpl', duplicate, 'es'))
        self.assertIsNone(parse_profile('fpl', original, 'pl'))
        self.assertTrue(all(f['result'] == 'unclear' for f in evaluate(source, '2026-11-09', self.reference, 'zz')[0]))

    def test_ambiguous_maximum_installments_contacts_and_discount_band(self):
        source = copy.deepcopy(self.sources[('362', 'es')])
        original = source['segments'][0]['text']
        source['segments'][0]['text'] = original.replace('no pueden exceder', 'pueden exceder').replace('son elegibles para recibir', 'podrían ser elegibles para recibir')
        findings = evaluate(source, '2026-11-09', self.reference, 'es')[0]
        self.assertEqual([f['result'] for f in findings[-2:]], ['unclear', 'unclear'])
        source['segments'][0]['text'] = original.replace('607-547-3093', '___').replace('301 % - 400 %', '401 % - 500 %')
        findings = evaluate(source, '2026-11-09', self.reference, 'es')[0]
        self.assertEqual(findings[1]['result'], 'unclear')
        self.assertEqual(findings[2]['result'], 'unclear')

    def test_unreadable_source_and_missing_field_remain_unknown(self):
        source = copy.deepcopy(self.sources[('1002', 'pl')])
        source['segments'][0]['status'] = 'unreadable'
        self.assertTrue(all(f['result'] == 'unclear' for f in evaluate(source, '2026-11-09', self.reference, 'pl')[0]))
        source = copy.deepcopy(self.sources[('362', 'es')])
        source['segments'][0]['text'] = source['segments'][0]['text'].replace('Firma', 'SYN removed field')
        comparison = application_template_context(source, '362', 'es')
        self.assertEqual(next(c for c in comparison['components'] if c['component'] == 'signature')['status'], 'not_established')
        self.assertEqual(comparison['result'], 'unclear')

    def test_official_typo_render_binding_and_spanish_drawings_preserved(self):
        official, spec = offline_template()
        self.assertIn('133,880', ' '.join(p['text'] for p in official['segments']))
        for (key, language), source in self.sources.items():
            context = application_template_context(source, key, language)
            self.assertEqual(context['result'], 'unclear')
            self.assertEqual(context['customization_rule'], 'unresolved')
            self.assertEqual(bool(context['preserved_english_visual_review']), language == 'en')
            if key == '362':
                self.assertTrue(source['segments'][0]['locator'].endswith('pagination unverified)'))
                self.assertEqual(context['drawings'], [d for p in source['segments'] for d in p.get('drawings', [])])

    def test_docx_structural_cells_keep_households_and_original_spanish(self):
        with zipfile.ZipFile(ROOT / 'docs/validation/pilot-wave-one-evidence.zip') as archive:
            snapshot = self.sources[('362', 'es')]['snapshot']
            layout = layout_inventory(archive.read(snapshot['artifact_path']), '.docx')
        self.assertEqual(layout['pagination'], 'unverified')
        self.assertTrue(layout['section_properties'])
        rows = [row for t in layout['tables'] for row in t['rows']]
        row = next(r for r in rows if any('6 personas' in ' '.join(c['text'].split()) for c in r))
        self.assertTrue(any('$133,080' in c['text'] for c in row))
        self.assertTrue(all('word/document.xml table' in c['locator'] for c in row))

    def test_visual_binding_requires_hash_complete_pages_and_exact_quotes(self):
        for language in ('es', 'pl', 'uk', 'ru'):
            source = copy.deepcopy(self.sources[('1002', language)])
            review = translated_visual_context(source, '1002', language)
            self.assertEqual(review['human_review'], 'pending')
            self.assertEqual(review['result'], 'unclear')
            changed = copy.deepcopy(source)
            changed['snapshot']['sha256'] = '0' * 64
            self.assertIsNone(translated_visual_context(changed, '1002', language))
            self.assertIsNone(translated_visual_context(source, '362', language))
            changed = copy.deepcopy(source)
            changed['segments'].pop()
            with self.assertRaises(ValueError):
                translated_visual_context(changed, '1002', language)
            question = review['source']['questions'][0]
            for page in source['segments']:
                if page['locator'] == question['locator']:
                    page['text'] = page['text'].replace(question['quote'], 'SYN removed quote')
            with self.assertRaises(ValueError):
                translated_visual_context(source, '1002', language)


if __name__ == '__main__':
    unittest.main()
