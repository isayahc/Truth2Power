"""Contract and scope regressions for public #24 evidence; no network calls."""
import copy
import json
import unittest
from pathlib import Path
from unittest.mock import patch

from verify_summaries import ROOT, verify


class SummaryTests(unittest.TestCase):
    def setUp(self):
        directory = ROOT / 'docs/audit-format/summaries'
        self.review = json.loads((directory / 'review.json').read_bytes())
        self.envelope = json.loads((directory / '362.json').read_bytes())

    def test_committed_results_have_both_languages_and_three_measures(self):
        self.assertEqual(verify(self.envelope, self.review)['reviewed_pages'], 3)
        self.assertEqual([f['result'] for f in self.envelope['assessment']['findings']], ['no', 'yes', 'yes'])
        ellenville = json.loads((ROOT / 'docs/audit-format/summaries/1002.json').read_bytes())
        self.assertEqual(verify(ellenville, self.review)['reviewed_pages'], 4)
        self.assertEqual([f['result'] for f in ellenville['assessment']['findings']], ['yes'] * 3)

    def test_policy_substitution_and_omitted_language_rejected(self):
        wrong = copy.deepcopy(self.envelope)
        wrong['snapshots'][0]['document_type'] = 'policy_statement'
        with self.assertRaisesRegex(ValueError, 'designated summary'):
            verify(wrong, self.review)
        self.envelope['assessment']['findings'][0]['evidence'].pop()
        with self.assertRaisesRegex(ValueError, 'every reviewed language'):
            verify(self.envelope, self.review)

    def test_complete_visual_review_required_for_absence(self):
        self.review['hospitals']['362']['documents'][0]['visual_review_complete'] = False
        with self.assertRaisesRegex(ValueError, 'visual coverage'):
            verify(self.envelope, self.review)

    def test_original_page_and_quote_mismatch_rejected(self):
        # Synthetic extractor response isolates the validator from the real PDFs.
        with patch('verify_summaries.verified_snapshot', return_value=({}, b'%PDF SYN fixture')), \
             patch('verify_summaries.extract_bytes', return_value=[dict(locator='page 1', text='SYN different document', status='extracted')]):
            with self.assertRaisesRegex(ValueError, 'Quote does not match'):
                verify(self.envelope, self.review, Path('SYN-root'))
        with patch('verify_summaries.verified_snapshot', return_value=({}, b'%PDF SYN fixture')), \
             patch('verify_summaries.extract_bytes', return_value=[]):
            with self.assertRaisesRegex(ValueError, 'every source page'):
                verify(self.envelope, self.review, Path('SYN-root'))
