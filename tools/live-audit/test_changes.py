"""Synthetic saved-capture regression tests for the changes feed."""
import hashlib
import json
import tempfile
import unittest
from pathlib import Path
from changes import ROSTER, recent_changes
from verify_summary_posting import PageAnchors
from test_docx import docx


class ChangesTests(unittest.TestCase):
    """Use synthetic bytes in an isolated, roster-scoped capture store."""

    def setUp(self) -> None:
        """Prepare a unique local store for every test."""
        temp = tempfile.TemporaryDirectory()
        self.addCleanup(temp.cleanup)
        self.root = Path(temp.name)
        (self.root/"snapshots").mkdir()

    def capture(self, day: int, body: str, key: str = "362", status: str = "complete") -> dict:
        """Persist one synthetic collector manifest and its exact HTML bytes."""
        url = ROSTER[key]["assistance_url"]
        raw = body.encode()
        digest = hashlib.sha256(raw).hexdigest()
        relative = "snapshots/"+digest+".html"
        (self.root/relative).write_bytes(raw)
        r = dict(url=url,sha256=digest,artifact_path=relative,retrieved_at=f"2026-11-{day:02}T12:00:00Z",publisher_updated_at=None)
        folder = self.root/"collections"/key
        folder.mkdir(parents=True,exist_ok=True)
        (folder/f"{day:032x}.json").write_text(json.dumps(dict(hospital_key=key,landing_url=url,status=status,landing_page=r,documents=[])))
        return r

    def feed(self) -> dict:
        """Replay synthetic manifests without the independently checked-in discovery."""
        return recent_changes(self.root,include_discovery=False)

    def test_repeats_noise_failed_attempts_and_reversions(self) -> None:
        """Unchanged and failed checks are silent; changed text and reversions retain both sides."""
        old = "<p>SYN Financial assistance income: up to 300% FPL.</p>"
        new = old.replace("300%","400%")
        self.capture(1,old)
        self.capture(2,old)
        self.capture(3,old+"<!--SYN cache buster-->")
        self.capture(4,new,status="failed")
        self.capture(5,new)
        self.capture(6,new)
        self.capture(7,old)
        self.capture(1,new,key="1002")
        feed = self.feed()
        self.assertEqual(feed,self.feed())
        self.assertEqual(len(feed["events"]),2)
        later,first = feed["events"]
        self.assertGreater(later["detected_at"],first["detected_at"])
        self.assertEqual(first["hospital_key"],"362")
        self.assertIn("300%",first["before"]["excerpt"])
        self.assertIn("400%",first["after"]["excerpt"])
        self.assertIn("posted_materials.consistent_across_documents",first["measures"])
        self.assertNotIn("application.fpl_guidelines",first["measures"])
        self.assertIsNone(first["after"]["publisher_updated_at"])
        self.assertEqual(feed["warnings"],[])

    def test_changed_links_and_tampered_snapshot(self) -> None:
        """Href matters even if the text is unchanged; reject a corrupted original."""
        html = '<p>SYN financial assistance information.</p><a href="/aid/form.pdf">Application</a>'
        self.capture(1,html)
        changed = self.capture(2,html.replace("form.pdf","new.pdf"))
        e, = self.feed()["events"]
        self.assertTrue(e["added_links"][0].endswith("new.pdf"))
        self.assertTrue(e["removed_links"][0].endswith("form.pdf"))
        (self.root/changed["artifact_path"]).write_bytes(b"SYN changed on disk")
        self.assertFalse(self.feed()["events"])
        self.assertTrue(self.feed()["warnings"])

    def test_replaced_document_at_same_url_uses_content_and_publisher_dates(self) -> None:
        """A changed DOCX is detected even when the landing HTML stays byte-identical."""
        url = ROSTER["362"]["assistance_url"] + "/SYN-form.docx"
        for day, amount in [(1,"300%"),(2,"400%"),(3,"400%")]:
            landing = self.capture(day,f'<a href="{url}">SYN financial assistance application</a>')
            data = docx(f"<w:p><w:r><w:t>SYN FPL eligibility: {amount}</w:t></w:r></w:p>")
            digest = hashlib.sha256(data).hexdigest()
            relative = f"snapshots/{digest}.docx"
            (self.root/relative).write_bytes(data)
            path = self.root/"collections"/"362"/f"{day:032x}.json"
            manifest = json.loads(path.read_bytes())
            manifest["documents"] = [dict(landing,source_url=url,url=url,artifact_path=relative,sha256=digest,
                                          status="saved",publisher_updated_at="2026-10-30")]
            path.write_text(json.dumps(manifest))
        e, = self.feed()["events"]
        self.assertEqual(e["logical_url"],url)
        self.assertEqual(e["after"]["publisher_updated_at"],"2026-10-30")
        self.assertEqual(e["detected_at"],"2026-11-02T12:00:00Z")
        self.assertIn("400%",e["after"]["excerpt"])

    def test_discovery_is_a_separate_event_and_preserves_older_finding(self) -> None:
        """An unchanged entry page can yield newly verified documents through a real anchor."""
        e, = recent_changes(self.root)["events"]
        self.assertEqual(e["kind"],"newly_verified")
        self.assertEqual([e["before"]["result"],e["after"]["result"]],["unclear","yes"])
        self.assertNotEqual(e["before"]["assessment_id"],e["after"]["assessment_id"])
        self.assertIsNone(e["after"]["publisher_updated_at"])
        parser = PageAnchors("https://example.org")
        parser.feed('<p>See /aid</p><a href="/actual">Summary</a>')
        self.assertEqual(parser.targets,{"https://example.org/actual":"/actual"})
