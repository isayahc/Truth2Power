"""Offline collector regressions using synthetic public-document fixtures."""
import json
import tempfile
import unittest
from pathlib import Path

from documents import approved, collect


class CollectionTests(unittest.TestCase):
    def test_failed_landing_attempt_preserves_prior_success_and_retrieval_date(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            (root / "data/maps").mkdir(parents=True)
            (root / "data/maps/hospitals.geojson").write_text(json.dumps({"features": [
                {"id": "1002", "properties": {"assistance_url": "https://example.org/fa/"}}
            ]}))

            def save(path, data):
                path.parent.mkdir(parents=True, exist_ok=True)
                path.write_bytes(data)

            first = collect("1002", root, root / "out", save,
                            lambda url, host: (b"<h1>SYN assistance page</h1>", url, "text/html"))
            original = Path(first["manifest_file"]).read_bytes()
            landing = first["output"]["landing_page"]
            self.assertLessEqual(first["output"]["attempted_at"], landing["retrieved_at"])
            self.assertIsNone(landing["publisher_updated_at"])

            def failed_fetch(url, host):
                raise TimeoutError("SYN failed landing fetch")

            failed = collect("1002", root, root / "out", save, failed_fetch)
            self.assertNotEqual(first["manifest_file"], failed["manifest_file"])
            self.assertEqual(failed["output"]["status"], "failed")
            self.assertIsNone(failed["output"]["landing_page"])
            self.assertEqual(failed["output"]["error_type"], "TimeoutError")
            self.assertEqual(Path(first["manifest_file"]).read_bytes(), original)
            self.assertTrue((root / "out" / landing["artifact_path"]).is_file())

    def test_duplicates_failures_and_snapshots(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            (root / "data/maps").mkdir(parents=True)
            (root / "data/maps/hospitals.geojson").write_text(json.dumps({"features": [
                {"id": "1002", "properties": {"assistance_url": "https://example.org/fa/"}}
            ]}))
            html = b'''<a href="/a.pdf#page=1">English</a><a href="/a.pdf">Again</a>
            <a href="/spanish.PDF?q=1">Spanish</a><a href="/bad.pdf">Broken</a>
            <a href="https://other.example/b.pdf">External</a>'''
            calls = []

            def fetch(url, host):
                calls.append(url)
                if url.endswith("/fa/"):
                    return html, url, "text/html"
                return (b"not a PDF" if "bad.pdf" in url else b"%PDF-1.7 synthetic fixture"), url, "application/pdf"

            def save(path, data):
                path.parent.mkdir(parents=True, exist_ok=True)
                path.write_bytes(data)

            result = collect("1002", root, root / "out", save, fetch)
            output = result["output"]
            self.assertEqual(output["status"], "partial")
            self.assertEqual([d["status"] for d in output["documents"]], ["saved", "saved", "failed", "saved"])
            self.assertEqual(calls.count("https://example.org/a.pdf"), 1)
            self.assertEqual(output["documents"][0]["labels"], ["English", "Again"])
            self.assertTrue(Path(result["manifest_file"]).is_file())
            for doc in output["documents"][:2]:
                self.assertTrue((root / "out" / doc["artifact_path"]).is_file())
            self.assertIn("https://other.example/b.pdf", calls)

    def test_redirect_host_policy(self):
        for url in ["http://example.org/a.pdf", "https://localhost/a.pdf", "https://example.org:444/a.pdf", "https://user@example.org/a.pdf"]:
            with self.assertRaises(ValueError):
                approved(url, "example.org")
        self.assertEqual(approved("https://www.example.org/a.pdf", "example.org"), "https://www.example.org/a.pdf")


if __name__ == "__main__":
    unittest.main()
