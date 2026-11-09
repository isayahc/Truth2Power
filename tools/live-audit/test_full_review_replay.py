"""Real public-source replay and package-integrity checks for #64."""
import importlib.util
import json
from pathlib import Path
import tempfile
import unittest
import zipfile

ROOT = Path(__file__).resolve().parents[2]
spec = importlib.util.spec_from_file_location('full_review_export', ROOT / 'scripts/export-full-review.py')
export = importlib.util.module_from_spec(spec)
spec.loader.exec_module(export)


class FullReviewReplayTests(unittest.TestCase):
    def test_real_complete_review_replays_with_history_and_four_specific_gaps(self):
        report = export.replay_archive(ROOT / 'docs/validation/ellenville-full-review-evidence.zip')
        self.assertEqual(report, json.loads((ROOT / 'docs/validation/ellenville-full-review.json').read_bytes()))
        self.assertEqual(len(report['coverage']), 11)
        self.assertEqual(sum(c['total_pages'] for c in report['coverage']), 52)
        self.assertEqual(sum(c['source_review_revisions'] for c in report['coverage']), 22)
        self.assertEqual({c['language'] for c in report['coverage']}, {'English', 'Spanish', 'Polish', 'Ukrainian', 'Russian'})
        self.assertEqual([f['result'] for f in report['findings']], ['unclear'] * 4)
        self.assertEqual(report['human_review'], 'pending')
        self.assertTrue(report['original_results'])
        for finding in report['findings']:
            self.assertTrue(finding['unresolved_questions'])
            self.assertTrue(finding['evidence'])
            for citation in finding['evidence']:
                self.assertEqual(citation['sha256'], citation['snapshot_id'])
                self.assertTrue(citation['url'].startswith('https://'))
                self.assertTrue(citation['reviewed_at'])
        self.assertEqual([f['observed']['supportive'] for f in report['findings'][1:]], [6, 5, 8])

    def test_modified_package_and_missing_manifest_entry_rejected(self):
        original = ROOT / 'docs/validation/ellenville-full-review-evidence.zip'
        with tempfile.TemporaryDirectory() as tmp, zipfile.ZipFile(original) as archive:
            entries = {n: archive.read(n) for n in archive.namelist()}
            for mode in ('changed', 'missing'):
                target = Path(tmp) / (mode + '.zip')
                with zipfile.ZipFile(target, 'w') as modified:
                    for name, raw in entries.items():
                        if name.endswith('state.json'):
                            if mode == 'missing':
                                continue
                            raw += b' '
                        modified.writestr(name, raw)
                with self.assertRaises(ValueError):
                    export.replay_archive(target)

    def test_result_cannot_relabel_verified_snapshot_url(self):
        with tempfile.TemporaryDirectory() as tmp, zipfile.ZipFile(ROOT / 'docs/validation/ellenville-full-review-evidence.zip') as archive:
            archive.extractall(tmp)
            root = Path(tmp)
            path = root / export.BASE / 'results' / (export.RESULT + '.json')
            result = json.loads(path.read_bytes())
            result['snapshots'][0]['url'] = 'https://example.org/SYN-relabelled'
            path.write_text(json.dumps(result), encoding='utf-8')
            with self.assertRaisesRegex(ValueError, 'identity'):
                export.reproduce(root)
