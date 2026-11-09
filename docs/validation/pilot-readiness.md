# Pilot readiness — 9 November 2026

Updated for the #72 multilingual follow-up to merged PRs #87/#88. Issue #37 is closed; policy and approval issues remain open.

## Multilingual application engineering (#72)

Final visual follow-up: `references/application-visual-review-v1.json` records model inspection of all 25 translated Ellenville PDF pages. Attachment requires exact hospital/language/hash, complete readable page coverage and verbatim question quotations. Fields and continuations are visible with no observed clipping; specific semantic questions remain. This resolves the uninspected-PDF-layout gap, not semantic equivalence or approval. Little Falls Spanish DOCX rendering remains unresolved. Pipeline job identity pins this review file's hash.

All **seven application versions / 42 source-specific drafts** are reproducible from original public bytes. See [coverage matrix](wave-one-application-coverage.md) and `wave-one-application-reviews.json`. Source-language profiles share a versioned specification between Python and the independent JavaScript verifier. Every hospital now has AH/AI/AJ numeric observations for every application language: **21 source/measure observations**, versus six English-only observations before this change. All five Ellenville tables fail 2026 currency; both Little Falls tables match HHS arithmetic. AE/AG presence drafts retain contacts and linked income/discount rows.

Compared with #88, **no integrated outcome changes**: 6 resolved / 28 unclear across both hospitals, grades pending. The five translated sources retain `translation_needed` at the integrated scope boundary; bounded extraction does not certify whole-form translation or satisfy independent qualitative review. Full-source/complete-inventory gates are unchanged.

The historical HHS mismatch was CRLF versus LF serialization, not a substantive source revision. The adapter reconstructs both exact byte hashes and requires matching embedded reference content for non-current serialization. Six historical numeric observations (three per English form) are now accepted after independent byte/citation/profile verification. An older Little Falls extraction draft has no reusable facts and remains rejected for observation reuse. Every accepted/rejected fact and reference binding is in the exported bundle. Historical records and decisions remain unchanged; no approval transfers.

English #78 visual findings and rendered-byte hashes are preserved. The five translated comparisons add 21 source-language checks (eleven sections and ten fields), original reference citations, DOCX table/cell/grid and section-property inventories, PDF page dimensions, and drawing metadata. They do not prove authoritative translated-template applicability or complete semantic/layout equivalence. Little Falls Spanish DOCX pagination remains unverified; AD remains unclear for explicit customization, translation and AD/AH overlap questions. Missing anchors remain unknown rather than asserted omissions.

An attempted read-only Microsoft Word PDF export of the Spanish DOCX exceeded the 120-second automation timeout. No new rendered evidence was accepted. The five Spanish structural drawing records and table/grid inventory remain available; this is an explicit technical layout limitation, not a hospital failure.

| #72 acceptance area | Current status |
|---|---|
| Seven application-language identities and six-measure drafts | Implemented; exact URLs/hashes, original-language quotations, contacts, linked income/discount rows and historical-record pointers are portable. |
| Deterministic AH/AI/AJ extraction and verification | Implemented; 21 source-bound numeric observations verified independently, with mutation/ambiguity/language regression cases. |
| HHS reference mismatch | Repaired for exact LF/CRLF representation equivalence only; original IDs/hashes/decisions retained. Other bindings rejected. |
| Official reference and English visual evidence | Captured official bytes and prior English rendered evidence verified offline; known $133,880/$133,080 discrepancy retained. |
| Translated whole-form comparison | Structural coverage implemented; authoritative translation applicability and full semantic/visual equivalence remain unresolved. Spanish Word rendering timed out. |
| Permitted customization and AD/AH overlap | External rule decision required; AD remains unclear without an approved authority. |
| Integrated publication, recovery and shared revisions | Existing safeguards retained; Node/browser regressions pass; no institutional approval inferred. |
| Subject-matter review / institutional authorization | Pending #20/#67 and exact-subject human decisions; #72 is **not eligible for closure**. |

