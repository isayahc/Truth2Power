"""Produce draft R/S/T findings from one saved Wave 1 direct-link collection."""
import argparse
import hashlib
import json
import re
from datetime import datetime, timezone
from pathlib import Path

from documents import LIMIT, Links
from extraction import extract_bytes

ROOT = Path(__file__).resolve().parents[2]
INVENTORY = ROOT / "docs/audit-format/wave-one-document-inventory.json"
REFERENCE = "wave-one-document-inventory-sha256:"


def verified_snapshot(root: Path, record: dict, role: str) -> tuple[dict, bytes]:
    """Verify the content-addressed path before exposing its metadata or original bytes."""
    digest = record["sha256"]
    relative = record["artifact_path"]
    allowed = [".html"] if role == "landing_page" else [".pdf", ".docx"]
    path = (root / relative).resolve()
    if (not re.fullmatch("[0-9a-f]{64}", digest) or path.suffix not in allowed
            or relative != f"snapshots/{digest}{path.suffix}" or not path.is_relative_to(root.resolve())
            or path.stat().st_size > LIMIT):
        raise ValueError("Invalid snapshot path or size")
    raw = path.read_bytes()
    if hashlib.sha256(raw).hexdigest() != digest:
        raise ValueError("Snapshot digest mismatch")
    snapshot = {k: record[k] for k in ("url", "sha256", "retrieved_at", "artifact_path", "publisher_updated_at")}
    snapshot.update(snapshot_id=hashlib.sha256((record["url"] + "|" + digest).encode()).hexdigest(), document_type=role)
    return snapshot, raw


def verify_role_excerpt(raw: bytes, snapshot: dict, classification: dict) -> None:
    """Locate the inventory quotation in the freshly extracted original document."""
    parts = extract_bytes(raw, Path(snapshot["artifact_path"]).suffix)
    if not any(p["locator"] == classification["locator"] and p["status"] == "extracted"
               and classification["quote"] in p["text"] for p in parts):
        raise ValueError("Pinned role excerpt differs from the original")


def assess(collection: dict, root: Path, inventory_bytes: bytes, landing_url: str, assessed_at: str) -> dict:
    """Join actual anchors to saved accessible targets and pinned, located role evidence."""
    key = collection["hospital_key"]
    hospital = next(h for h in json.loads(inventory_bytes)["hospitals"] if h["hospital_key"] == key)
    known = {d["sha256"]: d for d in hospital["documents"] if d.get("sha256")}
    if collection["landing_url"] != landing_url or collection["status"] not in ("complete", "partial"):
        raise ValueError("A successful roster landing capture is required")
    page, html = verified_snapshot(root, collection["landing_page"], "landing_page")
    if page["url"] != landing_url:
        raise ValueError("Landing redirect requires scope review")
    parser = Links(landing_url)
    parser.feed(html.decode("utf-8", errors="replace"))
    parser.close()
    records = {d["source_url"]: d for d in collection["documents"]}
    if len(records) != len(collection["documents"]) or set(records) != set(parser.links):
        raise ValueError("Collection and saved landing links differ")
    snapshots = [page]
    evidence = {r: [] for r in ("application", "policy_summary", "policy_statement")}
    gaps = []
    summary_candidates = []
    for url, labels in parser.links.items():
        record = records[url]
        classification = known.get(record.get("sha256"), {})
        if record["status"] != "saved":
            gaps.append({"url": url, "reason": record.get("http_status") or record.get("error_type", "retrieval_failed")})
            continue
        if record["url"] == url and classification.get("status") == "summary_scope_needs_review":
            target, raw = verified_snapshot(root, record, "supplement")
            verify_role_excerpt(raw, target, classification)
            snapshots.append(target)
            label = next((s for s in labels if s), None)
            if label:
                summary_candidates.append(dict(snapshot_id=page["snapshot_id"], locator="link " + url, quote=label))
            gaps.append(dict(url=url, reason="summary_scope_needs_review", snapshot_sha256=target["sha256"],
                             locator=classification["locator"], quote=classification["quote"], question=classification["question"]))
            continue
        if record["url"] != url or classification.get("status") != "content_confirmed":
            gaps.append({"url": url, "reason": classification.get("status", "target_or_role_requires_review")})
            continue
        role = classification["type"]
        if role not in evidence:
            continue
        target, raw = verified_snapshot(root, record, role)
        quote, locator = classification["quote"], classification["locator"]
        verify_role_excerpt(raw, target, classification)
        label = next((s for s in labels if s), None)
        if not label:
            gaps.append({"url": url, "reason": "unlabelled_link"})
            continue
        snapshots.append(target)
        evidence[role].extend([dict(snapshot_id=page["snapshot_id"], locator="link " + url, quote=label),
                               dict(snapshot_id=target["snapshot_id"], locator=locator, quote=quote)])
    findings = []
    for role, citations in evidence.items():
        links = [c["locator"][5:] for c in citations if c["snapshot_id"] == page["snapshot_id"]]
        findings.append(dict(measure_id=f"posted_materials.{role}_posted", result="yes" if links else "unclear",
            reason_code="condition_met" if links else "insufficient_evidence",
            explanation=f"Saved landing links resolve to content-confirmed {role} documents." if links else
            f"No designated {role} was verified in this direct-link capture. Review candidate documents and campus scope.",
            observed=dict(links=links, coverage_gaps=gaps), expected=dict(document_type=role), evidence=citations or (summary_candidates if role == "policy_summary" else [])))
    attempted = collection["attempted_at"]
    if datetime.fromisoformat(assessed_at) < datetime.fromisoformat(collection["completed_at"]):
        raise ValueError("Assessment precedes collection completion")
    ref = REFERENCE + hashlib.sha256(inventory_bytes).hexdigest()
    identity = hashlib.sha256(json.dumps([collection, ref, assessed_at], sort_keys=True).encode()).hexdigest()
    return dict(schema_version="1.0", hospital_key=key, rubric_version="wave-one-posting-v1", reference_version=ref,
                guideline_year=int(assessed_at[:4]), review_date=assessed_at[:10],
                attempt=dict(attempt_id=identity, attempted_at=attempted, status="completed"),
                last_successful_assessment_at=assessed_at, snapshots=snapshots,
                assessment=dict(assessment_id="posting-" + identity, completed_at=assessed_at, findings=findings))


def main() -> None:
    """Print one v1 draft envelope from a saved manifest without making network calls."""
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("manifest", type=Path)
    parser.add_argument("--root", required=True, type=Path)
    parser.add_argument("--assessed-at", default=datetime.now(timezone.utc).isoformat())
    args = parser.parse_args()
    collection = json.loads(args.manifest.read_bytes())
    roster = json.loads((ROOT / "data/maps/hospitals.geojson").read_bytes())
    url = next(f["properties"]["assistance_url"] for f in roster["features"] if str(f["id"]) == collection["hospital_key"])
    print(json.dumps(assess(collection, args.root, INVENTORY.read_bytes(), url, args.assessed_at), indent=2, ensure_ascii=False))


if __name__ == "__main__":
    main()
