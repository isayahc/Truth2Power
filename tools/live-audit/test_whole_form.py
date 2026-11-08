"""Synthetic visual-record provenance and append-only application integration checks."""
import copy
import hashlib
import tempfile
import unittest
from pathlib import Path
from unittest.mock import patch

from whole_form import attach_whole_form
from test_applications import synthetic_source


class WholeFormTests(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.addCleanup(self.tmp.cleanup)
        self.root = Path(self.tmp.name)
        self.source = synthetic_source(2026)
        raw = b'%PDF SYN visual artifact'
        self.digest = hashlib.sha256(raw).hexdigest()
        self.path = self.root / 'snapshots' / (self.digest + '.pdf')
        self.path.parent.mkdir()
        self.path.write_bytes(raw)
        render = dict(sha256=self.digest, pages=1, derived=True, engine='SYN renderer')
        self.spec = dict(review_id='SYN-v1', parser_version='document-text-v5', reviewed_at='2026-11-08', reviewer='SYN model',
            reference_sha256=self.source['snapshot']['sha256'], reference_render=render,
            authority={}, resolved_points=[], limitations='SYN test only', hospitals={'362': dict(
                source_sha256=self.source['snapshot']['sha256'], application_render=render,
                result='unclear', conclusion='SYN review completed; policy rule pending.', recommendation='SYN pending rule',
                questions=['SYN rubric owner: which rule applies?'], exceptions={},
                visual_sections=[dict(section='SYN page', reference_pages=[1], application_pages=[1], observation='SYN fields visible')])})
        self.result = dict(hospital_key='362', snapshots=[self.source['snapshot']], coverage=[],
            template_comparison=dict(observations=[], unresolved_questions=['old rendering question']),
            findings=[dict(measure_id='application.uniform_application', result='unclear', evidence=[]),
                      dict(measure_id='application.fpl_guidelines', result='yes', evidence=[])])

    def attach(self):
        with patch('whole_form.extract_bytes', return_value=[dict(locator='page 1', text='SYN visible page title', status='extracted')]):
            attach_whole_form(self.result, self.source, self.source, 'SYN-v1', self.root, self.spec)

    def test_visual_context_replaces_stale_question_without_promoting_or_changing_fpl(self):
        self.attach()
        context = self.result['template_comparison']
        self.assertEqual(context['whole_form_review']['human_review'], 'pending')
        self.assertEqual(context['unresolved_questions'], ['SYN rubric owner: which rule applies?'])
        self.assertEqual([f['result'] for f in self.result['findings']], ['unclear', 'yes'])
        self.assertEqual(len(context['whole_form_review']['content_coverage']), 27)
        self.assertEqual(self.result['findings'][0]['evidence'][0]['quote'], 'SYN visible page title')

    def test_tampered_render_and_wrong_original_rejected(self):
        self.path.write_bytes(b'SYN tamper')
        with self.assertRaisesRegex(ValueError, 'hash mismatch'):
            self.attach()
        self.spec['hospitals']['362']['source_sha256'] = '0' * 64
        with self.assertRaisesRegex(ValueError, 'snapshot'):
            self.attach()

    def test_missing_reference_content_or_unreviewed_pages_rejected(self):
        self.spec['hospitals']['362']['visual_sections'][0]['application_pages'] = [2]
        with self.assertRaisesRegex(ValueError, 'invalid rendered page'):
            self.attach()
        self.spec['hospitals']['362']['visual_sections'][0]['application_pages'] = [1]
        reference = copy.deepcopy(self.source)
        reference['segments'][0]['text'] += '\nSYN missing mandatory provision'
        with self.assertRaisesRegex(ValueError, 'unaccounted'):
            attach_whole_form(self.result, self.source, reference, 'SYN-v1', self.root, self.spec)

    def test_record_cannot_promote_to_approved_pass(self):
        self.spec['hospitals']['362']['result'] = 'yes'
        with self.assertRaisesRegex(ValueError, 'promote'):
            self.attach()
