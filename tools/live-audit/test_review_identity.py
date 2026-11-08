"""Synthetic producer tests for content-bound language labels."""
import hashlib
import json
import tempfile
import unittest
from pathlib import Path
from unittest.mock import patch

from review_identity import application_language, review_identity


class ReviewIdentityTests(unittest.TestCase):
    """A label is evidence about a specific hospital and immutable original."""

    def test_language_follows_content_and_facility_not_filename(self) -> None:
        """A changed snapshot at the same Spanish-labelled URL loses the old label."""
        digest = hashlib.sha256(b"SYN application").hexdigest()
        snap = dict(url="https://example.org/SYN-Spanish.pdf", sha256=digest, document_type="application")
        with tempfile.TemporaryDirectory() as folder:
            inventory = Path(folder) / "inventory.json"
            doc = dict(sha256=digest, type="application", status="content_confirmed", language_label="Spanish")
            inventory.write_text(json.dumps({"hospitals": [{"hospital_key": "1002", "documents": [doc]}]}))
            with patch("review_identity.INVENTORY", inventory):
                self.assertEqual(application_language("1002", snap, False), "Spanish")
                self.assertEqual(application_language("362", snap, False), "unknown")
                self.assertEqual(application_language("1002", dict(snap, sha256="a" * 64), False), "unknown")
                self.assertEqual(review_identity("selected_application", [(snap, "Spanish")])["documents"][0]["snapshot_sha256"], digest)
