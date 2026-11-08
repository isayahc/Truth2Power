"""Source-verified comparison context for a NEW draft; never imports model prose."""
import json
import re

from cross_documents import identifier
from extraction import PARSER
from template_comparison import captured_reference, units, REFERENCE_URL


def normalized(text):
    return re.sub(r"[^a-z0-9]", "", text.casefold())


def matching_evidence(text, entries):
    needle = normalized(text)
    spans, chunks, start = [], [], 0
    for entry in entries:
        chunk = normalized(entry["quote"])
        spans.append((start, start + len(chunk), entry))
        chunks.append(chunk)
        start += len(chunk)
    position = "".join(chunks).find(needle)
    return [e for a, b, e in spans if b > position and a < position + len(needle)] if needle and position >= 0 else []


def table(entries):
    rows = {}
    for entry in entries:
        match = re.fullmatch(r"(\d+)\s+Persons?\s+\$([\d,]+)\s+\$([\d,]+)\s+\$([\d,]+)", entry["quote"].strip())
        if match:
            size = int(match[1])
            if size in rows:
                return {}  # Ambiguous duplicate rows must not produce numeric observations.
            rows[size] = (tuple(int(a.replace(",", "")) for a in match.groups()[1:]), entry)
    return rows


def attach_context(comparison_id, hospital_key, extraction_id, source, reference_values, output):
    packet = json.loads((output / "template-comparisons" / f"{identifier(comparison_id)}.json").read_text(encoding="utf-8"))
    if (packet["hospital_key"] != hospital_key or packet["extraction_id"] != extraction_id
            or packet["comparison_id"] != comparison_id or packet.get("extraction_parser") != PARSER
            or packet.get("reference_version") != "NYS-2026-English" or packet.get("reference_url") != REFERENCE_URL
            or packet["snapshots"][0] != source["snapshot"]):
        raise ValueError("Comparison source or parser changed; rebuild the comparison before attaching")
    if not packet.get("reference_capture_id"):
        raise ValueError("Attachment requires a hash-verified reference capture; rebuild using reference_capture_id")
    reference, method = captured_reference(packet["reference_capture_id"], output)
    app, ref = units(source, "application"), units(reference, "reference")
    if (packet["snapshots"][1] != reference["snapshot"] or app != packet["application_evidence"]
            or ref != packet["reference_evidence"]):
        raise ValueError("Comparison evidence does not match re-extracted originals")
    observations = []

    def add(kind, title, explanation, selected):
        observations.append(dict(kind=kind, title=title, explanation=explanation, evidence=selected))

    contact = "If you need assistance with this application, please contact"
    pairs = []
    for entries in (app, ref):
        start = next((i for i, e in enumerate(entries) if normalized(contact) in normalized(e["quote"])), None)
        selected = [] if start is None else [entries[start]]
        if selected and "office" not in selected[0]["quote"].lower() and start + 1 < len(entries):
            selected.append(entries[start + 1])
        pairs.append(selected)
    if all(pairs):
        add("customization", "Hospital contact substitution", "The hospital provides its contact where the official form has hospital-name/telephone placeholders. Review the cited wording; this is not evidence of a missing contact section.", pairs[0] + pairs[1])

    headings = ["Eligibility", "Minimum Discount Rates", "Installment Plans", "Request for Proof of Household Income"]
    shared = [(heading, matching_evidence(heading, app), matching_evidence(heading, ref)) for heading in headings]
    shared = [s for s in shared if s[1] and s[2]]
    if shared:
        add("shared_content", "Section headings present in both", "; ".join(s[0] for s in shared) + ". Heading presence does not establish complete-form equivalence; line wrapping is not missing content.", [e for _, a, b in shared for e in a + b])

    timing = "You can apply for financial assistance at any point during the collection process."
    a, b = matching_evidence(timing, app), matching_evidence(timing, ref)
    if a and b:
        add("shared_content", "Shared application-timing provision", "Both selected sources contain the quoted application-during-collections provision. This does not resolve separate posted-material timing questions.", a + b)
    for entry in ref:
        if "word/footnotes.xml" in entry["locator"] and "Primary languages" in entry["quote"]:
            matched = matching_evidence(entry["quote"], app)
            if matched:
                add("formatting", "Language definition moved between body and footnote", "The hospital body contains the official footnote definition. Its absence from body-only reference extraction was an extraction difference, not a missing reference provision.", matched + [entry])

    app_rows, ref_rows = table(app), table(ref)
    base = reference_values["years"]["2026"]["household_amounts"]
    for size, (amounts, entry) in ref_rows.items():
        if not 1 <= size <= len(base):
            continue
        for index, percent in enumerate((200, 300, 400)):
            expected = base[size - 1] * percent // 100
            if amounts[index] != expected:
                selected = [entry] + ([app_rows[size][1]] if size in app_rows else [])
                add("reference_discrepancy", f"Official template: {size}-person {percent}% FPL discrepancy",
                    f"Official template prints ${amounts[index]:,}; the 2026 HHS calculation is ${expected:,}. "
                    + (f"The hospital prints ${app_rows[size][0][index]:,}. " if size in app_rows else "")
                    + "Do not treat matching an erroneous reference cell as dollar correctness.", selected)
    added = sorted(set(app_rows) - set(ref_rows))
    if added and ref_rows:
        add("customization", "Additional household-size rows", f"Hospital table includes household sizes {', '.join(map(str, added))} beyond the extracted official rows. Additional coverage is not itself a failure.",
            [app_rows[n][1] for n in added] + [ref_rows[n][1] for n in sorted(ref_rows)])
    app_year = next((e for e in app if re.search(r"Federal Poverty Levels\s*\((20\d{2})\)", e["quote"])), None)
    ref_year = next((e for e in ref if "Federal Poverty Levels (2026)" in e["quote"]), None)
    outdated = app_year and ref_year and "(2026)" not in app_year["quote"]
    if outdated:
        add("substantive_difference", "Hospital FPL table is from a different year", "The hospital table year differs from the 2026 reference. Keep this established currency issue distinct from the interpretation of the entire-form criterion.",
            [app_year, ref_year] + ([app_rows[1][1], ref_rows[1][1]] if 1 in app_rows and 1 in ref_rows else []))

    questions = ["Verify the visual fields, signature areas and table layout against the official form; text extraction does not establish rendered equivalence.",
                 "Confirm how the official template's numeric discrepancy should be treated for whole-form equivalence; HHS arithmetic remains the dollar-check authority."]
    if added:
        questions.append("Confirm that added hospital/campus or MRN fields and the extra household-size row preserve all required fields and are permitted customizations.")
    if outdated:
        questions.append("Does the outdated FPL table also fail the entire-current-form criterion, or should that defect remain solely in the separate FPL measure? Apply an approved rubric rule.")
    if any(s["status"] != "extracted" for s in reference["segments"]):
        questions.append("Resolve the remaining reference-part extraction flags before whole-form interpretation.")
    context = dict(comparison_id=comparison_id, compared_at=packet["checked_at"], parser_version=PARSER,
        reference_capture_id=packet["reference_capture_id"], reference_version=packet["reference_version"],
        reference_snapshot_id=reference["snapshot"]["snapshot_id"], reference_url=reference["snapshot"]["url"],
        reference_retrieved_at=reference["snapshot"]["retrieved_at"], retrieval_method=method,
        reference_parts=[dict(locator=s["locator"], status=s["status"], reason=s.get("reason"), empty=s.get("empty_auxiliary_part", False), fields=s.get("fields", [])) for s in reference["segments"]],
        observations=observations, unresolved_questions=questions,
        status="verified_text_comparison_pending_interpretation", human_review="pending")
    return context, reference
