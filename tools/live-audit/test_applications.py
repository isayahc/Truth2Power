"""Synthetic application-only evidence and review-year regression checks."""
import copy
import hashlib
import json
import tempfile
import unittest
from pathlib import Path
from unittest.mock import patch

from applications import MEASURES, REFERENCE, evaluate, review_application

REFERENCE_DATA = json.loads(REFERENCE.read_text(encoding="utf-8"))
URL = "https://example.org/SYN-application.pdf"


def synthetic_source(year=2025):
    base = REFERENCE_DATA["years"][str(year)]["household_amounts"]
    rows = "\n".join(f"{i} Person{'s' if i > 1 else ''} " + " ".join(f"${value * n:,}" for n in (2, 3, 4)) for i, value in enumerate(base, 1))
    texts = ["SYNTHETIC application\nNYS Uniform Hospital Financial Assistance Application\nPatient Name\nFamily Information\nHealth Insurance Status\nSignature",
             "Minimum Eligibility and Guidelines\nIf you need assistance with this application, please contact SYN Hospital's financial assistance office at (212) 555-0100.",
             f"Individuals up to 400% of the federal poverty level are eligible for financial assistance.\nFederal Poverty Levels ({year})\nHousehold Size 200% 300% 400%\n{rows}\nMinimum Discount Rates\nIncome Level Payment\nBelow 200% FPL Waive all charges\n200% - 300% FPL Uninsured patients: up to 10% of Medicaid rate\n301% - 400% FPL Uninsured patients: up to 20% of Medicaid rate\nInstallment Plans\nMonthly payments cannot exceed 5% of your gross monthly income and interest may not exceed 2%.\nRequest for Proof of Household Income"]
    digest = hashlib.sha256("\n".join(texts).encode()).hexdigest()
    return dict(snapshot=dict(snapshot_id=digest, sha256=digest, url=URL, document_type="application",
                              retrieved_at="2026-11-08T00:00:00Z", publisher_updated_at=None, artifact_path=f"snapshots/{digest}.pdf"),
                segments=[dict(text=text, locator=f"page {i}", status="extracted") for i, text in enumerate(texts, 1)])


def results(source, year=2026):
    findings, _ = evaluate(source, f"{year}-11-08", REFERENCE_DATA)
    return {f["measure_id"].removeprefix("application."): f for f in findings}


class ApplicationTests(unittest.TestCase):
    def test_same_document_passes_historical_fpl_and_fails_current_without_changing_maximum(self):
        source = synthetic_source()
        before = copy.deepcopy(source)
        historical, current = results(source, 2025), results(source, 2026)
        self.assertEqual(historical["fpl_guidelines"]["result"], "yes")
        self.assertEqual(current["fpl_guidelines"]["result"], "no")
        self.assertEqual(current["fpl_guidelines"]["expected"]["one_person_400_percent"], 63840)
        self.assertEqual(current["maximum_fpl"]["result"], "yes")
        self.assertEqual(source, before)
        self.assertEqual(len(current["fpl_guidelines"]["observed"]["cells"]), 24)

    def test_current_year_label_does_not_hide_wrong_dollar_amounts(self):
        source = synthetic_source()
        source["segments"][2]["text"] = source["segments"][2]["text"].replace("(2025)", "(2026)")
        self.assertEqual(results(source)["fpl_guidelines"]["result"], "no")

    def test_six_checks_and_no_uniform_pass_from_title(self):
        findings = results(synthetic_source(2026))
        self.assertEqual(len(findings), 6)
        self.assertEqual(findings["uniform_application"]["result"], "unclear")
        for name in ["contact_information", "income_discount_tables", "fpl_guidelines", "maximum_fpl", "installments_cap"]:
            self.assertEqual(findings[name]["result"], "yes", name)

    def test_net_income_interest_and_collection_percentage_are_not_target_conditions(self):
        source = synthetic_source(2026)
        source["segments"][2]["text"] = source["segments"][2]["text"].replace("gross monthly", "net monthly").replace(
            "Individuals up to 400% of the federal poverty level are eligible for financial assistance.", "Collections protections apply below 400% FPL.")
        found = results(source)
        self.assertEqual(found["installments_cap"]["result"], "unclear")
        self.assertEqual(found["maximum_fpl"]["result"], "unclear")

    def test_explicit_higher_cap_is_adverse_and_conflicting_caps_are_unclear(self):
        source = synthetic_source(2026)
        source["segments"][2]["text"] = source["segments"][2]["text"].replace("exceed 5%", "exceed 10%")
        self.assertEqual(results(source)["installments_cap"]["result"], "no")
        source["segments"][2]["text"] += " Monthly payments cannot exceed 5% of your gross monthly income."
        self.assertEqual(results(source)["installments_cap"]["result"], "unclear")

    def test_monthly_table_and_incomplete_rows_do_not_get_annual_pass(self):
        source = synthetic_source(2026)
        source["segments"][2]["text"] = source["segments"][2]["text"].replace("Household Size", "Monthly Household Size")
        self.assertEqual(results(source)["fpl_guidelines"]["result"], "unclear")
        source = synthetic_source(2026)
        source["segments"][2]["text"] = "\n".join(line for line in source["segments"][2]["text"].splitlines() if not line.startswith("8 Persons"))
        self.assertEqual(results(source)["fpl_guidelines"]["result"], "unclear")

    def test_unreadable_and_unsupported_language_never_pass(self):
        source = synthetic_source()
        source["segments"][0]["status"] = "unreadable"
        self.assertEqual({f["result"] for f in results(source).values()}, {"unclear"})
        source = synthetic_source()
        source["segments"][0]["text"] = "SYN Solicitud de ayuda economica"
        self.assertEqual({f["result"] for f in results(source).values()}, {"unclear"})

    def test_save_validated_six_findings_and_reject_wrong_document_or_reference_year(self):
        source = synthetic_source()
        with tempfile.TemporaryDirectory() as tmp, patch("applications.load_sources", return_value=([source], [])):
            def save(path, data):
                path.parent.mkdir(parents=True, exist_ok=True)
                path.write_bytes(data)
            result = review_application("1002", "a" * 32, URL, "2026-11-08", Path(tmp), save)
            stored = json.loads(Path(result["result_file"]).read_text(encoding="utf-8"))
            self.assertEqual({f["measure_id"] for f in stored["findings"]}, set(MEASURES))
            self.assertEqual(stored["human_review"], "pending")
            self.assertNotIn("last_successful_assessment_at", stored)
            for finding in stored["findings"]:
                for citation in finding["evidence"]:
                    self.assertTrue(any(p["text"] == citation["quote"] and p["locator"] == citation["locator"] for p in source["segments"]))
            source["snapshot"]["document_type"] = "policy_statement"
            with self.assertRaisesRegex(ValueError, "policy and summary"):
                review_application("1002", "a" * 32, URL, "2026-11-08", Path(tmp), save)
            with self.assertRaisesRegex(ValueError, "reference"):
                review_application("1002", "a" * 32, URL, "2027-11-08", Path(tmp), save)


if __name__ == "__main__":
    unittest.main()
