# Pilot readiness — 9 November 2026

Updated for the #56 multi-hop follow-up to merged PR #87. Issue #37 is closed; the remaining policy/coverage issues remain open.

## Verdict

**The offline end-to-end pilot works. Real Wave 1 assessments remain partial and unapproved.** This is not certification, legal authority, statewide accuracy validation, or production authorization.

| Dimension | Observed status |
|---|---|
| Software execution | Persistent worker → extraction/evidence verification → exactly 17 findings → deterministic report → atomic publication → consistent read views demonstrated offline. |
| Evidence completeness | Synthetic scope complete; both real hospitals partial. Original available public bytes are packaged for replay. |
| Policy approval | #10 missing-statement override, #64 boundary rules and #67 subject-matter agreement remain pending. |
| Institutional authorization | No approval manufactured; final grades withheld, including synthetic demonstrations. |
| Production readiness | Local pilot only; statewide discovery, complete language interpretation, independent operation and monthly coverage remain unverified. |

## Implemented and verified

- Extends existing SQLite jobs, attempts and assessments, Python collector/extractor, rubric, grader and schemas. No competing grading format.
- Request-key idempotency, bounded delayed retries, expired-lease recovery, ownership fencing, atomic assessment/event commit, immutable content-addressed sources/checkpoints, rubric-content pinning and checkpoint-context binding.
- All 17 findings retain source identities and explicit unknowns. Exact citations are checked against saved bytes; qualitative producer drafts remain traceable without becoming approvals.
- Hospital page, grader endpoint, overview and review inbox use the same committed revision. Newer queued jobs take precedence even when older jobs finish later. Historical September 2025 ratings remain intact.
- Changed source produces one before/after event; unchanged and failed refreshes produce none. Failed refresh retains prior success. Replay cannot freshen historical retrieval dates.
- Offline synthetic original/corrected/multilingual and 2025/2026 demonstrations; actual worker/browser integration; portable real-evidence report replay.

## Wave 1 coverage

See [all 34 hospital–measure results and source/language inventory](wave-one-pilot-results.md), and the adjacent ZIP for complete exact evidence and blockers.

| Hospital | Records | Resolved integrated outcomes | Unclear | Final grade |
|---|---:|---|---:|---|
| Ellenville (1002) | 17 | R, S, T: yes | 14 | Withheld |
| Little Falls (362) | 17 | R, S, T: yes | 14 | Withheld |

These are saved-evidence executions, not new website captures. Little Falls S now resolves through the original two-hop HTML chain and both campus-cited summaries; its earlier discovery draft remains preserved. Compared with PR #87, total resolved outcomes increase **5 → 6**, and unclear outcomes **29 → 28**. Ellenville stays at 3/14, Little Falls moves from 2/15 to 3/14. No other outcome changes. Ellenville's English numeric observations retain the outdated FPL result; unresolved multilingual scope prevents an institution-wide resolved outcome. Earlier yes/no drafts are retained in `producer_records` and do not disappear when the integrated result is unclear.

### Actionable blockers

