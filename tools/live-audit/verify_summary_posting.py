"""Replay the Little Falls summary posting reassessment against the saved discovery chain."""
import argparse
import hashlib
import json
from datetime import datetime, timezone
from html.parser import HTMLParser
from pathlib import Path
from urllib.parse import urljoin, urldefrag

from documents import Links
from posting import verified_snapshot
from verify_summaries import verify

ROOT = Path(__file__).resolve().parents[2]
DOCS = ROOT / "docs/audit-format"
MEASURE = "posted_materials.policy_summary_posted"


class PageAnchors(HTMLParser):
    """Collect actual href targets including child HTML pages."""
    def __init__(self, url: str) -> None:
        super().__init__()
        self.url = url
        self.targets: dict[str, str] = {}

    def handle_starttag(self, tag: str, attrs: list[tuple[str, str | None]]) -> None:
        """Resolve a link using the saved landing URL."""
        href = dict(attrs).get("href")
        if tag == "a" and href:
            self.targets[urldefrag(urljoin(self.url, href))[0]] = href


def reassess(root: Path, assessed_at: str) -> dict:
    """Verify the parent anchor, both PDF links and the designated titles and campus quotes."""
    previous = json.loads((DOCS / "posting/362.json").read_bytes())
    summaries = json.loads((DOCS / "summaries/362.json").read_bytes())
    review = json.loads((DOCS / "summaries/review.json").read_bytes())
    older = next(f for f in previous["assessment"]["findings"] if f["measure_id"] == MEASURE)
    if previous["hospital_key"] != "362" or summaries["hospital_key"] != "362" or older["result"] != "unclear":
        raise ValueError("Unexpected prior posting or summary scope")
    verify(summaries, review, root)
    if datetime.fromisoformat(assessed_at) < datetime.fromisoformat(review["checked_at"]):
        raise ValueError("Reassessment predates its source review")
    discovery = review["discovery"]
    parent = next(s for s in previous["snapshots"] if s["sha256"] == discovery["discovery_parent_sha256"])
    child_record, *targets = discovery["records"]
    _, raw = verified_snapshot(root, parent, "landing_page")
    anchors = PageAnchors(parent["url"])
    anchors.feed(raw.decode())
    if discovery["hospital_key"] != "362" or child_record["url"] not in anchors.targets:
        raise ValueError("Missing campus discovery anchor")
    child, raw = verified_snapshot(root, child_record, "landing_page")
    links = Links(child["url"])
    links.feed(raw.decode())
    evidence = [dict(snapshot_id=parent["snapshot_id"], locator="anchor href", quote=anchors.targets[child["url"]])]
    docs = {s["sha256"]: s for s in summaries["snapshots"]}
    if {t["sha256"] for t in targets} != set(docs):
        raise ValueError("Mismatched discovery documents")
    for target in targets:
        if docs[target["sha256"]]["url"] != target["url"] or not links.links.get(target["url"]):
            raise ValueError("Missing designated PDF link")
        evidence.append(dict(snapshot_id=child["snapshot_id"], locator="link " + target["url"], quote=links.links[target["url"]][0]))
    for doc in review["hospitals"]["362"]["documents"]:
        evidence.extend([doc["title_evidence"], doc["campus_evidence"]])
    finding = dict(measure_id=MEASURE,result="yes",reason_code="condition_met",
                   explanation="The saved roster page links to a designated summary page. Its English and Spanish summaries explicitly include Little Falls Hospital.",
                   observed=dict(languages=["English","Spanish"],discovery_page=child["url"],
                                 prior_posting_assessment_id=previous["assessment"]["assessment_id"],
                                 summary_review_assessment_id=summaries["assessment"]["assessment_id"]),
                   expected=dict(document_type="policy_summary"),evidence=evidence)
    identity = hashlib.sha256(json.dumps([assessed_at,finding,review["review_id"]], sort_keys=True).encode()).hexdigest()
    return dict(schema_version="1.0",hospital_key="362",rubric_version="wave-one-summary-discovery-v1",
                reference_version=review["review_id"],guideline_year=2026,review_date=assessed_at[:10],
                attempt=dict(attempt_id=identity,attempted_at=assessed_at,status="completed"),
                last_successful_assessment_at=assessed_at,snapshots=[parent,child,*docs.values()],
                assessment=dict(assessment_id="posting-"+identity,completed_at=assessed_at,findings=[finding]))


if __name__ == "__main__":
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--root", required=True, type=Path)
    parser.add_argument("--assessed-at", default=datetime.now(timezone.utc).isoformat())
    args = parser.parse_args()
    print(json.dumps(reassess(args.root, args.assessed_at), indent=2, ensure_ascii=False))
