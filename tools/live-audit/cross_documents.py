"""Evidence packets and citation-checked draft findings for the five #22 measures."""
import hashlib
import json
import re
import uuid
from pathlib import Path
from typing import Literal

from pydantic import BaseModel, Field

from jsonschema import Draft202012Validator
from documents import LIMIT, now
from extraction import extract_bytes

MEASURES = {
    "posted_materials.consistent_across_documents": r"poverty|FPL|300%|400%|discount|income|ingreso",
    "posted_materials.primary_service_area_boundaries_compliant": r"residen|service area|New York|county|counties|emergency",
    "posted_materials.no_submission_time_limit": r"any\s*time|deadline|days|months|time.?limit|collection process",
    "posted_materials.no_evidence_of_asset_checks": r"asset|savings|bank|property|home|car\b|resources",
    "posted_materials.no_immigration_status_barrier": r"immigra|citizen|legal status|social security|undocumented|regardless",
}


class CrossFinding(BaseModel):
    measure_id: Literal[
        "posted_materials.consistent_across_documents",
        "posted_materials.primary_service_area_boundaries_compliant",
        "posted_materials.no_submission_time_limit",
        "posted_materials.no_evidence_of_asset_checks",
        "posted_materials.no_immigration_status_barrier",
    ]
    result: Literal["no", "unclear"]
    reason_code: Literal["contradicted", "insufficient_evidence", "conflicting_evidence"]
    explanation: str
    observed: str | None
    expected: str | None
    evidence_ids: list[str] = Field(max_length=12, description="Select evidence_id values from this measure's candidates. The server attaches exact quotes; do not retype evidence.")


def identifier(value):
    if not re.fullmatch(r"[0-9a-f]{32}", value):
        raise ValueError("Invalid run identifier")
    return value


def load_sources(hospital_key, extraction_id, output):
    if not re.fullmatch(r"\d{1,8}", hospital_key):
        raise ValueError("Invalid hospital ID")
    source = Path("extractions") / hospital_key / identifier(extraction_id) / "manifest.json"
    extraction = json.loads((output / source).read_text(encoding="utf-8"))
    expected = rf"collections/{hospital_key}/[0-9a-f]{{32}}\.json"
    if extraction["hospital_key"] != hospital_key or not re.fullmatch(expected, extraction["collection_manifest"]):
        raise ValueError("Invalid collection reference")
    collection = json.loads((output / extraction["collection_manifest"]).read_text(encoding="utf-8"))
    if collection["hospital_key"] != hospital_key:
        raise ValueError("Collection hospital mismatch")
    records = [collection.get("landing_page") or dict(source_url=collection["landing_url"], status="failed")]
    records += collection["documents"]
    sources, unavailable = [], []
    for index, record in enumerate(records):
        url = record.get("source_url", record.get("url"))
        if record.get("status") == "failed":
            unavailable.append(dict(url=url, reason="source_not_downloaded"))
            continue
        try:
            digest = record["sha256"]
            suffix = ".html" if index == 0 else Path(record["artifact_path"]).suffix
            if suffix not in {".html", ".pdf", ".docx"} or (index and suffix == ".html"):
                raise ValueError("unsupported_snapshot_type")
            relative = f"snapshots/{digest}{suffix}"
            if not re.fullmatch(r"[0-9a-f]{64}", digest) or record["artifact_path"] != relative:
                raise ValueError("invalid_snapshot_reference")
            path = output / relative
            if not path.resolve().is_relative_to(output.resolve()) or path.stat().st_size > LIMIT:
                raise ValueError("invalid_snapshot_path_or_size")
            data = path.read_bytes()
            if hashlib.sha256(data).hexdigest() != digest:
                raise ValueError("snapshot_hash_mismatch")
            # Re-extract original bytes: do not trust edited extracted-text JSON as evidence.
            segments = extract_bytes(data, suffix)
            role = "landing_page" if index == 0 else "supplement"
            name = url.lower()
            if index:
                role = ("application" if "app-" in name or "application" in name or "fa-form" in name else "policy_summary" if "summary" in name
                        else "policy_statement" if "financial-assistance" in name else "supplement")
            snapshot = dict(snapshot_id=digest, document_type=role, url=record["url"],
                            retrieved_at=record["retrieved_at"], publisher_updated_at=record.get("publisher_updated_at"),
                            sha256=digest, artifact_path=relative)
            sources.append(dict(snapshot=snapshot, segments=segments, role_inferred_from_url=True))
            for segment in segments:
                if segment["status"] != "extracted":
                    unavailable.append(dict(url=url, locator=segment["locator"], reason="page_requires_review"))
        except Exception as error:
            unavailable.append(dict(url=url, reason="source_validation_or_extraction_failed", error_type=type(error).__name__))
    return sources, unavailable


