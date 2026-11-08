"""Reproducible text alignment with a pinned official NYS form; not equivalence approval."""
import difflib
import hashlib
import re
import uuid

from cross_documents import load_sources
from documents import now
from extraction import extract_bytes
from full_review import json_save
from playwright.sync_api import sync_playwright
from documents import LIMIT

REFERENCE_URL = "https://www.health.ny.gov/facilities/hospital/financial_assist/hosp_info/docs/2026_uniform_financial_assistance_application.docx"
AUTHORITY_URL = "https://www.health.ny.gov/facilities/hospital/financial_assist/hosp_info/"


def fetch_reference(url, host):
    """Use the installed browser's HTTPS request stack for this fixed public source."""
    if url != REFERENCE_URL or host != "health.ny.gov":
        raise ValueError("Unapproved reference")
    with sync_playwright() as playwright:
        request = playwright.request.new_context()
        try:
            response = request.get(url, timeout=30000, max_redirects=0)
            if response.status != 200:
                raise ValueError(f"Official reference retrieval failed: HTTP {response.status}")
            if int(response.headers.get("content-length", "0")) > LIMIT:
                raise ValueError("Reference exceeds size limit")
            data = response.body()
            if len(data) > LIMIT:
                raise ValueError("Reference exceeds size limit")
            return data, response.url, response.headers.get("content-type", "")
        finally:
            request.dispose()


def units(source, prefix):
    result = []
    for segment in source["segments"]:
        for line in segment["text"].splitlines():
            if line.strip():
                result.append(dict(evidence_id=f"{prefix}-{len(result) + 1}", snapshot_id=source["snapshot"]["snapshot_id"],
                                   locator=segment["locator"], quote=line))
    return result


def align(reference, application):
    # Line breaks and hospital customizations create differences too. Never grade from similarity.
    normalize = lambda s: re.sub(r"\s+", " ", s).strip().casefold()
    left, right = units(reference, "reference"), units(application, "application")
    matcher = difflib.SequenceMatcher(a=[normalize(e["quote"]) for e in left], b=[normalize(e["quote"]) for e in right], autojunk=False)
    blocks = [dict(operation=op, reference_evidence_ids=[e["evidence_id"] for e in left[a:b]],
                   application_evidence_ids=[e["evidence_id"] for e in right[c:d]])
              for op, a, b, c, d in matcher.get_opcodes()]
    return dict(reference_evidence=left, application_evidence=right, alignment=blocks,
                changed_blocks=sum(b["operation"] != "equal" for b in blocks))


def compare_template(hospital_key, extraction_id, application_url, output, save, fetch=fetch_reference):
    sources, gaps = load_sources(hospital_key, extraction_id, output)
    selected = [s for s in sources if s["snapshot"]["url"] == application_url and s["snapshot"]["document_type"] == "application"]
    if len(selected) != 1:
        raise ValueError("Select one saved application, not a policy or summary")
    data, final_url, mime = fetch(REFERENCE_URL, "health.ny.gov")
    if final_url != REFERENCE_URL:
        raise ValueError("Official reference redirect needs version review")
    segments = extract_bytes(data, ".docx")
    digest = hashlib.sha256(data).hexdigest()
    relative = f"snapshots/{digest}.docx"
    save(output / relative, data)
    reference = dict(snapshot=dict(snapshot_id=digest, sha256=digest, artifact_path=relative,
        url=final_url, document_type="supplement", retrieved_at=now(), publisher_updated_at=None), segments=segments)
    comparison_id = uuid.uuid4().hex
    packet = dict(comparison_id=comparison_id, hospital_key=hospital_key, extraction_id=extraction_id,
        application_url=application_url, reference_url=REFERENCE_URL, reference_version="NYS-2026-English",
        authority_url=AUTHORITY_URL, checked_at=now(), status="text_alignment_needs_human_review",
        human_review="pending", uniform_application_result="unclear",
        snapshots=[selected[0]["snapshot"], reference["snapshot"]],
        source_segments=selected[0]["segments"], reference_segments=segments, collection_gaps=gaps,
        limitations=["Alignment is not a determination of entire-form equivalence or legal compliance.",
                     "PDF line wrapping, DOCX table cells and hospital customization can produce text differences.",
                     "DOCX body extraction does not verify rendered pagination, graphics or content in other parts.",
                     "Review required content and permitted customizations against official guidance; no draft is promoted."],
        **align(reference, selected[0]))
    path = output / "template-comparisons" / f"{comparison_id}.json"
    json_save(path, packet, save)
    return dict(result_file=str(path), **packet)
