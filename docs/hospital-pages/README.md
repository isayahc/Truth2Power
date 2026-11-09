# Wave 1 hospital pages (#30)

Open `/?hospital=1002` (Ellenville) or `/?hospital=362` (Little Falls). Search/map selection opens the same full-width detail page; browser Back/Forward and reload preserve the selected hospital. The HFA link is near the top.

Each page contains:

- The unchanged **September 2025 published grade**, plus an explicitly **pending current institutional grade**. The existing saved 17-measure grader remains available below the page content. Display records are never passed to the grader or counted as one combined assessment.
- All 17 rubric checks, each with a plain-language question, Yes/No/Unclear/Not applicable label, source-review reason, related statutory section and plain-language explanation.
- A linked list of checks with a No finding in any reviewed scope. These are draft findings, not a new determination of legal liability.
- Latest successful assessment **per measure and scope**, dated evidence links, exact quotations, source hashes, review dates and separate publisher update dates.
- Failed rechecks displayed with their attempt date while retaining the prior successful finding. A successful unclear result is still a successful assessment; the page never searches backwards for a preferred Yes/No answer.
- All document languages and hospital-reported PSA geography from #25. Expected county comparisons remain pending an independent reference.

## Data and provenance

`GET /api/hospitals/{key}/page` is read-only. Wave 1 has a checked-in display projection (`1002.json`, `362.json`) so a clean checkout has substantive pages without a private local audit directory. Other hospitals return 404 and an explicit unassessed state until applicable local records exist. An overview link includes the selected page revision. A changed revision returns 409 and offers a fresh overview.

The projections retain original artifact SHA-256 IDs, artifact paths, scope, execution/review dates, producer findings and citation metadata. They come from the #21 posting records, #24 summary records, and saved #22/#64/#76 cross-document/full/application reviews. They do not replace those artifacts or change any decisions. Original full/application reviews remain in the review inbox with their separate human decisions. The page deliberately labels the source drafts rather than representing them as human-approved.

The service also reads newer local public-document reviews from `T2P_REVIEW_DIRECTORY` (default `.audit/live`). For each measure it selects the newest successful record within its hospital, guideline year and document scope, then retains any later failed attempts. Application scopes use the existing review identity logic, preserving distinct language/reference identities; unverified-language legacy scopes are not silently reclassified as English. Full posted-material reviews supersede earlier excerpt reviews for the same measure. Conflicting scope outcomes show Unclear at the row level with each result visible underneath. Missing measures show Unclear / not assessed, not No or Yes. The Wave 1 view uses review year 2026.

Unreadable local records leave the checked-in findings visible with a coverage notice. Synthetic audit-worker results never become real hospital page findings. URLs are restricted to HTTPS; excerpts render as text. Artifact reads are size-limited and confined to the review directory after resolving symlinks.

### Rebuild pinned display records

```powershell
node scripts/build-hospital-pages.js
```

This verifies original assessment hashes and available evidence snapshot hashes without network or AI calls. It exports the original findings, not a new interpretation. It aborts on changed snapshot bytes or unreadable review records. Missing snapshot files receive `original_snapshot_unavailable` and a visible UI note. **Nine Ellenville posting citations lack local original bytes** from the #21 capture; their original saved citations/URLs/hashes are retained, not reported as newly verified. A public source link may now serve different bytes. Other exported citations have matching local snapshot hashes. Original exact-text verification belongs to the source review workflows documented in `docs/audit-format/`.

### Failed real rechecks

Producers can append a failure record under `.audit/live/page-rechecks/{id}.json`. Use the exact `scope` from the page API's measure version, matching hospital, year and affected measure IDs; do not use a failure to replace a successful record. Example **synthetic contract only** (not a real hospital event):

```json
{
  "synthetic": true,
  "hospital_key": "362",
  "status": "failed",
  "kind": "application-reviews",
  "scope": "SYN-copy-the-exact-scope-from-the-producer",
  "guideline_year": 2026,
  "checked_at": "2026-11-10T10:00:00Z",
  "affected_measures": ["application.fpl_guidelines"]
}
```

Synthetic records are ignored by the public page loader. Actual producer failure records must be based on a real attempt and omit the synthetic marker. The UI uses a generic failure message rather than exposing internal error details. This endpoint does not initiate rechecks or generate artificial failures. The browser test mocks a synthetic failed response; it never saves a hospital failure or human decision.

## Legal explanation provenance and limits

The informational mapping was checked against the NY Senate's [Public Health Law § 2807-k](https://www.nysenate.gov/legislation/laws/PBH/2807-K), revision **2026-05-29**, during this implementation. Section 9 covers the state application; 9-a(a) immigration; (b) income-based reductions; (c) summaries, income levels, service area and applying; (d) installment caps; (e) application timing and help; (f) service-area rules. The website posting, cross-document, application-field and annual-FPL checks are labeled as CSS audit implementations related to these provisions, not verbatim statutory requirements. The asset check links related income rules and explicitly leaves its precise legal interpretation pending policy review. The existing #67 subject-matter questions remain visible. This page does not resolve the disputed grading override or independent PSA boundary reference.

Publisher update dates are **Unknown** unless a source explicitly supplies one. Retrieval, assessment timestamps, document year labels and URL directory dates are never substituted for publisher updates.

## Verification

```powershell
$env:T2P_PYTHON=(Resolve-Path '.\.venv\Scripts\python.exe').Path
node --test --test-reporter=dot backend/test/*.test.js
npm run build
node scripts/test-hospital-page-e2e.js
node scripts/test-reporting-context-e2e.js
node scripts/test-review-e2e.js
```

46 backend tests pass (seven new page tests). Browser checks cover both hospitals offline, all 17 rows, evidence quotes and links, legal links, unknown publisher dates, historical grade preservation, desktop/mobile overflow, direct links/reload/browser history, a failed recheck alongside retained success, hospital switching, error/retry and browser errors. Before/after captures use anonymous localhost access at 1440×1000 and 390×844. Local artifacts: `.audit/ui/30/{Ellenville,Little Falls}-{before,after}-{desktop,mobile}.png` and `SYN-failed-recheck-after.png`. These are local files, not hosted review links.
