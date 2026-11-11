"""Source-level review of captured hospital pages and documents, without network access."""
from functools import lru_cache
import json
from pathlib import Path
import re
from typing import Any

from language_profiles import SPEC

ROOT = Path(__file__).resolve().parents[2]
RUBRIC = json.loads((ROOT / "rubrics/css-17-v1.json").read_bytes())
# Locate candidate passages. These signals never decide a compliance result.
TOPICS = {
    "consistency": r"eligib|income|installment|descuento",
    "service_area": r"service area|counties|county|área de servicio",
    "deadline": r"deadline|within \d+ days|time limit|plazo",
    "assets": r"\bassets?\b|bank account|activos",
    "immigration": r"immigration|citizenship|undocumented|inmigra",
    "uniform": r"uniform.{0,35}application|solicitud uniforme",
    "contact": r"contact|call.{0,40}\d|phone|teléfono",
    "tables": r"discount rate|household size|descuento",
    "fpl": r"poverty (?:level|guideline)|\bFPL\b|nivel de pobreza",
    "maximum": r"\d{2,3}\s*%.{0,60}(?:poverty|FPL)|nivel de pobreza",
    "installments": r"installment|monthly payment|pagos mensuales",
    "summary_area": r"service area|counties|county|área de servicio",
    "summary_process": r"how to apply|submit.{0,50}application|cómo solicitar",
    "summary_income": r"household income|poverty level|nivel de pobreza",
}
ROLE_SIGNALS = {
    "policy_summary": r"plain.language summary|financial assistance policy summary",
    "application": r"financial assistance application|application for financial assistance|\bapplication form\b",
    "policy_statement": r"financial assistance policy(?!\s+summary)",
}
DATE_SIGNAL = r"(?:effective(?: date)?|revised|updated)\s*[:\-]?\s*(?:\d[\d./-]{3,9}|[A-Za-z]{3,9} \d{1,2},? \d{4})"


@lru_cache(maxsize=1)
def campus_names() -> tuple[str, ...]:
    """Load public facility names from roster data once per worker."""
    return tuple(sorted(set(roster_names().values())))


def excerpts(parts: list[dict], pattern: str, limit: int = 4) -> tuple[list[dict], bool]:
    """Return located verbatim excerpts and indicate when additional matches exist."""
    found = []
    matcher = re.compile(pattern, re.I)
    for part in parts:
        for hit in matcher.finditer(part["text"]):
            text = part["text"]
            quote = text[max(0, hit.start()-80):hit.end()+120].strip()
            item = {"locator": part["locator"], "quote": quote}
            if item in found:
                continue
            if len(found) == limit:
                return found, True
            found.append(item)
    return found, False


def review_source(source: dict, segments: list[dict], website: bool) -> dict[str, Any]:
    """Prepare auditable source observations; uncertain identity stays explicit."""
    parts = [s for s in segments if s["status"] == "extracted" and not s["locator"].startswith("link ")]
    content = "\n".join(s["text"] for s in parts)
    folded = content.casefold()
    roles = {}
    for role, signal in ROLE_SIGNALS.items():
        hits, _ = excerpts(parts, signal, 1)
        if hits:
            roles[role] = hits[0]
    languages = {}
    for lang, spec in SPEC["languages"].items():
        hits, _ = excerpts(parts, spec["title"], 1)
        if hits:
            languages[lang] = hits[0]
            roles.setdefault("application", hits[0])
    role = source["role"]
    observations = {}
    limited = []
    for measure in RUBRIC["measures"]:
        evaluator = measure["evaluator"]
        if evaluator == "posting":
            target_roles = measure["expected"]["any_accessible_role"]
            signals = [ROLE_SIGNALS[r] for r in target_roles if r in ROLE_SIGNALS]
            signal = "|".join(signals)
            search = [s for s in segments if s["locator"].startswith("link ")] if website else parts
        else:
            if role != "unclassified" and role not in measure["roles"]:
                continue
            signal = TOPICS.get(evaluator)
            search = parts
        if signal:
            hits, more = excerpts(search, signal)
            if hits and evaluator == "posting" and website:
                # Anchor locators are resolved from the snapshot and retain the target
                # even when the document itself could not be retrieved.
                hits = [dict(hit, target_url=hit["locator"][5:]) for hit in hits]
            if hits:
                observations[measure["measure_id"]] = hits
            if more:
                limited.append(measure["measure_id"])
    dates, dates_limited = excerpts(parts, DATE_SIGNAL)
    named = [name for name in campus_names() if name.casefold() in folded]
    campus_evidence = {}
    for name in named:
        hits, _ = excerpts(parts, re.escape(name), 1)
        if hits:
            campus_evidence[name] = hits[0]
    return {
        "schema_version": "source-review-v1",
        "worker": "website_reviewer" if website else "document_analyst",
        "source_id": source["source_id"], "sha256": source["snapshot"]["sha256"],
        "role_candidates": roles, "language_candidates": languages,
        "campus_mentions": campus_evidence,
        "date_passages": dates, "additional_date_matches": dates_limited,
        "observations": observations, "additional_matches": limited,
        "unreadable": [{"locator": s["locator"], "reason": s.get("reason") or "unreadable"}
                       for s in segments if s["status"] != "extracted"],
    }


def explicit_identity(parts: list[dict], hospital_key: str) -> dict | None:
    """Identify titled documents explicitly scoped to the roster facility in the original text."""
    if not parts or any(p["status"] != "extracted" for p in parts):
        return None
    facility = roster_names().get(hospital_key)
    if not facility:
        return None
    titles = {
        "financial assistance policy summary": "policy_summary",
        "plain language summary of the financial assistance policy": "policy_summary",
        "financial assistance policy": "policy_statement",
        "financial assistance application": "application",
        "nys uniform hospital financial assistance application": "application",
    }
    lines = [(p["locator"], line.strip()) for p in parts for line in p["text"].splitlines() if line.strip()]
    # Restrict document identity to a title, never infer it from a reference in the body.
    headings = [(titles[line.casefold()], loc, line) for loc, line in lines[:4] if line.casefold() in titles]
    scope = [(loc, line) for loc, line in lines if re.match(r"^applies to\b", line, re.I)]
    if len(headings) != 1 or len(scope) != 1:
        return None
    if scope[0][1].casefold().rstrip(".") != "applies to " + facility.casefold().rstrip("."):
        return None
    body = "\n".join(line for _, line in lines).casefold()
    if any(name.casefold() in body and name.casefold() not in facility.casefold() for name in campus_names()):
        return None
    if re.search(r"\b(?:excludes?|excluding|except(?:ion)?|does not apply|superseded|sample|draft)\b", body):
        return None
    role, locator, title = headings[0]
    # A title in English cannot establish the language of the entire form.
    return dict(role=role, language="und", hospital_key=hospital_key, locator=locator, quote=title,
                applicability=dict(locator=scope[0][0], quote=scope[0][1]))


@lru_cache(maxsize=1)
def roster_names() -> dict[str, str]:
    """Resolve an audit's roster identifier to the published facility name."""
    features = json.loads((ROOT / "data/maps/hospitals.geojson").read_bytes())["features"]
    return {str(f["id"]): f["properties"]["name"] for f in features}
