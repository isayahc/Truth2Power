"""Offline synthetic regression for the worker's existing-extractor bridge."""
import hashlib
import json
from collections import Counter
from threading import Event
from typing import Callable
import tempfile
import unittest
from unittest.mock import patch
from pathlib import Path
from documents import collect
from evidence_workers import review_source
from extraction import prepared_path
from pipeline_bridge import run, save
from test_extraction import text_pdf
from usage import usage


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

    def test_capture_starts_review_during_download_and_reuses_authenticated_text(self) -> None:
        """Exercise live collection, both reviewer batches, aliases, meter and receipt integrity."""
        meters = Counter()
        self.addCleanup(usage.reset, usage.set(meters))
        page_review_started = Event()
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            landing = "https://example.org/aid"
            pdf = text_pdf()
            html = b'<p>SYN financial assistance information for residents</p><a href="/a.pdf">A</a><a href="/b.pdf">B</a>'
            save(root / "data/maps/hospitals.geojson", json.dumps({"features": [
                {"id":"362", "properties":{"assistance_url":landing}}]}).encode())

            def transport(url: str, host: str) -> tuple[bytes, str, str]:
                """A PDF may finish only after the independent page reviewer has started."""
                if url == landing:
                    return html, url, "text/html"
                if not page_review_started.wait(5):
                    raise TimeoutError("page review did not start during download")
                return pdf, url, "application/pdf"

            def local_collect(key: str, _repo: Path, output: Path, write: Callable, **kwargs) -> dict:
                """Use real traversal and fixture transport against local synthetic bytes."""
                return collect(key, root, output, write, fetch=transport, **kwargs)

            def review(source: dict, segments: list[dict], website: bool) -> dict:
                """Observe the first page review without changing any audit decisions."""
                if website:
                    page_review_started.set()
                return review_source(source, segments, website)

            with patch("pipeline_bridge.collect", side_effect=local_collect), patch("pipeline_bridge.review_source", side_effect=review):
                live = run(root, {"mode":"live", "hospital_key":"362"})
            self.assertEqual(live["collection"]["status"], "complete")
            receipts = live["prepared_extractions"]
            self.assertEqual(len(receipts), 2)
            self.assertEqual((meters["pdf_parsed"], meters["html_parsed"]), (1, 1))
            manifest = json.loads((root / live["extraction_manifest"]).read_bytes())
            for doc in manifest["documents"]:
                text = json.loads((root / doc["text_path"]).read_bytes())
                self.assertEqual(text["source_url"], doc["source_url"])
            sources = [dict(source_id=rec["source_url"], role=role, hospital_key="362", snapshot=rec)
                       for rec, role in [(live["collection"]["landing_page"], "landing_page"),
                                         *[(d, "unclassified") for d in live["collection"]["documents"]]]]
            request = dict(mode="extract", sources=sources, prepared_extractions=receipts, application_review_date="2026-11-11")
            with patch("pipeline_bridge.extract_bytes", side_effect=AssertionError("parsed an original twice")), \
                    patch("pipeline_bridge.review_source", side_effect=AssertionError("reviewed an unchanged source twice")):
                reviewed = run(root, request)["reviews"]
            for doc in sources[1:]:
                entry = reviewed[doc["source_id"]]
                self.assertEqual(entry["source_id"], doc["source_id"])
                self.assertEqual(entry["sample_passages"][0]["locator"], "page 1")
                self.assertIn("SYN-001", entry["sample_passages"][0]["quote"])
            self.assertEqual((meters["pdf_parsed"], meters["html_parsed"]), (1, 1))
            path = sources[1]["snapshot"]["artifact_path"]
            original_receipt = receipts[path]
            receipts[path] = receipts[sources[0]["snapshot"]["artifact_path"]]
            with self.assertRaisesRegex(ValueError, "receipt_identity_mismatch"):
                run(root, request)
            receipts[path] = original_receipt
            prepared_path(root, original_receipt).write_bytes(b"SYN altered derived output")
            with self.assertRaisesRegex(ValueError, "receipt_hash_mismatch"):
                run(root, request)
            (root / path).write_bytes(b"SYN altered original")
            with self.assertRaisesRegex(ValueError, "snapshot_hash_mismatch"):
                run(root, request)

    def test_replay_aliases_keep_distinct_anchor_bases(self) -> None:
        """Legacy snapshots without derived receipts share text parsing but resolve links per URL."""
        meters = Counter()
        self.addCleanup(usage.reset, usage.set(meters))
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            raw = b'<p>SYN hospital financial assistance documents.</p><a href="application.pdf">Application</a>'
            digest = hashlib.sha256(raw).hexdigest()
            path = f"snapshots/{digest}.html"
            save(root / path, raw)
            urls = ["https://example.org/one/index", "https://example.org/two/index"]
            sources = [dict(source_id=url, role="landing_page", snapshot=dict(artifact_path=path, sha256=digest))
                       for url in urls]
            result = run(root, dict(mode="extract", sources=sources))
            for url in urls:
                anchors = [s["locator"] for s in result[url] if s["locator"].startswith("link ")]
                self.assertEqual(anchors, ["link " + url.replace("/index", "/application.pdf")])
            self.assertEqual(meters["html_parsed"], 1)

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
