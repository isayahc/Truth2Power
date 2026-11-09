# Wave 1 languages and PSA reporting (#25)

Open an Ellenville or Little Falls hospital record to see **Languages and service area — Informational, excluded from grade count**. The read-only API is `GET /api/hospitals/{hospital_key}/reporting-context` (also supports HEAD). Other hospitals return 404 and the UI says not yet assessed.

## Languages by document

Every individual document has a source link, language, language-identification status and a located source-language excerpt where available. The panel groups documents by role without merging language versions:

| Hospital | Application | Policy statement | Plain-language summary | Supplements |
| --- | --- | --- | --- | --- |
| Ellenville (1002) | English, Spanish, Polish, Ukrainian, Russian | English, Spanish; unavailable 2021 link labeled English in filename only | English, Spanish | English privacy notice |
| Little Falls (362) | English, Spanish | English, Spanish | English, Spanish | English resource guide |

There are **18 document records**: 11 Ellenville and 7 Little Falls. The failed 2021 policy's language is **Unknown**, with its filename label shown as unverified and its 404 visible. Language identification does not certify translation quality or completion of language-specific application measures.

Provenance joins the [original document inventory](wave-one-document-inventory.json), [saved collection metadata](posting/collections/), and the [new designated summary evidence](summaries/README.md). The summaries discovered on Bassett's linked PLS page are included; the resource guide retains its supplement role. The original direct-link collection and historical grading records are preserved.

## Reported geography, separate from expected counties

The versioned [`wave-one-reporting-context-v1.json`](../../references/wave-one-reporting-context-v1.json) contains six exact source-language quotations with URL, snapshot SHA-256, retrieval time and page locator:

- **Ellenville:** English/Spanish policies, page 1, and English/Spanish summaries, page 1, list **Ulster, Dutchess, Orange, Sullivan, Delaware, Greene and Columbia** counties for non-emergency medically necessary services. Both distinguish New York State emergency coverage. These are hospital-reported boundaries, not an independently established correct county set.
- **Little Falls:** English/Spanish network policies, page 2, describe Central New York and name **Little Falls, Delhi, Herkimer, Oneonta, Cobleskill and Cooperstown**. These are reported localities; they are not converted into counties. `reported_counties` is null (not an asserted empty service area). The policy explicitly includes Little Falls. Its designated summaries do not describe a geographic service area, as separately reviewed in #24.

**Expected counties: pending review for both hospitals.** No independently verified county reference is available in the saved evidence. The panel does not present the hospital's own list, the map's location county, neighboring counties or a municipality-to-county inference as the correct PSA. It does not label either hospital's list legally incorrect.

An independent reference added later must include its publisher, HTTPS URL, exact quote/locator, county set and applicability. Until that record explicitly identifies an independent source, expected counties remain hidden/null. When a qualifying reference is supplied, the descriptive comparison shows missing/additional counties per hospital statement; locality-only statements remain pending. This display rule does not authenticate a newly supplied reference or approve its legal applicability: that still requires source review.

## Grade separation

`backend/reporting/context.js` returns descriptive metadata with `included_in_grade: false`. It is accessed only through the reporting route and UI, never fed into the grader's `findings`. The rubric still has exactly **17 measures**. Attempts to add reporting-language or reporting-county pseudo-measures are rejected by the existing score contract.

The distinct graded checks remain intact:

1. `policy_summary.primary_service_area_described` — does the designated summary describe its area?
2. `posted_materials.primary_service_area_boundaries_compliant` — do stated boundaries comply under an applicable independent rule/reference?

Displaying a list neither passes these checks nor removes their failures. Historical September 2025 map grades and all human decisions are preserved.

## Verification

```powershell
$env:T2P_PYTHON=(Resolve-Path '.\.venv\Scripts\python.exe').Path
node --test backend/test/*.test.js
npm run build
node scripts/test-reporting-context-e2e.js
node scripts/test-review-e2e.js
.\.venv\Scripts\python.exe tools/live-audit/verify_reporting_context.py --root .audit/live
.\.venv\Scripts\python.exe tools/live-audit/verify_wave_one_inventory.py
.\.venv\Scripts\python.exe tools/live-audit/verify_summaries.py --root .audit/live
```

39 backend tests pass, including four reporting-specific tests. Production build and both browser suites pass. Original-byte checks verify all six PSA citations plus reused inventory/summary evidence. The browser checks both hospitals at 1440×1000 and 390×844, language links, pending reference labels, the unavailable document, unchanged historical grades, no overflow, hospital switching and failure-state handling. A sibling-key collision found while switching hospitals was fixed by using distinct reporting/grading component keys.

Before screenshots: `.audit/25/{Ellenville,Little Falls}-before-{desktop,mobile}.png`. After: `.audit/ui/25/{Ellenville,Little Falls}-after-{desktop,mobile}.png`. Artifacts are local, not hosted links. The existing HHS reference was locally normalized to its already-required LF checkout format so its byte-hash golden test passes; numeric values and grading rules were not changed.
