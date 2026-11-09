"""Regression checks for direct-link publication evidence, using only synthetic bytes."""
import hashlib
import json
import tempfile
import unittest
from pathlib import Path

from posting import assess

STAMP = "2026-11-08T12:00:00+00:00"
URL = "https://example.org/SYN-aid"


class PostingTests(unittest.TestCase):
    """Exercise the native producer with fabricated role inventory entries."""

    def setUp(self) -> None:
        """Create a captured landing and application plus a broken policy link."""
        temp = tempfile.TemporaryDirectory()
        self.addCleanup(temp.cleanup)
        self.root = Path(temp.name)
        (self.root / "snapshots").mkdir()
        raw = (Path(__file__).resolve().parents[2] / "backend/audit/fixture/application.pdf").read_bytes()
        url = URL + "/form.pdf"
        self.target = self.snapshot(raw, ".pdf", url)
        broken = URL + "/missing.pdf"
        html = f'<a href="{url}">SYN form</a><a href="{url}">Duplicate</a><a href="{broken}">SYN policy</a>'.encode()
        self.page = self.snapshot(html, ".html", URL)
        self.collection = dict(hospital_key="362",landing_url=URL,status="partial",landing_page=self.page,
            attempted_at=STAMP,completed_at=STAMP,documents=[dict(self.target,source_url=url,status="saved"),
            dict(source_url=broken,status="failed",http_status=404)])
        self.role = dict(type="application", status="content_confirmed",sha256=self.target["sha256"],
                         quote="One-person household",locator="page 1")

    def snapshot(self, data: bytes, suffix: str, url: str) -> dict:
        """Persist synthetic bytes by digest and return collector-shaped metadata."""
        digest = hashlib.sha256(data).hexdigest()
        relative = "snapshots/" + digest + suffix
        (self.root / relative).write_bytes(data)
        return dict(url=url,sha256=digest,artifact_path=relative,retrieved_at=STAMP,publisher_updated_at=None)

    def replay(self) -> list[dict]:
        """Run the draft projection against the temporary evidence store."""
        inventory = json.dumps(dict(hospitals=[dict(hospital_key="362",documents=[self.role])])).encode()
        return assess(self.collection,self.root,inventory,URL,STAMP)["assessment"]["findings"]

    def test_duplicate_and_failed_links(self) -> None:
        """Count one verified posting and retain uncertainty for absent evidence."""
        found = self.replay()
        self.assertEqual([f["result"] for f in found], ["yes","unclear","unclear"])
        self.assertEqual(len(found[0]["evidence"]),2)
        self.assertEqual(found[2]["observed"]["coverage_gaps"][0]["reason"],404)

    def test_role_and_anchor_must_be_verified(self) -> None:
        """Reject a forged location, wrong facility, or collection URL invented after capture."""
        self.role["locator"] = "page 99"
        with self.assertRaisesRegex(ValueError,"excerpt"): self.replay()
        self.role["locator"] = "page 1"
        self.collection["documents"][0]["source_url"] += "?forged"
        with self.assertRaisesRegex(ValueError,"links differ"): self.replay()
        self.collection["landing_url"] += "/foreign"
        with self.assertRaisesRegex(ValueError,"roster"): self.replay()

    def test_tampered_bytes_and_changed_source(self) -> None:
        """Ignore unconfirmed new versions and reject corrupted immutable files."""
        self.role["sha256"] = "0"*64
        self.assertEqual(self.replay()[0]["result"],"unclear")
        (self.root/self.page["artifact_path"]).write_text("SYN tampered")
        with self.assertRaisesRegex(ValueError,"digest"): self.replay()