def prepare(hospital_key, extraction_id, output, save):
    sources, unavailable = load_sources(hospital_key, extraction_id, output)
    # Prioritize English policy/application/summary evidence within the bounded pilot packet.
    ranked = sorted(sources, key=lambda s: (
        any(language in s["snapshot"]["url"].lower() for language in ("spanish", "polish", "russian", "ukrainian")),
        s["snapshot"]["document_type"] in {"landing_page", "supplement"}))
    candidates = {}
    for measure_number, (measure, pattern) in enumerate(MEASURES.items(), 1):
        per_source = []
        for source in ranked:
            matches = []
            for segment in source["segments"]:
                text = segment["text"]
                hits = list(re.finditer(pattern, text, re.I))
                match = hits[0] if hits else None
                if match:
                    if measure.endswith("consistent_across_documents"):
                        match = re.search(r"300%|400%", text) or match
                    start, end = max(0, match.start() - 180), min(len(text), match.end() + 650)
                    matches.append(dict(score=len(hits), snapshot_id=source["snapshot"]["snapshot_id"],
                                        url=source["snapshot"]["url"], locator=segment["locator"], quote=text[start:end]))
            matches.sort(key=lambda item: -item["score"])
            per_source.append(matches)
        # Round-robin sources, rather than filling the packet from the first policy.
        candidates[measure] = [matches[i] for i in range(2) for matches in per_source if len(matches) > i][:6]
        for number, candidate in enumerate(candidates[measure], 1):
            candidate.pop("score")
            candidate["evidence_id"] = f"m{measure_number}-e{number}"
    packet_id = uuid.uuid4().hex
    packet = dict(packet_id=packet_id, hospital_key=hospital_key, extraction_id=extraction_id,
                  required_measure_ids=list(MEASURES),
                  prepared_at=now(), unavailable=unavailable,
                  sources=[s["snapshot"] for s in sources], candidates=candidates,
                  limitations="Keyword-selected excerpts are incomplete and mostly English. Document roles are URL hints, "
                  "not verified classifications. A match is not a finding. Absence of a keyword is not proof of absence. "
                  "Missing sources and unreviewed translations prevent global positive conclusions. "
                  "PSA compliance requires an approved boundary rule, which this pilot does not supply. "
                  "Return all five measures; use unclear where evidence/rules are insufficient. "
                  "A consistency contradiction requires two different sources on the same topic. "
                  "Select evidence_id values from the relevant measure; the server attaches exact quotes. "
                  "Do not require hospitals to explicitly claim that all their documents agree: compare actual content. "
                  "Findings are drafts pending human review, with no grade.")
    path = output / "cross-document-packets" / (packet_id + ".json")
    save(path, json.dumps(packet, indent=2, ensure_ascii=False).encode("utf-8"))
    return packet


