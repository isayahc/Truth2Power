"""Bounded English uniform-application profile; deterministic, cited drafts for #23.

Other layouts/languages and full official-template equivalence need review. No network
or model is used to calculate amounts. Original source bytes are always re-extracted.
"""
import hashlib
import json
import re
import uuid
from datetime import date
from pathlib import Path

from cross_documents import load_sources
from documents import now
from full_review import json_save
from extraction import PARSER

MEASURES = {
    "application.uniform_application": "The entire applicable NYS Uniform Hospital Financial Assistance Application is used.",
    "application.contact_information": "The application provides a hospital contact for application assistance.",
    "application.income_discount_tables": "The application includes income thresholds and discount/payment tables.",
    "application.fpl_guidelines": "The published FPL year and dollar amounts match the review year's HHS guidelines for New York.",
    "application.maximum_fpl": "The application explicitly offers eligibility through at least 400% FPL.",
    "application.installments_cap": "The application explicitly caps monthly installments at 5% of gross monthly income or less.",
}
REFERENCE = Path(__file__).resolve().parents[2] / "references/hhs-poverty-contiguous-v1.json"


def normalized(text):
    return re.sub(r"\s+", " ", text).strip()


def evidence(source, pages):
    """Quote complete original pages for this bounded five-page profile, never generated prose."""
    return [dict(snapshot_id=source["snapshot"]["snapshot_id"], locator=p["locator"], quote=p["text"])
            for p in pages if p["text"].strip()]


