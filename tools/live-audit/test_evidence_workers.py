"""Offline worker contracts for all roster identities and ambiguous shared policies."""
import unittest

from evidence_workers import explicit_identity, review_source, roster_names


def page(text: str) -> dict:
    """Create one synthetic extracted page."""
    return {"locator": "page 1", "text": text, "status": "extracted"}


class EvidenceWorkerTests(unittest.TestCase):
    """Check source-scoped identity, extraction gaps and replayable citations."""

    def test_same_worker_contract_for_every_roster_entry(self) -> None:
        """Use the same synthetic source shape and allow only the selected campus."""
        self.assertEqual(len(roster_names()), 212)
        for key, name in roster_names().items():
            with self.subTest(hospital=key):
                source = {"role": "unclassified", "source_id": "https://files.example/public",
                          "snapshot": {"sha256": "a" * 64}}
                parts = [page(f"Financial Assistance Policy Summary\nApplies to {name}.\n"
                              "How to apply: submit the application at reception.")]
                packet = review_source(source, parts, website=False)
                self.assertIn(name, packet["campus_mentions"])
                for citations in packet["observations"].values():
                    for citation in citations:
                        self.assertIn(citation["quote"], parts[0]["text"])
                        self.assertEqual(citation["locator"], "page 1")
                self.assertEqual(explicit_identity(parts, key)["role"], "policy_summary")

    def test_shared_and_unreadable_sources_keep_their_uncertainty(self) -> None:
        """Citing a campus alone cannot resolve ambiguous or partial document scope."""
        a, b = list(roster_names())[:2]
        text = f"Financial Assistance Policy\nApplies to {roster_names()[a]}.\n"
        self.assertIsNone(explicit_identity([page(text)], b))
        self.assertIsNone(explicit_identity([page(text + "Excludes this campus for outpatient visits.")], a))
        self.assertIsNone(explicit_identity([page(text + roster_names()[b])], a))
        blank = {"locator": "page 2", "text": "", "status": "needs_review", "reason": "sparse"}
        parts = [page(text), blank]
        self.assertIsNone(explicit_identity(parts, a))
        review = review_source({"source_id": "https://example.org/test", "role": "unclassified",
                                "snapshot": {"sha256": "b" * 64}}, parts, website=False)
        self.assertEqual(review["unreadable"], [{"locator": "page 2", "reason": "sparse"}])
