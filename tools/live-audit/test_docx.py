"""Synthetic DOCX collection, extraction and source-integrity regressions."""
import io
import json
import tempfile
import unittest
import zipfile
from pathlib import Path

from documents import collect
from extraction import extract_bytes, extract_collection
from cross_documents import load_sources


def docx(extra="", footer=False):
    out = io.BytesIO()
    with zipfile.ZipFile(out, "w") as archive:
        archive.writestr("word/document.xml", '<w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"><w:body>'
            '<w:p><w:r><w:t>SYN-001 NYS Uniform Hospital Financial Assistance Application</w:t></w:r></w:p>'
            '<w:tbl><w:tr><w:tc><w:p><w:r><w:t>1 Person</w:t></w:r></w:p></w:tc>'
            '<w:tc><w:p><w:r><w:t>$63,840</w:t></w:r></w:p></w:tc></w:tr></w:tbl>' + extra + '</w:body></w:document>')
        if footer:
            archive.writestr("word/footer1.xml", "<footer/>")
    return out.getvalue()


class DocxTests(unittest.TestCase):
    def test_body_rows_and_honest_locator(self):
        result = extract_bytes(docx(), ".docx")[0]
        self.assertEqual(result["status"], "extracted")
        self.assertIn("1 Person $63,840", result["text"])
        self.assertIn("pagination unverified", result["locator"])

    def test_unrepresented_content_routes_to_review(self):
        for data in [docx(footer=True), docx('<w:del><w:r><w:t>deleted</w:t></w:r></w:del>'), docx('<w:drawing/>')]:
            self.assertTrue(any(p["status"] == "needs_review" for p in extract_bytes(data, ".docx")))

    def test_archive_expansion_limit(self):
        out = io.BytesIO()
        with zipfile.ZipFile(out, "w", zipfile.ZIP_DEFLATED) as archive:
            archive.writestr("word/document.xml", "x" * (49 * 1024 * 1024))
        with self.assertRaisesRegex(ValueError, "expansion_limit"):
            extract_bytes(out.getvalue(), ".docx")

    def test_collection_roundtrip_and_tamper_detection(self):
        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp)
            def save(path, data):
                path.parent.mkdir(parents=True, exist_ok=True)
                path.write_bytes(data)
            save(root / "data/maps/hospitals.geojson", json.dumps({"features": [{"id": "362", "properties": {"assistance_url": "https://example.org/fa"}}]}).encode())
            def fetch(url, host):
                if url.endswith("/fa"):
                    return b'<a href="/SYN-FA-Form-English.docx">English application</a>', url, "text/html"
                return docx(), url, "application/vnd.openxmlformats-officedocument.wordprocessingml.document"
            output = root / "out"
            result = collect("362", root, output, save, fetch)
            self.assertEqual(result["output"]["documents"][0]["status"], "saved")
            extraction = extract_collection("362", Path(result["manifest_file"]).stem, output, save)
            eid = Path(extraction["manifest_file"]).parent.name
            sources, gaps = load_sources("362", eid, output)
            application = next(s for s in sources if s["snapshot"]["document_type"] == "application")
            self.assertTrue(application["snapshot"]["artifact_path"].endswith(".docx"))
            save(output / application["snapshot"]["artifact_path"], b"tampered")
            sources, gaps = load_sources("362", eid, output)
            self.assertFalse(any(s["snapshot"]["document_type"] == "application" for s in sources))
            self.assertTrue(any(g["reason"] == "source_validation_or_extraction_failed" for g in gaps))


if __name__ == "__main__":
    unittest.main()