1. **Discovery/classification engineering:** multi-hop HTML traversal, nested resources and trusted redirects are implemented, including Little Falls's designated summary page. JavaScript-only resources, external search for moved pages and statewide live classification remain gaps. Bounded traversal never proves exhaustive absence.
2. **Missing source:** obtain Ellenville's unavailable 2021 policy or document its authoritative withdrawal. Do not treat an inaccessible URL as an absence finding.
3. **Language coverage:** review Ellenville Spanish, Polish, Ukrainian and Russian applications and Little Falls Spanish application under the same six-measure contract. Preserve existing multilingual source reviews and resolve translation/interpretation exceptions rather than declaring their evidence absent.
4. **Qualitative integration:** supply grading-contract observations and scope coverage for contact, tables, summary content, consistency, deadlines, assets and immigration. The new deterministic normalizer supports source facts while rejecting unsupported qualitative testimony. Actual historical application drafts failed the existing reference-byte pin check; regenerate/review them against the current pinned reference before reuse. Numeric facts are still independently re-extracted. Exact quotes and model interpretations are not approvals.
5. **Policy decisions:** obtain authoritative PSA boundary rules and effective dates (#64); resolve permitted whole-form customization/current-FPL interaction (#72/#76); approve or revise missing-statement override (#10). Preserve the known official-template/HHS arithmetic discrepancy.
6. **Human review:** record subject-matter agreement on a named commit (#67/#20), then independent finding/translation decisions and assessment-bound institutional authorization. Technical review and merge are not substitutes.

## Verification log

Executed on Windows, Node 22.14.0, existing Python virtual environment; no paid models:

| Command | Observed result |
|---|---|
| `node --test --test-reporter=dot backend/test/*.test.js` | 66 tests passed, including three new multi-hop/normalization tests, 10 integrated pipeline tests and existing grading boundary/override/evidence/review tests. |
| `.venv/Scripts/python.exe -m unittest discover -s tools/live-audit -p 'test_*.py'` | 88 tests passed, including nine new traversal/security/original-Little-Falls tests and atomic interrupted-file publication. Existing Pydantic forward-reference warning remains. |
| `npm run build` | Passed. |
| `node scripts/test-audit-e2e.js` | Passed; legacy fixture uses existing Python PDF reader if Poppler is absent. |
| `node scripts/test-changes-e2e.js` | Passed. |
| `node scripts/test-hospital-page-e2e.js` | Passed. |
| `node scripts/test-overview-e2e.js` | Passed. |
| `node scripts/test-pipeline-e2e.js` | Passed: real worker, 17 outcomes, shared revision, evidence download, changes/failure retention, desktop/mobile, CSRF. |
| `node scripts/test-reporting-context-e2e.js` | Passed. |
| `node scripts/test-review-e2e.js` | Passed in the seven-suite aggregate run with a 240-second harness timeout. |
| `npm audit` | Zero reported vulnerabilities (including development dependencies). |
| `.venv/Scripts/python.exe -m pip_audit` | Not run successfully: module unavailable. Python dependency security audit remains a release check. |

Schema validation occurs in the grader and its regression tests using the local Draft 2020-12 registry. A separate call to `backend/grading/validate.py`'s `validate` function validated all four `docs/grading/examples/SYN-*.json` input/report examples successfully. Expected corruption-test `pipeline_failed` metadata is not an unexpected suite failure. Screenshots are reproducibly generated under `.audit/ui/pilot/`; no private health data or credentials are included. The captured changes desktop and failed-refresh mobile layouts were also visually inspected.

The expanded pipeline browser test now verifies **real saved Little Falls S=yes**, all seven path/title/campus citations, pending authorization and consistent page/grader/overview/inbox revisions. It exposed and fixed a legacy-panel crash: the one-measure `/api/audits/362` endpoint and fixture queue had selected integrated jobs from the shared tables. Those legacy reads/requests are now explicitly scoped to their original rule; integrated publication remains unchanged. The passing expanded test captured `.audit/ui/pilot/little-falls-summary-chain-desktop.png`, which was visually inspected. Python pipeline snapshot/manifest writes also now use flushed temporary files and atomic hard links, avoiding a partial final file after interruption.

### Clean-checkout reproduction

Cloned commit `d2a7c8f` into a separate directory using `git clone --no-hardlinks --branch feat/pilot-audit-orchestration`, with no copied audit database or private working artifacts. `npm ci --offline` installed 20 packages from the existing cache. Python dependencies were supplied through the existing virtual environment, not freshly installed. Extracted the checked-in ZIP and ran both `pipeline-cli.js replay` commands from the runbook: **both reports identical**, 17 findings each, pending grades. A new synthetic `run --mode synthetic --hospital 1002 --year 2026 --date 2026-11-09 --request SYN-clean` produced 17 findings, zero unresolved, calculated B and pending institutional grade. `npm run build` passed there; `git status --short` remained clean. This verifies portable code/evidence execution with preinstalled Python dependencies, not a fresh-machine dependency installation or independent human operation.

## Remaining engineering/operating limits

- Single local worker is the supported pilot deployment; no hosted authentication, scheduler, statewide crawler or institutional release workflow is supplied.
- Source additions/removals are preserved in coverage/revisions but do not yet produce paired before/after change events like changed existing sources.
- A failed first integrated run is visible in job status; without a prior integrated publication it is not overlaid on legacy finding cards.
- Content extraction is not complete visual/layout interpretation or OCR. Unknown drawing/translation scopes remain explicit. Scripts are not executed; no unsafe browser fallback was introduced.
- No new live fetch was used to claim freshness in this release. Monitoring uses the oldest captured hospital source conservatively, not complete monthly coverage.
- Automated clean-checkout validation is not the independent operator acceptance required by #36.
- SQLite is experimental in the tested Node version. Local backups must preserve database, source bytes and independent decisions together.

## Issue reconciliation

| Issue | Status against full acceptance criteria | Closure recommendation |
|---|---|---|
| #56 orchestration | Multi-hop pilot, exact-link/campus verification and fact normalization implemented/tested. External moved-page search, statewide discovery, full qualitative observations and monthly operation remain partial. | Keep open. |
| #28 calculator | Technical deliverables implemented and regression-tested; governing rule/contract approval remains external. | Await #10/#20 decisions before full closure. |
| #36 refresh | Partially implemented: repeatable command, retries, 212-site due report; no independent operator or monthly statewide coverage. | Keep open. |
| #37 stale data | Already closed; overview and failed/aged integrated refresh tests still pass. | Remains closed. |
| #64 cross-document review | Full-review machinery and preserved evidence exist; missing source, boundary decisions and human interpretations unresolved. | Keep open. |
| #67 agreement | Blocked on subject-matter reviewer and named-commit decision. | Keep open. |
| #72 application reviews | English evidence retained; five additional application-language reviews and governing interpretation remain. | Keep open. |
| #10 policy override | Blocked on governing decision; grader preserves possible outcomes rather than inventing approval. | Keep open. |
| #20 output format | Technically complete; subject-matter agreement pending under #67. | Keep open. |

Next: review the multi-hop PR, have an independent operator follow [the runbook](pilot-operations.md), complete the Python dependency audit, then prioritize structured language-aware evidence review and authority/approval decisions before expanding hospitals.

## #56 acceptance reconciliation after multi-hop work

| Acceptance area | Status | Evidence / remaining requirement |
|---|---|---|
| Claim context and persist attempts | Implemented and tested | Existing SQLite leases, idempotency, engine/reference pins and checkpoint-context checks retained. |
| Discover applicable documents | Implemented for bounded HTML; partial overall | Two/three-hop fixtures, actual Little Falls saved chain, trusted redirects, cycles/limits, broken pages and campus rejection tested. Search beyond allowed resource links and JS-only sites remain additional engineering. |
| Capture reproducible evidence | Implemented and tested | Every fetched page/document has original/final URL, time/hash, immutable bytes and parent edges; errors/limits retained. Unknown publisher dates remain null. |
| Collect all 17 observations | Complete records; partial evidence | 17 outcomes per hospital; six resolved postings across Wave 1. Per-measure blocker categories and exact evidence are in the generated report/package. Qualitative/language interpretation remains unresolved. |
| Verify findings and route review | Implemented and tested | Original bytes, anchor paths, campus classifications and numeric profiles reverified; stale structured facts rejected. Pending subjects remain in existing review inbox. |
| Reproducible grade | Implemented; external policy blocked | Existing deterministic grader and immutable report replay; #10/#20/#67 decisions and institutional authorization still required. |
| Atomic publication / material changes | Implemented and tested | All existing interruption, duplicate/retry, out-of-order, historical preservation, revisions and changed-source event regressions pass. New-source addition/removal event coverage remains a known engineering limit. |
| Monthly statewide operation | Partial / external operation not demonstrated | Full 212-site denominator retained; statewide classification/scheduling and independent monthly operation are not established. #36 remains open. |

**#56 is not eligible for closure.** #10/#20/#64/#67/#72 remain open. Passing software tests do not supply source evidence, policy approval, translation decisions or institutional authorization.
