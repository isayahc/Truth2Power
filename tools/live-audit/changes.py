"""Read-only material changes derived from saved campus-scoped collection manifests."""
import argparse
import hashlib
import json
import re
from datetime import datetime
from functools import lru_cache
from itertools import groupby
from pathlib import Path
from urllib.parse import urlsplit

from documents import Links
from verify_summary_posting import PageAnchors
from extraction import extract_bytes
from posting import ROOT, verified_snapshot

DOCS = ROOT / "docs/audit-format"
S = "posted_materials.policy_summary_posted"
POSTED = {"application": "posted_materials.application_posted", "policy_statement": "posted_materials.policy_statement_posted",
          "policy_summary": S}
ROSTER = {str(f["id"]): f["properties"] for f in json.loads((ROOT / "data/maps/hospitals.geojson").read_bytes())["features"]}
INVENTORY = {h["hospital_key"]: {d["sha256"]: d["type"] for d in h["documents"] if d.get("status") == "content_confirmed"}
             for h in json.loads((DOCS / "wave-one-document-inventory.json").read_bytes())["hospitals"]}
# Locate potentially affected checks. The comparison itself never assigns a compliance outcome.
TERMS = {
    "application.fpl_guidelines": r"poverty|pobreza|\bfpl\b",
    "application.contact_information": r"contact|telephone|phone",
    "application.installments_cap": r"installment|gross monthly",
    "posted_materials.no_submission_time_limit": r"deadline|plazo",
    "posted_materials.no_evidence_of_asset_checks": r"asset test|asset check",
    "policy_summary.means_of_applying_explained": r"how to apply|cómo solicitar",
}
RUBRIC = {m["measure_id"]: m for m in json.loads((ROOT / "rubrics/css-17-v1.json").read_bytes())["measures"]}
AID = re.compile(r"financial assistance|asistencia financiera|application|solicitud|discount|descuento|eligib|poverty|pobreza|\bfpl\b|income|ingreso|deadline|installment|charity care", re.I)


def instant(value: str) -> datetime:
    """Accept only dates that identify an instant."""
    date = datetime.fromisoformat(value.replace("Z","+00:00"))
    if date.tzinfo is None:
        raise ValueError("Timezone missing")
    return date


def side(record: dict, excerpt: str, locator: str) -> dict:
    """Retain the URL, byte identity and separate publisher/retrieval dates for one observation."""
    return {**{k: record.get(k) for k in ("url", "sha256", "retrieved_at", "publisher_updated_at", "artifact_path")},
            "excerpt": excerpt, "locator": locator}


def event(key: str, kind: str, detected: str, before: dict, after: dict, measures: list[str], description: str) -> dict:
    """Identify an observed transition reproducibly, including later reversion transitions."""
    identity = [key, kind, detected, before["url"], before["sha256"], after["url"], after["sha256"]]
    return dict(id=hashlib.sha256(json.dumps(identity).encode()).hexdigest(), hospital_key=key, kind=kind,
                detected_at=detected, before=before, after=after, measures=sorted(set(measures)), description=description)


def discovery_event() -> dict:
    """Join the two immutable posting assessments for the newly verified summary."""
    earlier_bytes = (DOCS / "posting/362.json").read_bytes()
    later_bytes = (DOCS / "changes/362-summary-posting.json").read_bytes()
    older, newer = json.loads(earlier_bytes), json.loads(later_bytes)
    def cited(a: dict, index: int, raw: bytes) -> dict:
        """Resolve one finding citation through its own assessment."""
        f = next(f for f in a["assessment"]["findings"] if f["measure_id"] == S)
        c = f["evidence"][index]
        snapshot = next(s for s in a["snapshots"] if s["snapshot_id"] == c["snapshot_id"])
        return dict(side(snapshot,c["quote"],c["locator"]),result=f["result"],assessment_id=a["assessment"]["assessment_id"],
                    assessment_url="/api/changes/assessments/"+hashlib.sha256(raw).hexdigest())
    later = next(i for i,c in enumerate(newer["assessment"]["findings"][0]["evidence"]) if "Little Falls Hospital" in c["quote"])
    return event("362","newly_verified",newer["assessment"]["completed_at"],cited(older,0,earlier_bytes),cited(newer,later,later_bytes),[S],
                 "Newly verified by the audit: the designated summary page links to English and Spanish summaries covering Little Falls.")


