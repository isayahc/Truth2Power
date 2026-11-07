"""Read-only Bassett discovery and evidence verification for the Little Falls pilot."""
from __future__ import annotations

import asyncio
import hashlib
import io
import json
import os
import re
import tempfile
import uuid
import zipfile
from datetime import datetime, timezone
from pathlib import Path
from typing import Any
from urllib.parse import urlsplit
from urllib.request import HTTPRedirectHandler, Request, build_opener
from xml.etree import ElementTree as ET

from mcp.server.fastmcp import FastMCP
from playwright.async_api import async_playwright
from pypdf import PdfReader

ROOT = Path(__file__).resolve().parents[2]
DATA = Path(os.environ.get("AUDIT_DIR", ROOT / ".audit")).resolve() / "live"
LIMIT = 12 * 1024 * 1024
W = {"w": "http://schemas.openxmlformats.org/wordprocessingml/2006/main"}
REFERENCE = ("https://aspe.hhs.gov/topics/poverty-economic-mobility/poverty-guidelines/"
             "prior-hhs-poverty-guidelines-federal-register-references/2026-poverty-guidelines-computations")
ONE_PERSON_2026_ANNUAL_GUIDELINE = 15_960
mcp = FastMCP("Truth2Power")


def now() -> str:
    """Return an ISO timestamp suitable for the live audit schema."""
    return datetime.now(timezone.utc).isoformat()


def approved(url: str) -> str:
    """Allow HTTPS fetches on the hospital system's public host."""
    p = urlsplit(url)
    if p.scheme != "https" or p.netloc.lower() != "www.bassett.org":
        raise ValueError("Only the official Bassett HTTPS host is supported.")
    return url


class HospitalRedirect(HTTPRedirectHandler):
    """Apply the same host policy to each redirect."""

    def redirect_request(self, req: Request, fp: Any, code: int, msg: str,
                         headers: Any, newurl: str) -> Request | None:
        """Validate the redirect destination before fetching it."""
        return super().redirect_request(req, fp, code, msg, headers, approved(newurl))


def save(path: Path, data: bytes) -> None:
    """Publish a complete local artifact atomically."""
    path.parent.mkdir(parents=True, exist_ok=True)
    with tempfile.NamedTemporaryFile(dir=path.parent, delete=False) as out:
        out.write(data)
    os.replace(out.name, path)


def fetch(url: str, kind: str, suffix: str) -> tuple[dict, bytes]:
    """Download and preserve the exact bytes and final source URL."""
    req = Request(approved(url), headers={"User-Agent": "Truth2Power public hospital audit"})
    with build_opener(HospitalRedirect()).open(req, timeout=25) as res:
        data = res.read(LIMIT + 1)
        final_url = approved(res.geturl())
    if len(data) > LIMIT:
        raise ValueError("Source exceeds snapshot size limit.")
    digest = hashlib.sha256(data).hexdigest()
    path = Path("snapshots") / (digest + suffix)
    save(DATA / path, data)
    return dict(snapshot_id=digest, document_type=kind, url=final_url, retrieved_at=now(),
                publisher_updated_at=None, sha256=digest, artifact_path=path.as_posix()), data


@mcp.tool()
async def discover_little_falls() -> dict:
    """Open the roster's landing page and return labeled application and policy links plus a discovery ID."""
    roster = json.loads((ROOT / "data/maps/hospitals.geojson").read_text(encoding="utf-8"))
    site = next(f for f in roster["features"] if f["id"] == "362")
    snapshot, html = await asyncio.to_thread(fetch, site["properties"]["assistance_url"], "landing_page", ".html")
    async with async_playwright() as pw:
        browser = await pw.chromium.launch(executable_path=os.environ.get("CHROMIUM_PATH") or None)
        try:
            page = await browser.new_page(java_script_enabled=False, service_workers="block")
            # Render only the fetched landing page. Remote scripts and subresources are unnecessary.
            async def render(route: Any) -> None:
                if route.request.is_navigation_request() and route.request.url == snapshot["url"]:
                    await route.fulfill(content_type="text/html", body=html)
                else:
                    await route.abort()
            await page.route("**/*", render)
            await page.goto(snapshot["url"])
            anchors = await page.locator("a[href]").evaluate_all(
                "(links) => links.map(a => ({label: a.innerText.trim(), url: a.href}))")
        finally:
            await browser.close()
    links = [a for a in anchors if urlsplit(a["url"]).netloc.lower() == "www.bassett.org"
             and re.search("financial assistance|charity care", a["label"], re.I)]
    discovery = dict(id=uuid.uuid4().hex, snapshot=snapshot, links=links)
    save(DATA / "discoveries" / (discovery["id"] + ".json"), json.dumps(discovery).encode())
    return discovery


