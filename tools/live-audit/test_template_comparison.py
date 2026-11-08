"""Synthetic reference provenance and comparison tests."""
import json
import asyncio
import hashlib
import tempfile
import unittest
from pathlib import Path
from unittest.mock import patch

from test_docx import docx
from test_applications import synthetic_source, URL
from template_comparison import compare_template, import_browser_reference, captured_reference, REFERENCE_URL


class TemplateTests(unittest.TestCase):
    def test_browser_import_reuses_verified_capture_and_preserves_retrieval_time(self):
        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp)
            output = root / "out"
            def save(path, data):
                path.parent.mkdir(parents=True, exist_ok=True)
                path.write_bytes(data)
            raw = docx()
            digest = hashlib.sha256(raw).hexdigest()
            save(root / ".playwright-mcp/SYN-reference.docx", raw)
            captured = import_browser_reference("SYN-reference.docx", REFERENCE_URL, digest, "2026-11-08T21:07:06Z", root, output, save)
            cid = captured["reference_capture_id"]
            reference, method = captured_reference(cid, output)
            self.assertEqual(reference["snapshot"]["retrieved_at"], "2026-11-08T21:07:06Z")
            self.assertIn("not re-fetched", method)
            with patch("template_comparison.load_sources", return_value=([synthetic_source()], [])):
                def no_network(*args):
                    self.fail("Captured reference should not re-fetch")
                compared = compare_template("362", "a" * 32, URL, output, save, fetch=no_network, reference_capture_id=cid)
                self.assertEqual(compared["snapshots"][1]["sha256"], digest)
                self.assertEqual(compared["uniform_application_result"], "unclear")
            for filename, url, checksum in [("../escape.docx", REFERENCE_URL, digest), ("SYN-reference.docx", "https://example.org/wrong.docx", digest), ("SYN-reference.docx", REFERENCE_URL, "0" * 64)]:
                with self.assertRaises(ValueError):
                    import_browser_reference(filename, url, checksum, "2026-11-08T21:07:06Z", root, output, save)
            save(output / reference["snapshot"]["artifact_path"], b"SYN tampered")
            with self.assertRaisesRegex(ValueError, "hash mismatch"):
                captured_reference(cid, output)

    def test_mcp_offloads_sync_browser_fetch_outside_event_loop(self):
        import server
        def comparison(*args, **kwargs):
            with self.assertRaises(RuntimeError):
                asyncio.get_running_loop()
            return {"status": "synthetic"}
        with patch("server.compare_template", side_effect=comparison):
            self.assertEqual(asyncio.run(server.compare_application_template("362", "a" * 32, URL)), {"status": "synthetic"})

    def test_exact_evidence_saved_without_promoting_findings(self):
        source = synthetic_source(2026)
        with tempfile.TemporaryDirectory() as tmp, patch("template_comparison.load_sources", return_value=([source], [])):
            def save(path, data):
                path.parent.mkdir(parents=True, exist_ok=True)
                path.write_bytes(data)
            result = compare_template("362", "a" * 32, URL, Path(tmp), save,
                                      fetch=lambda url, host: (docx(), url, "application/octet-stream"))
            stored = json.loads(Path(result["result_file"]).read_text())
            self.assertEqual(stored["uniform_application_result"], "unclear")
            self.assertEqual(stored["human_review"], "pending")
            self.assertEqual(stored["reference_url"], REFERENCE_URL)
            self.assertGreater(stored["changed_blocks"], 0)
            for e in stored["application_evidence"]:
                self.assertTrue(any(e["locator"] == p["locator"] and e["quote"] in p["text"] for p in source["segments"]))
            reference_ids = {e["evidence_id"] for e in stored["reference_evidence"]}
            self.assertEqual(reference_ids, {eid for b in stored["alignment"] for eid in b["reference_evidence_ids"]})
            self.assertTrue((Path(tmp) / stored["snapshots"][1]["artifact_path"]).exists())
            for kind in ("reference", "application"):
                for entry in stored[f"{kind}_evidence"]:
                    self.assertIn(f"[{entry['evidence_id']}] {entry['quote']}", result[f"{kind}_evidence_text"])
            self.assertNotIn("source_segments", result)
            self.assertNotIn("reference_segments", result)

    def test_rejects_policy_and_redirected_reference(self):
        source = synthetic_source()
        with patch("template_comparison.load_sources", return_value=([source], [])):
            with self.assertRaisesRegex(ValueError, "redirect"):
                compare_template("362", "a" * 32, URL, Path("."), lambda p, d: None,
                                 fetch=lambda url, host: (docx(), "https://www.health.ny.gov/different.docx", "application/octet-stream"))
            source["snapshot"]["document_type"] = "policy_statement"
            with self.assertRaisesRegex(ValueError, "saved application"):
                compare_template("362", "a" * 32, URL, Path("."), lambda p, d: None)


if __name__ == "__main__":
    unittest.main()