def excerpt_pair(old: str, new: str) -> tuple[int, str, str]:
    """Show a short window around the first differing word in each extracted text."""
    left, right = old.split(), new.split()
    start = next((i for i,(a,b) in enumerate(zip(left,right)) if a != b), min(len(left),len(right)))
    snippets = [" ".join(words[max(0,start-8):start+18])[:500] or "(no matching text)" for words in (left,right)]
    return start, snippets[0], snippets[1]


def recent_changes(root: Path, include_discovery: bool = True) -> dict:
    """Compare consecutive successful captures by hospital and logical URL; skip failed observations."""
    timeline: dict = {}
    warnings: set[str] = set()
    events = [discovery_event()] if include_discovery else []

    def validated(record: dict, key: str, logical: str, landing: bool, roles: dict) -> tuple:
        """Index saved observations with well-formed, host-scoped provenance."""
        url = urlsplit(record["url"])
        allowed = urlsplit(ROSTER[key]["assistance_url"]).hostname.removeprefix("www.")
        for u in (url, urlsplit(logical)):
            if u.scheme != "https" or u.hostname not in (allowed, "www."+allowed) or u.username or u.password:
                raise ValueError("URL outside collection scope")
        instant(record["retrieved_at"])
        if not re.fullmatch(r"[0-9a-f]{64}", record["sha256"]):
            raise ValueError("Invalid hash")
        return (key,logical,landing), (record,roles)

    directory = root / "collections"
    for path in sorted(directory.glob("*/*.json")):
        key = path.parent.name
        try:
            if key not in ROSTER or not path.resolve().is_relative_to(directory.resolve()) or not path.resolve().is_relative_to(root.resolve()) or path.stat().st_size > 4_000_000:
                raise ValueError("Invalid collection path")
            a = json.loads(path.read_bytes())
            if a["hospital_key"] != key or a["landing_url"] != ROSTER[key]["assistance_url"]:
                raise ValueError("Collection identity mismatch")
            if a["status"] == "failed":
                continue
            if a["status"] not in ("partial","complete"):
                raise ValueError("Unknown collection status")
            saved = [d for d in a["documents"] if d["status"] == "saved"]
            roles = {d["source_url"]:INVENTORY.get(key,{}).get(d["sha256"]) for d in saved}
            batch = [validated(a["landing_page"],key,a["landing_url"],True,roles)]
            for d in saved:
                batch.append(validated(d,key,d["source_url"],False,roles))
            for identity, observation in batch:
                timeline.setdefault(identity,[]).append(observation)
        except (ValueError,KeyError,TypeError,OSError,AttributeError):
            warnings.add(f"Could not read all observations from {key}/{path.name}.")

    @lru_cache(maxsize=32)
    def material(path: str, digest: str, url: str, landing: bool) -> tuple[str, frozenset, list[tuple[int, str]]]:
        """Derive comparable visible text and direct document targets from verified original bytes."""
        metadata = dict(artifact_path=path,sha256=digest,url=url,retrieved_at=None,publisher_updated_at=None)
        _, raw = verified_snapshot(root,metadata,"landing_page" if landing else "supplement")
        parts = extract_bytes(raw,Path(path).suffix)
        if not parts or any(p["status"] != "extracted" for p in parts):
            raise ValueError("Incomplete extraction")
        text = []
        spans = []
        words = 0
        for part in parts:
            lines = part["text"].splitlines()
            if landing:
                lines = [line for line in lines if AID.search(line)]
            chunk = " ".join(" ".join(lines).split())
            if chunk:
                text.append(chunk)
                words += len(chunk.split())
                spans.append((words,part["locator"]))
        links: frozenset = frozenset()
        if landing:
            parser = Links(url)
            parser.feed(raw.decode("utf-8",errors="replace"))
            parser.close()
            pages = PageAnchors(url)
            pages.feed(raw.decode("utf-8",errors="replace"))
            pages.close()
            aid_pages = {u for u in pages.targets if urlsplit(u).scheme in ("http","https")
                         and AID.search(urlsplit(u).path.replace("-"," ").replace("_"," "))}
            links = frozenset(parser.links) | aid_pages
        return " ".join(text), links, spans

    for (key,logical,landing), observations in timeline.items():
        observations.sort(key=lambda x:instant(x[0]["retrieved_at"]))
        ordered = []
        for _, items in groupby(observations,key=lambda x:instant(x[0]["retrieved_at"])):
            same_time = list(items)
            if len({r["sha256"] for r,_ in same_time}) > 1:
                warnings.add(f"Conflicting snapshots at the same retrieval time for {key}: {logical}.")
                continue
            ordered.append(same_time[0])
        for (old,old_roles),(new,new_roles) in zip(ordered,ordered[1:]):
            if old["sha256"] == new["sha256"]:
                continue
            try:
                prev,pl,old_spans = material(old["artifact_path"],old["sha256"],old["url"],landing)
                curr,cl,new_spans = material(new["artifact_path"],new["sha256"],new["url"],landing)
                if prev == curr and pl == cl:
                    continue
                position,before,after = excerpt_pair(prev,curr)
                removed,added = sorted(pl-cl),sorted(cl-pl)
                measures = [POSTED[r] for url in removed+added if (r := new_roles.get(url) or old_roles.get(url)) in POSTED]
                if prev != curr:
                    role = "landing_page" if landing else new_roles.get(logical) or old_roles.get(logical)
                    if role in ("landing_page", "application", "policy_statement", "policy_summary"):
                        measures.append("posted_materials.consistent_across_documents")
                    for m, term in TERMS.items():
                        if role in RUBRIC[m]["roles"] and re.search(term,before+" "+after,re.I):
                            measures.append(m)
                def locator(spans: list[tuple[int, str]]) -> str:
                    """Locate the first difference, including insertions at end-of-source."""
                    return next((label for end,label in spans if position < end), spans[-1][1] if spans else "Saved HTML")
                earlier_locator, later_locator = locator(old_spans), locator(new_spans)
                if prev == curr:
                    before = ", ".join(removed) or "(target absent from earlier link set)"
                    after = ", ".join(added) or "(target absent from later link set)"
                    earlier_locator = later_locator = "Document and financial-assistance anchor targets"
                change = event(key,"material_changed",new["retrieved_at"],side(old,before,earlier_locator),side(new,after,later_locator),measures,
                               "Direct document links changed." if removed or added else "Published source text changed.")
                change.update(removed_links=removed,added_links=added,logical_url=logical)
                events.append(change)
            except Exception:  # A damaged PDF/DOCX must not suppress other verified transitions.
                warnings.add(f"Could not verify both snapshots for {key}: {logical}.")
    unique = {e["id"]:e for e in events}
    for e in unique.values():
        for evidence in (e["before"], e["after"]):
            path = Path(evidence["artifact_path"])
            evidence["saved_url"] = ("/api/changes/snapshots/" + path.name
                                     if (root/path).is_file() else None)
        e["hospital_name"] = ROSTER[e["hospital_key"]]["name"]
    return dict(events=sorted(unique.values(),key=lambda e:(instant(e["detected_at"]),e["id"]),reverse=True),
                warnings=sorted(warnings))


if __name__ == "__main__":
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--root", type=Path, required=True)
    print(json.dumps(recent_changes(parser.parse_args().root)))
