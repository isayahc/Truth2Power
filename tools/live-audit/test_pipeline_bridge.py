"""Offline synthetic regression for the worker's existing-extractor bridge."""
import hashlib
import tempfile
import unittest
from unittest.mock import patch
from pathlib import Path
from pipeline_bridge import run, save


class PipelineBridgeTest(unittest.TestCase):
    def test_interrupted_publication_never_exposes_partial_final_bytes(self):
        with tempfile.TemporaryDirectory() as directory:
            target = Path(directory) / 'snapshots/SYN.html'
            with patch('pipeline_bridge.os.link', side_effect=OSError('SYN interrupted publication')):
                with self.assertRaises(OSError):
                    save(target, b'SYN complete bytes')
            self.assertFalse(target.exists())
            self.assertEqual(list(target.parent.glob('*.tmp')), [])
            save(target, b'SYN complete bytes')
            self.assertEqual(target.read_bytes(), b'SYN complete bytes')

    def test_multilingual_original_bytes_and_links_are_preserved(self):
        from collections import Counter
        from usage import usage
        counters = Counter()
        self.addCleanup(usage.reset, usage.set(counters))
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            raw = '<html><p>SYN Asistencia financiera para todos — Українська мова.</p><a href="application.pdf">SYN application</a></html>'.encode('utf-8')
            digest = hashlib.sha256(raw).hexdigest()
            path = f'snapshots/{digest}.html'
            save(root / path, raw)
            source = dict(source_id='https://example.org/SYN/aid', snapshot=dict(artifact_path=path, sha256=digest))
            result = run(root, dict(mode='extract', sources=[source]))[source['source_id']]
            self.assertIn('Українська', result[0]['text'])
            self.assertEqual(result[-1]['locator'], 'link https://example.org/SYN/application.pdf')
            self.assertEqual(result[-1]['text'], 'SYN application')
            save(root / path, raw)
            self.assertEqual(counters, dict(artifacts_written=1, storage_bytes=len(raw), html_parsed=1, artifact_reuses=1))
            with self.assertRaisesRegex(ValueError, 'immutable'):
                save(root / path, b'SYN changed')
            (root / path).write_bytes(b'SYN corruption')
            with self.assertRaisesRegex(ValueError, 'hash_mismatch'):
                run(root, dict(mode='extract', sources=[source]))

    def test_empty_inventory_stays_empty_and_traversal_is_rejected(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory) / 'SYN-root'
            root.mkdir()
            self.assertEqual(run(root, dict(mode='extract', sources=[])), {})
            source = dict(source_id='https://example.org/SYN', snapshot=dict(artifact_path='../outside.html', sha256='0' * 64))
            with self.assertRaisesRegex(ValueError, 'invalid_snapshot'):
                run(root, dict(mode='extract', sources=[source]))


if __name__ == '__main__':
    unittest.main()