def evaluate(source, review_date, reference):
    year = date.fromisoformat(review_date).year
    if str(year) not in reference["years"]:
        raise ValueError("No versioned HHS reference for this review year")
    pages = source["segments"]
    text = normalized(" ".join(p["text"] for p in pages))
    readable = bool(pages) and all(p["status"] == "extracted" and p["text"].strip() for p in pages)
    profile = readable and bool(re.search(r"NYS Uniform Hospital Financial Assistance Application", normalized(pages[0]["text"])))
    findings = []

    def finding(measure, result, explanation, selected=(), observed=None, expected=None, questions=()):
        findings.append(dict(measure_id=measure, result=result,
            reason_code={"yes": "condition_met", "no": "contradicted", "unclear": "insufficient_evidence"}[result],
            explanation=explanation, observed=observed, expected=expected or MEASURES[measure],
            evidence=evidence(source, selected), unresolved_questions=list(questions)))

    if not profile:
        reasons = sorted({p.get("reason") for p in pages if p.get("reason")})
        question = "Source needs extraction/visual review or is outside the supported English uniform-application layout; review every source segment and its language before deciding."
        if reasons:
            question += " Extraction flags: " + ", ".join(reasons) + "."
        for measure in MEASURES:
            finding(measure, "unclear", question, pages, questions=[question])
        return findings, "extraction_review_needed" if not readable else "translation_or_layout_review_needed"

    # A matching title/section checklist is NOT proof of the entire official form.
    checklist = {heading: heading.lower() in text.lower() for heading in [
        "Patient Name", "Family Information", "Health Insurance Status", "Signature",
        "Minimum Eligibility and Guidelines", "Minimum Discount Rates", "Installment Plans",
        "Request for Proof of Household Income"]}
    question = "Compare all pages against the applicable official NYS form/version, including required sections and permitted hospital customizations. A matching title is not proof of completeness."
    finding("application.uniform_application", "unclear", question, [pages[0]], checklist,
            expected=dict(condition=MEASURES["application.uniform_application"],
                          authority_url="https://www.health.ny.gov/facilities/hospital/financial_assist/",
                          template_version="unverified"), questions=[question])

    contacts = [p for p in pages if re.search(
        r"If you need assistance with this application, please contact .{1,180}financial assistance office at\s*\(?\d{3}\)?[\s-]*\d{3}[\s-]*\d{4}", normalized(p["text"]), re.I)]
    finding("application.contact_information", "yes" if contacts else "unclear",
        "Hospital application-assistance contact and telephone number are stated." if contacts else "No hospital-help contact was established by the supported pattern; review the application rather than infer absence.", contacts)

    table_pages = [p for p in pages if "Federal Poverty Levels" in p["text"] and "Minimum Discount Rates" in p["text"]]
    table = table_pages[0] if len(table_pages) == 1 else None
    table_text = normalized(table["text"]) if table else ""
    header = re.search(r"Federal Poverty Levels\s*\((20\d{2})\)\s*Household Size\s+200%\s+300%\s+400%", table_text)
    income_text = table_text.split("Minimum Discount Rates", 1)[0]
    money = r"(\d{1,3}(?:,\d{3})+|\d+)"
    rows = re.findall(r"\b(\d{1,2})\s+Persons?\s+\$" + money + r"\s+\$" + money + r"\s+\$" + money + r"(?=\s|$)", income_text)
    discounts = bool(re.search(r"Income Level Payment.*Below 200% FPL Waive all charges.*200%\s*-\s*300% FPL.*301%\s*-\s*400% FPL", table_text))
    tables_present = bool(header and rows and discounts)
    finding("application.income_discount_tables", "yes" if tables_present else "unclear",
        "Income table with 200/300/400% columns and discount bands is present. This checks presence, not correctness of the dollar values." if tables_present else "Could not establish both tables in the supported layout; manual table review required.", table_pages)

    reference_year = reference["years"][str(year)]
    cells, problems = [], []
    seen = set()
    for size_string, *amounts in rows:
        size = int(size_string)
        if size < 1 or size in seen:
            problems.append("Duplicate or invalid household-size row")
            continue
        seen.add(size)
        base = reference_year["household_amounts"][size - 1] if size <= 8 else reference_year["household_amounts"][-1] + (size - 8) * reference_year["additional_person"]
        for percent, amount in zip((200, 300, 400), amounts):
            cells.append(dict(household_size=size, fpl_percent=percent, observed=int(amount.replace(",", "")), expected=base * percent // 100))
    published_year = int(header[1]) if header else None
    # Never apply annual amounts to a monthly/weekly table or trust an ambiguous header.
    valid_table = bool(header and rows and not problems and not re.search(r"\b(monthly|weekly|per month|per week)\b", income_text, re.I))
    mismatch = valid_table and (published_year != year or any(c["observed"] != c["expected"] for c in cells))
    complete_table = valid_table and set(range(1, 9)).issubset(seen)
    result = "no" if mismatch else "yes" if complete_table else "unclear"
    observed = dict(published_year=published_year, currency="USD", period="annual" if valid_table else "unverified", cells=cells,
                    period_basis="Standard annual HHS FPL table profile; monthly/weekly-labelled tables excluded.")
    explanation = (f"Published FPL table is labelled {published_year}; compared {len(cells)} printed cells with the {year} annual HHS reference. "
                   + ("Published year and/or amounts do not match; the document is not current for this review year." if mismatch else
                      "Year and all required household-size rows 1–8 match." if complete_table else "Layout, period or full row coverage is not established; manual review required."))
    finding("application.fpl_guidelines", result, explanation, table_pages, observed,
            dict(guideline_year=year, reference_version=reference["reference_version"], authority_url=reference["authority_url"],
                 currency="USD", period="annual", one_person_400_percent=4 * reference_year["household_amounts"][0]),
            questions=["Verify table layout, annual period and household-size row coverage."] if result == "unclear" else [])

    maximum = []
    for page in pages:
        for match in re.finditer(r"Individuals up to\s+(\d{2,3})%\s+of the federal poverty level are eligible for financial assistance\.", normalized(page["text"]), re.I):
            maximum.append((int(match[1]), page))
    max_values = {value for value, _ in maximum}
    max_result = "yes" if len(max_values) == 1 and next(iter(max_values)) >= 400 else "unclear"
    # A lower band alone may coexist with discretionary broader assistance; don't invent a hard exclusion.
    finding("application.maximum_fpl", max_result,
        "Application explicitly states eligibility through at least 400% FPL; this is independent of the table's year/dollars." if max_result == "yes" else "Explicit eligibility through 400% was not established; inspect any exceptions or additional eligibility language.",
        [p for _, p in maximum], dict(stated_percentages=sorted(max_values)))

    caps = []
    for page in pages:
        for match in re.finditer(r"Monthly payments cannot exceed\s+(\d+(?:\.\d+)?)%\s+of your gross monthly income", normalized(page["text"]), re.I):
            caps.append((float(match[1]), page))
    cap_values = {value for value, _ in caps}
    cap_result = "yes" if len(cap_values) == 1 and next(iter(cap_values)) <= 5 else "no" if len(cap_values) == 1 else "unclear"
    finding("application.installments_cap", cap_result,
        "Explicit monthly payment cap is compared with 5% of gross monthly income. A separate interest-rate cap is not used." if caps else "An explicit gross-monthly-income installment cap was not established; interest-rate limits are not installment caps.",
        [p for _, p in caps], dict(cap_percentages=sorted(cap_values), basis="gross monthly income"),
        dict(maximum_percent=5, basis="gross monthly income"))
    return findings, "reviewed"


def review_application(hospital_key, extraction_id, application_url, review_date, output, save):
    # Date parsing/reference lookup occurs before producing any artifact.
    year = date.fromisoformat(review_date).year
    raw_reference = REFERENCE.read_bytes()
    reference = json.loads(raw_reference)
    if str(year) not in reference["years"]:
        raise ValueError("No versioned HHS reference for this review year")
    sources, unavailable = load_sources(hospital_key, extraction_id, output)
    selected = [s for s in sources if s["snapshot"]["url"] == application_url]
    if len(selected) != 1 or selected[0]["snapshot"]["document_type"] != "application":
        raise ValueError("Select an existing application URL from the saved extraction; policy and summary evidence cannot be substituted")
    source = selected[0]
    findings, status = evaluate(source, review_date, reference)
    review_id, result_id, checked = uuid.uuid4().hex, uuid.uuid4().hex, now()
    other_applications = [s["snapshot"]["url"] for s in sources if s["snapshot"]["document_type"] == "application" and s is not source]
    result = dict(schema_version="1.0", review_type="application", review_id=review_id, result_id=result_id,
        hospital_key=hospital_key, extraction_id=extraction_id, checked_at=checked, review_date=review_date,
        guideline_year=year, reference_version=reference["reference_version"], reference_sha256=hashlib.sha256(raw_reference).hexdigest(),
        reference=reference, rubric_version="english-uniform-application-profile-v1", human_review="pending", status="draft_needs_human_review",
        scope_label="Selected application only; English profile" if status == "reviewed" else "Selected application; language/layout review needed",
        findings=findings, snapshots=[source["snapshot"]],
        extraction_details=dict(parser_version=PARSER, snapshot_id=source["snapshot"]["snapshot_id"],
            drawings=[d for p in source["segments"] for d in p.get("drawings", [])],
            limitations="Structural drawing classification does not verify rendered layout or entire-form equivalence."),
        coverage=[dict(source_id="application", url=application_url, language="English" if status == "reviewed" else "unverified",
            status=status, total_pages=len(source["segments"]), reviewed_pages=[p["locator"] for p in source["segments"]] if status == "reviewed" else [],
            notes="Source segments extracted; DOCX body locators are not rendered pages. Deterministic profile checks, not human approval or complete official-template equivalence.")],
        gaps=([dict(url=application_url, reason=status)] if status != "reviewed" else []), source_reviews=[],
        other_application_versions_not_assessed=other_applications, collection_gaps=unavailable,
        limitations=["Only the explicitly selected application is evaluated; other language versions are not certified.",
                    "Full official-form equivalence needs the applicable reference template and human review.",
                    "No statewide or Wave 1 completion, automatic grade, or human approval is implied."])
    # Keep the v1 finding core interoperable; questions belong to the draft envelope extension.
    from jsonschema import Draft202012Validator
    schema = json.loads((REFERENCE.parents[1] / "schemas/live-audit-v1.schema.json").read_text(encoding="utf-8"))
    validator = Draft202012Validator({"$ref": "#/$defs/finding", "$defs": schema["$defs"]})
    for finding in findings:
        validator.validate({k: v for k, v in finding.items() if k != "unresolved_questions"})
    path = output / "application-reviews" / review_id / "results" / f"{result_id}.json"
    json_save(path, result, save)
    return dict(result_file=str(path), review_id=review_id, scope=result["scope_label"],
                results={f["measure_id"]: f["result"] for f in findings},
                extraction_details=result["extraction_details"], human_review="pending",
                other_application_versions_not_assessed=other_applications, findings=findings)
