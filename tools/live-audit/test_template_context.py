"""Synthetic provenance, auxiliary evidence and append-only draft regressions."""
import copy
import json
import tempfile
import unittest
from pathlib import Path
from unittest.mock import patch

from applications import review_application
from extraction import PARSER
from template_comparison import units, REFERENCE_URL
from template_context import attach_context
from test_applications import synthetic_source, REFERENCE_DATA, URL


class ContextTests(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.addCleanup(self.tmp.cleanup)
        self.root = Path(self.tmp.name)
        self.app = synthetic_source(2026)
        self.app['segments'][0]['text'] += '\nPrimary languages SYN definition.'
        self.ref = copy.deepcopy(self.app)
        self.ref['snapshot'].update(snapshot_id='b' * 64, sha256='b' * 64, url=REFERENCE_URL,
                                    artifact_path=f"snapshots/{'b' * 64}.docx")
        self.ref['segments'][0]['text'] = self.ref['segments'][0]['text'].replace('\nPrimary languages SYN definition.', '')
        self.ref['segments'][2]['text'] = self.ref['segments'][2]['text'].replace('$133,080', '$133,880')
        self.ref['segments'].append(dict(locator='DOCX word/footnotes.xml', status='extracted', text='Primary languages SYN definition.'))
        self.cid, self.eid = 'c' * 32, 'e' * 32
        self.packet = dict(comparison_id=self.cid, hospital_key='362', extraction_id=self.eid,
            extraction_parser=PARSER, snapshots=[self.app['snapshot'], self.ref['snapshot']],
            reference_capture_id='d' * 32, checked_at='2026-11-08T00:00:00Z', reference_version='NYS-2026-English',
            reference_url=REFERENCE_URL,
            application_evidence=units(self.app, 'application'), reference_evidence=units(self.ref, 'reference'))
        self.path = self.root / 'template-comparisons' / f'{self.cid}.json'
        self.store()

    def store(self):
        self.save(self.path, json.dumps(self.packet).encode())

    @staticmethod
    def save(path, data):
        path.parent.mkdir(parents=True, exist_ok=True)
        path.write_bytes(data)

    def attach(self):
        with patch('template_context.captured_reference', return_value=(self.ref, 'SYN capture')):
            return attach_context(self.cid, '362', self.eid, self.app, REFERENCE_DATA, self.root)[0]

    def test_auxiliary_correspondence_and_reference_numeric_error_have_exact_quotes(self):
        context = self.attach()
        observations = {o['kind']: o for o in context['observations']}
        self.assertIn('word/footnotes.xml', observations['formatting']['evidence'][-1]['locator'])
        discrepancy = observations['reference_discrepancy']
        self.assertIn('$133,880', discrepancy['explanation'])
        self.assertIn('hospital prints $133,080', discrepancy['explanation'])
        for observation in context['observations']:
            for evidence in observation['evidence']:
                self.assertIn(evidence, self.packet['application_evidence'] + self.packet['reference_evidence'])

    def test_stale_parser_cross_hospital_and_edited_quotes_rejected(self):
        original = copy.deepcopy(self.packet)
        for key, value in [('extraction_parser', 'document-text-v4'), ('hospital_key', '1002'), ('reference_version', 'SYN-unsupported'), ('reference_capture_id', None)]:
            self.packet = copy.deepcopy(original)
            self.packet[key] = value
            self.store()
            with self.assertRaises(ValueError):
                self.attach()
        self.packet = copy.deepcopy(original)
        self.packet['reference_evidence'][0]['quote'] = 'SYN fabricated quote'
        self.store()
        with self.assertRaisesRegex(ValueError, 'evidence'):
            self.attach()

    def test_new_context_preserves_old_draft_and_dollar_outcomes(self):
        with patch('applications.load_sources', return_value=([self.app], [])), patch('template_context.captured_reference', return_value=(self.ref, 'SYN capture')):
            old = review_application('362', self.eid, URL, '2026-11-08', self.root, self.save)
            before = Path(old['result_file']).read_bytes()
            new = review_application('362', self.eid, URL, '2026-11-08', self.root, self.save, template_comparison_id=self.cid)
            self.assertEqual(Path(old['result_file']).read_bytes(), before)
            stored = json.loads(Path(new['result_file']).read_text())
            self.assertIn('template_comparison', stored)
            self.assertEqual([f['result'] for f in new['findings']], [f['result'] for f in old['findings']])
            self.assertEqual(stored['human_review'], 'pending')
            with self.assertRaisesRegex(ValueError, '2026'):
                review_application('362', self.eid, URL, '2025-11-08', self.root, self.save, template_comparison_id=self.cid)
