"""Synthetic citation validation and conservative draft-review regressions."""
import json
import hashlib
import tempfile
import unittest
from pathlib import Path
from unittest.mock import patch

from cross_documents import MEASURES, load_sources, persist, prepare

ROOT = Path(__file__).resolve().parents[2]
QUOTE = "SYN-001 Patients may apply for financial assistance at any time."
SNAPSHOT = dict(snapshot_id="a" * 64, sha256="a" * 64, url="https://example.org/policy.pdf",
                document_type="policy_statement", retrieved_at="2026-11-08T00:00:00Z",
                publisher_updated_at=None, artifact_path="snapshots/" + "a" * 64 + ".pdf")
SOURCES = [dict(snapshot=SNAPSHOT, segments=[dict(locator="page 1", text=QUOTE, status="extracted")])]


class CrossDocumentTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.addCleanup(self.temp.cleanup)
        self.output = Path(self.temp.name)
        self.mock = patch("cross_documents.load_sources", return_value=(SOURCES, []))
        self.mock.start()
        self.addCleanup(self.mock.stop)
        self.packet = prepare("1002", "b" * 32, self.output, self.save)
        self.findings = [dict(measure_id=m, result="unclear", reason_code="insufficient_evidence",
                              explanation="Synthetic excerpts do not establish a global conclusion.",
                              observed=None, expected=None,
                              evidence=[dict(snapshot_id="a" * 64, locator="page 1", quote=QUOTE)]) for m in MEASURES]

    def save(self, path, data):
        path.parent.mkdir(parents=True, exist_ok=True)
        path.write_bytes(data)

    def persist(self):
        return persist(self.packet["packet_id"], self.findings, ROOT, self.output, self.save)

    def test_complete_five_measure_draft(self):
        result = self.persist()
        stored = json.loads(Path(result["review_file"]).read_text())
        self.assertEqual(len(stored["findings"]), 5)
        self.assertEqual(stored["status"], "draft_needs_human_review")
        self.assertNotIn("last_successful_assessment_at", stored)

    def test_rejects_invented_quote_and_wrong_page(self):
        citation = self.findings[0]["evidence"][0]
        citation["quote"] = "SYN-999 invented policy language."
        with self.assertRaisesRegex(ValueError, "Citation"):
            self.persist()
        citation["quote"] = QUOTE
        citation["locator"] = "page 2"
        with self.assertRaisesRegex(ValueError, "Citation"):
            self.persist()

    def test_rejects_missing_measure(self):
        self.findings.pop()
        with self.assertRaisesRegex(ValueError, "five"):
            self.persist()

    def test_rejects_global_pass_from_partial_search(self):
        self.findings[2].update(result="yes", reason_code="condition_met")
        with self.assertRaisesRegex(ValueError, "global pass"):
            self.persist()

    def test_inconsistency_requires_two_sources(self):
        self.findings[0].update(result="no", reason_code="contradicted")
        with self.assertRaisesRegex(ValueError, "two distinct"):
            self.persist()

    def test_psa_cannot_be_failed_without_boundary_rule(self):
        self.findings[1].update(result="no", reason_code="contradicted")
        with self.assertRaisesRegex(ValueError, "PSA rule"):
            self.persist()


class SourceIntegrityTests(unittest.TestCase):
    def test_reextracts_original_not_modified_text_and_rejects_tampering(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            html = b'<p>SYN-001 Financial assistance available at any time.</p>'
            digest = hashlib.sha256(html).hexdigest()
            def write(path, value):
                full = root / path
                full.parent.mkdir(parents=True, exist_ok=True)
                full.write_bytes(value)
            snapshot = dict(SNAPSHOT, url='https://example.org', sha256=digest,
                            artifact_path=f'snapshots/{digest}.html')
            write(snapshot['artifact_path'], html)
            collection = f'collections/1002/{"a" * 32}.json'
            write(collection, json.dumps(dict(hospital_key='1002', landing_url='https://example.org',
                                             landing_page=snapshot, documents=[])).encode())
            write(f'extractions/1002/{"b" * 32}/manifest.json', json.dumps(dict(
                hospital_key='1002', collection_manifest=collection)).encode())
            sources, unavailable = load_sources('1002', 'b' * 32, root)
            self.assertEqual(len(sources), 1)
            self.assertEqual(unavailable, [])
            self.assertIn('SYN-001', sources[0]['segments'][0]['text'])
            write(snapshot['artifact_path'], b'<p>tampered</p>')
            sources, unavailable = load_sources('1002', 'b' * 32, root)
            self.assertEqual(sources, [])
            self.assertEqual(len(unavailable), 1)


if __name__ == "__main__":
    unittest.main()