def persist_selection(packet_id, selections, root, output, save):
    """Resolve packet-local IDs, then apply the same source-level citation checks."""
    packet = json.loads((output / "cross-document-packets" / (identifier(packet_id) + ".json")).read_text(encoding="utf-8"))
    findings = []
    for selection in selections:
        selection = CrossFinding.model_validate(selection).model_dump()
        candidates = {c["evidence_id"]: c for c in packet["candidates"].get(selection["measure_id"], [])}
        ids = selection.pop("evidence_ids")
        if len(set(ids)) != len(ids) or any(eid not in candidates for eid in ids):
            raise ValueError("Select unique evidence IDs belonging to this measure and packet")
        selection["evidence"] = [{key: candidates[eid][key] for key in ("snapshot_id", "locator", "quote")}
                                 for eid in ids]
        findings.append(selection)
    return persist(packet_id, findings, root, output, save)


def persist(packet_id, findings, root, output, save):
    packet = json.loads((output / "cross-document-packets" / (identifier(packet_id) + ".json")).read_text(encoding="utf-8"))
    if not isinstance(findings, list) or len(findings) != len(MEASURES):
        raise ValueError("Exactly five findings are required")
    if not all(isinstance(f, dict) for f in findings) or {f.get("measure_id") for f in findings} != set(MEASURES):
        raise ValueError("Findings must cover each measure exactly once: " + ", ".join(MEASURES))
    schema = json.loads((root / "schemas/live-audit-v1.schema.json").read_text(encoding="utf-8"))
    validator = Draft202012Validator({"$ref": "#/$defs/finding", "$defs": schema["$defs"]})
    # The existing schema calls the per-measure definition 'finding'.
    sources, unavailable = load_sources(packet["hospital_key"], packet["extraction_id"], output)
    for finding in findings:
        validator.validate(finding)
        if packet["candidates"].get(finding["measure_id"]) and not finding["evidence"]:
            raise ValueError("Cite available evidence even when the conclusion is unclear")
        if len(finding["explanation"]) > 5000 or len(finding["evidence"]) > 12:
            raise ValueError("Finding exceeds size limits")
        if finding["result"] in {"yes", "n_a"}:
            raise ValueError("Partial keyword review cannot certify a global pass or rubric exemption; use unclear")
        if finding["measure_id"].endswith("primary_service_area_boundaries_compliant") and finding["result"] != "unclear":
            raise ValueError("PSA rule is not approved in this pilot; use unclear")
        for citation in finding["evidence"]:
            quote = citation["quote"]
            if len(quote.strip()) < 15 or len(quote) > 3000:
                raise ValueError("Quote must contain 15 to 3000 characters")
            if not any(s["snapshot"]["snapshot_id"] == citation["snapshot_id"] and
                       any(p["locator"] == citation["locator"] and quote in p["text"] for p in s["segments"])
                       for s in sources):
                raise ValueError("Citation does not resolve to the verified source page")
        if finding["result"] == "no" and finding["measure_id"].endswith("consistent_across_documents"):
            if len({c["snapshot_id"] for c in finding["evidence"]}) < 2:
                raise ValueError("Inconsistency requires two distinct document snapshots")
    checked_at = now()
    review_id = uuid.uuid4().hex
    result = dict(schema_version="1.0", review_id=review_id, status="draft_needs_human_review",
                  hospital_key=packet["hospital_key"], packet_id=packet_id,
                  extraction_id=packet["extraction_id"], checked_at=checked_at,
                  findings=findings, snapshots=[s["snapshot"] for s in sources],
                  unavailable=unavailable, limitations=packet["limitations"])
    path = output / "cross-document-reviews" / packet["hospital_key"] / (review_id + ".json")
    save(path, json.dumps(result, indent=2, ensure_ascii=False).encode("utf-8"))
    report = "Draft cross-document findings (human review required):\n" + "\n".join(
        f"{f['measure_id']}: {f['result']} — {f['explanation']}" for f in findings)
    return dict(report=report + f"\nSaved review: {path}\nNo grade or last-successful assessment date was updated.", review_file=str(path))