def fpl_row(data: bytes) -> dict | None:
    """Find an unambiguous one-person amount under the 400% column of an FPL table."""
    with zipfile.ZipFile(io.BytesIO(data)) as archive:
        info = archive.getinfo("word/document.xml")
        if info.file_size > LIMIT:
            raise ValueError("DOCX main part exceeds size limit.")
        root = ET.fromstring(archive.read(info))
    matches = []
    for table_no, table in enumerate(root.findall(".//w:tbl", W), 1):
        rows = [["".join(t.text or "" for t in c.findall(".//w:t", W)).strip()
                 for c in r.findall("w:tc", W)] for r in table.findall("w:tr", W)]
        if not any(re.search("federal poverty|\\bFPL\\b", " ".join(r), re.I) for r in rows):
            continue
        if any(re.search(r"\bmonth(?:ly)?\b", cell, re.I) for row in rows for cell in row):
            continue
        column = None
        for row_no, row in enumerate(rows, 1):
            normalized = [re.sub(r"\s+", "", c).lower() for c in row]
            if "householdsize" in normalized:
                header = {"quote": " | ".join(row), "locator": f"table {table_no}, row {row_no} (column headings)"}
                column = normalized.index("400%") if normalized.count("400%") == 1 else None
                continue
            if column is None or len(row) <= column or not re.fullmatch(r"1(?:\s+person)?",row[0],re.I):
                continue
            amount = re.fullmatch(r"\$\s*(\d{1,3}(?:,\d{3})+|\d+)(?:\.00)?",row[column])
            if amount:
                matches.append(dict(header=header, amount=int(amount[1].replace(",","")),quote=" | ".join(row),
                                    locator=f"table {table_no}, row {row_no}, column {column+1} (400%)"))
    return matches[0] if len(matches) == 1 else None


@mcp.tool()
def verify_little_falls(discovery_id: str, application_url: str, policy_url: str) -> dict:
    """Verify a discovered English DOCX and its campus policy PDF; persist a schema-v1 numeric finding."""
    if not re.fullmatch("[0-9a-f]{32}", discovery_id):
        raise ValueError("Invalid discovery ID.")
    discovery = json.loads((DATA / "discoveries" / (discovery_id + ".json")).read_text())
    for url, term in [(application_url, "application"), (policy_url, "charity care")]:
        if not any(a["url"] == url and term in a["label"].lower() and "english" in a["label"].lower()
                   for a in discovery["links"]):
            raise ValueError("Select the matching English document from the saved landing page.")
    started = now()
    app, docx = fetch(application_url, "application", ".docx")
    policy, pdf = fetch(policy_url, "policy_statement", ".pdf")
    reader = PdfReader(io.BytesIO(pdf))
    scope = None
    for n,p in enumerate(reader.pages,1):
        for line in (p.extract_text() or "").splitlines():
            if re.fullmatch(r"\s*☒\s*Little Falls Hospital\s*",line,re.I):
                scope = dict(snapshot_id=policy["sha256"], locator=f"page {n}", quote=line.strip())
                break
        if scope: break
    row = fpl_row(docx)
    evidence = ([scope] if scope else []) + ([dict(snapshot_id=app["sha256"], locator=row["locator"], quote=row["quote"])] if row else [])
    if row:
        evidence.append(dict(snapshot_id=app["sha256"], **row["header"]))
    expected = dict(household_size=1, fpl_percent=400, currency="USD", period="annual",
                    amount=4 * ONE_PERSON_2026_ANNUAL_GUIDELINE)
    result = "unclear" if not (scope and row) else "yes" if row["amount"] == expected["amount"] else "no"
    campus_line = (f"{scope['locator']}: {scope['quote']}" if scope
                   else "Campus applicability requires review.")
    observed_line = (f"{row['locator']}: {row['quote']} (observed annual amount ${row['amount']:,})."
                     if row else "No unambiguous one-person 400% row was verified.")
    explanation = "\n".join([
        f"Campus applicability — Bassett policy PDF, {campus_line} {policy['url']}",
        f"Published amount — English application DOCX, {observed_line} {app['url']}",
        f"Expected amount — 2026 HHS guideline for one person in New York: "
        f"${ONE_PERSON_2026_ANNUAL_GUIDELINE:,} × 4 = ${expected['amount']:,} annually. {REFERENCE}",
        f"Result for the one-person 400% FPL cell: {result}.",
    ])
    finding = dict(measure_id="application.fpl_guidelines",result=result,
                   reason_code={"yes":"condition_met","no":"contradicted","unclear":"insufficient_evidence"}[result],
                   observed=(expected | {"amount":row["amount"]}) if row else None,expected=expected,evidence=evidence,
                   explanation=explanation)
    completed, audit_id = now(), uuid.uuid4().hex
    output = dict(schema_version="1.0",hospital_key="362",rubric_version="live-fpl-one-cell-v1",
                  reference_version="hhs-2026-contiguous-us",guideline_year=2026,
                  attempt=dict(attempt_id=audit_id,attempted_at=started,status="completed"),
                  last_successful_assessment_at=completed,snapshots=[discovery["snapshot"],app,policy],
                  assessment=dict(assessment_id=audit_id,completed_at=completed,findings=[finding]))
    path = DATA / "assessments" / (audit_id + ".json")
    save(path,json.dumps(output,indent=2,ensure_ascii=False).encode())
    return dict(report=explanation + f"\nSaved assessment: {path}", assessment_file=str(path),
                reference_url=REFERENCE, output=output)


if __name__ == "__main__":
    mcp.run()