The complete browser run passed all seven suites; the expanded pipeline suite was rerun after final source-language integration. An initial legacy-browser regression revealed that the English demo fixture had an unspecified language; its adapter now explicitly identifies that fixed synthetic fixture as English rather than letting unknown-language real sources fall back to English. No language gate was relaxed. A combined Node/Python run hit a 120-second harness timeout; the full suites subsequently passed with a sufficient timeout. Python dependency security auditing remains outstanding because the existing environment does not include `pip_audit`; no dependency was added.

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
3. **Language interpretation:** all five additional versions now have six-measure source-specific drafts and verified numeric facts. Obtain independent translation/whole-form interpretation and applicable translated-reference decisions; extracted text and component anchors are not certified equivalence.
4. **Qualitative integration:** supply independently reviewed grading-contract observations and scope coverage for contact, tables, summary content, consistency, deadlines, assets and immigration. Historical reference compatibility is repaired narrowly; numeric facts are independently re-extracted. Exact quotes and model interpretations are not approvals.
5. **Policy decisions:** obtain authoritative PSA boundary rules and effective dates (#64); resolve permitted whole-form customization/current-FPL interaction (#72/#76); approve or revise missing-statement override (#10). Preserve the known official-template/HHS arithmetic discrepancy.
6. **Human review:** record subject-matter agreement on a named commit (#67/#20), then independent finding/translation decisions and assessment-bound institutional authorization. Technical review and merge are not substitutes.

For Ellenville's W/Y/Z follow-up specifically, retain the favorable original citations and resolve the existing #64 questions: timely completion following Medicaid denial versus submission deadlines/Russian data-collection wording (W); personal-resource exhaustion and Spanish asset wording versus income documentation (Y); Ukrainian immigration wording (Z). The unavailable 2021 policy remains a separate source gap. Little Falls needs its own complete structured cross-document review; the Ellenville contradictions are not attributed to it.

## Verification log

### #72 clean-clone reproduction

Cloned implementation commit `e322027` with `git clone --no-hardlinks --branch feat/72-multilingual-applications`, installed cached Node dependencies with `npm ci --offline`, and extracted both checked-in evidence ZIPs. Both grading replay commands returned **identical** 17-measure reports with pending grades. Regenerating all seven application reviews reproduced the tracked JSON exactly. Six targeted Node tests and six multilingual Python tests passed from the clone, including full new pipeline runs for both hospitals and historical normalization; the production build passed. Generated Markdown also has explicit LF attributes for Windows reproducibility. Python dependencies were reused via the existing virtual environment, not freshly installed. This is not independent operator or subject-matter sign-off.

Executed on Windows, Node 22.14.0, existing Python virtual environment; no paid models:

| Command | Observed result |
|---|---|
| `node --test --test-reporter=dot backend/test/*.test.js` | 69 tests passed, including seven-source profile parity, reference compatibility/mismatch tests and expanded real seven-language pipeline verification; existing recovery/history/review tests retained. |
| `.venv/Scripts/python.exe -m unittest discover -s tools/live-audit -p 'test_*.py'` | 95 tests passed, including seven multilingual methods covering originals, mutations, linked cells and visual-review hash/page/quotation binding. Existing Pydantic warning remains. |
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

### Clean-checkout reproduction — multi-hop follow-up

Cloned implementation commit `0db44f7` to a separate directory with `git clone --no-hardlinks --branch feat/56-multihop-evidence`. `npm ci --offline` installed 20 cached packages. After extracting the checked-in ZIP, both runbook `pipeline-cli.js replay` commands returned **identical** reports with 17 outcomes and pending grades. `node --test backend/test/multihop.test.js` passed all three tests, including a new full Little Falls pipeline run using only packaged original bytes; `python -m unittest discover -s tools/live-audit -p test_multihop.py` passed all nine tests. `npm run build` passed, and the checkout remained clean. This used the existing Python environment through `T2P_PYTHON`; it is not a fresh-machine dependency installation or independent operator sign-off.

### Historical clean-checkout reproduction — PR #87

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
| #72 application reviews | Seven source-specific six-measure drafts, linked numeric observations, reference compatibility and structural comparisons implemented. Translated semantic/layout equivalence, authoritative template applicability, customization decisions and independent approval remain. | Keep open. |
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
