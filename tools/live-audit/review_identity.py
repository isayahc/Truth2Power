"""Identity metadata for immutable draft artifacts. The inbox derives grouping keys."""
import json
from pathlib import Path

INVENTORY = Path(__file__).resolve().parents[2] / "docs/audit-format/wave-one-document-inventory.json"


def application_language(hospital_key: str, snapshot: dict, profile_reviewed: bool) -> str:
    """Use a content-confirmed inventory label only for its exact hospital, role and bytes."""
    inventory = json.loads(INVENTORY.read_text(encoding="utf-8"))
    labels = {doc["language_label"] for hospital in inventory["hospitals"] if hospital["hospital_key"] == hospital_key
              for doc in hospital["documents"] if doc.get("sha256") == snapshot["sha256"]
              and doc["type"] == "application" and doc["status"] == "content_confirmed"}
    if len(labels) == 1:
        return labels.pop()
    return "English" if profile_reviewed else "unknown"


def review_identity(scope: str, sources: list[tuple[dict, str]]) -> dict:
    """Link the reviewed hospital documents to their original URLs, roles and byte digests."""
    return {"version": 1, "scope": scope, "documents": [
        {"url": snapshot["url"], "role": snapshot["document_type"], "language": language,
         "snapshot_sha256": snapshot["sha256"]} for snapshot, language in sources]}
