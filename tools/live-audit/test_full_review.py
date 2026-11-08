"""Synthetic full-review coverage, interpretation and provenance regressions."""
import copy
import json
import tempfile
import unittest
from pathlib import Path
from unittest.mock import patch

from full_review import (MEASURES, aggregate, begin, finalize, read_source,
                         record_human_decision, state_load, submit)
from test_cross_documents import SOURCES


class FullReviewTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.addCleanup(self.temp.cleanup)
        self.output = Path(self.temp.name)
        self.sources = copy.deepcopy(SOURCES)
        self.mock = patch('full_review.load_sources', return_value=(self.sources, []))
        self.loader = self.mock.start()
        self.addCleanup(self.mock.stop)
        self.rid = begin('1002', 'b' * 32, self.output, self.save)['review_id']

    def save(self, path, data):
        path.parent.mkdir(parents=True, exist_ok=True)
        path.write_bytes(data)

    def review(self):
        read_source(self.rid, 's1', 1, self.output, self.save)
        return dict(status='reviewed', language='English', reviewed_pages=['s1-p1'],
                    notes='Synthetic model review; no human approval.',
                    observations=[dict(measure_id=m, position='supports',
                        context='application_submission' if m.endswith('no_submission_time_limit') else 'eligibility',
                        explanation='Synthetic favorable observation.', evidence_ids=['s1-p1-e1']) for m in MEASURES])

    def finish(self, review):
        submit(self.rid, 's1', review, self.output, self.save)
        result = finalize(self.rid, self.output, self.save)
        return json.loads(Path(result['result_file']).read_text()), Path(result['result_file'])

    def test_delivery_is_not_review(self):
        self.review()
        findings, _, gaps = aggregate(state_load(self.output, self.rid))
        self.assertTrue(gaps)
        self.assertEqual({f['result'] for f in findings}, {'unclear'})

    def test_complete_support_and_separate_human_decisions(self):
        result, path = self.finish(self.review())
        self.assertEqual({f['result'] for f in result['findings']}, {'yes'})
        original = path.read_bytes()
        first = record_human_decision(path, 'needs_changes', 'synthetic-reviewer', 'SYN test', self.output, self.save)
        second = record_human_decision(path, 'reject', 'synthetic-reviewer', 'SYN revision', self.output, self.save)
        self.assertNotEqual(first, second)
        self.assertTrue(first.exists())
        self.assertEqual(original, path.read_bytes())
        self.assertEqual(result['human_review'], 'pending')

    def test_missing_language_or_unavailable_source_blocks_pass(self):
        review = self.review()
        review.update(status='translation_needed', language='Polish', observations=[])
        result, _ = self.finish(review)
        self.assertEqual(result['gaps'][0]['reason'], 'translation_needed')
        self.assertEqual({f['result'] for f in result['findings']}, {'unclear'})
        self.loader.return_value = (self.sources, [dict(url='https://example.org/missing.pdf', reason='http_404')])
        result, _ = self.finish(self.review())
        self.assertEqual({f['result'] for f in result['findings']}, {'unclear'})

    def test_incomplete_review_and_invented_evidence_rejected(self):
        review = self.review()
        for change in ({'reviewed_pages': []}, {'observations': []}):
            invalid = dict(review, **change)
            with self.assertRaises(ValueError):
                submit(self.rid, 's1', invalid, self.output, self.save)
        review['observations'][0]['evidence_ids'] = ['invented']
        with self.assertRaises(ValueError):
            submit(self.rid, 's1', review, self.output, self.save)

    def test_unrelated_requires_evidence(self):
        review = self.review()
        review.update(status='unrelated', observations=[])
        with self.assertRaises(ValueError):
            submit(self.rid, 's1', review, self.output, self.save)
        review['scope_evidence_ids'] = ['s1-p1-e1']
        result, _ = self.finish(review)
        self.assertEqual(result['coverage'][0]['status'], 'unrelated')
        self.assertTrue(result['coverage'][0]['scope_evidence'])

    def test_deadline_context_and_conflicts(self):
        review = self.review()
        review['observations'][0].update(position='restricts', context='collection_wait')
        result, _ = self.finish(review)
        self.assertEqual(result['findings'][0]['result'], 'unclear')
        review = self.review()
        contrary = dict(review['observations'][1], position='restricts')
        review['observations'].append(contrary)
        result, _ = self.finish(review)
        self.assertEqual(result['findings'][1]['reason_code'], 'conflicting_evidence')
        review['observations'].pop(1)
        result, _ = self.finish(review)
        self.assertEqual(result['findings'][1]['result'], 'no')
        self.assertEqual(result['coverage'][0]['source_review_revisions'], 3)

    def test_snapshot_mutation_rejected(self):
        review = self.review()
        self.sources[0]['segments'][0]['text'] = 'SYN altered snapshot'
        with self.assertRaisesRegex(ValueError, 'original snapshot'):
            self.finish(review)

    def test_income_documentation_is_neutral_and_other_context_is_ambiguous(self):
        review = self.review()
        review['observations'][1].update(position='restricts', context='income_documentation')
        review['observations'][2].update(context='other')
        result, _ = self.finish(review)
        self.assertEqual(result['findings'][1]['observed']['restrictive'], 0)
        self.assertEqual(result['findings'][2]['result'], 'unclear')
        self.assertEqual(result['findings'][2]['observed']['ambiguous'], 1)
        self.assertEqual(len(result['source_reviews']), 1)

    def test_unreadable_extraction_cannot_be_reviewed(self):
        self.sources[0]['segments'][0]['status'] = 'unreadable'
        self.rid = begin('1002', 'b' * 32, self.output, self.save)['review_id']
        with self.assertRaisesRegex(ValueError, 'extraction gaps'):
            self.finish(self.review())

    def test_all_pagination_pages_required(self):
        self.sources[0]['segments'][0]['text'] *= 10
        self.sources[0]['segments'] *= 80
        self.rid = begin('1002', 'b' * 32, self.output, self.save)['review_id']
        batch = read_source(self.rid, 's1', 1, self.output, self.save)
        self.assertIsNotNone(batch['next_page'])
        review = self.review()
        review['reviewed_pages'] = [f's1-p{i}' for i in range(1, 81)]
        with self.assertRaisesRegex(ValueError, 'not been delivered'):
            submit(self.rid, 's1', review, self.output, self.save)
        while batch['next_page'] is not None:
            batch = read_source(self.rid, 's1', batch['next_page'], self.output, self.save)
        result, _ = self.finish(review)
        self.assertEqual(len(result['coverage'][0]['reviewed_pages']), 80)


if __name__ == '__main__':
    unittest.main()
