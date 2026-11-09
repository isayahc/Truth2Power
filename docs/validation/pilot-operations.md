# Run and demonstrate the integrated pilot

Prerequisites: Node 22.13+, Python 3.10+, `npm ci`, the existing Python requirements (`python -m pip install -r tools/live-audit/requirements.txt`), and `jsonschema` as required by the grading guide. Use `T2P_PYTHON` for the interpreter containing those packages. Browser tests need Playwright Chromium (`npx playwright install chromium`). No paid model or network access is needed **after dependency installation** for synthetic audits or packaged replay.

## Offline demonstration (PowerShell)

Use a new isolated directory; leave prior audit stores intact. Apply these environment variables in both the app and worker terminals:

```powershell
$env:T2P_PYTHON=(Resolve-Path '.\.venv\Scripts\python.exe').Path
$env:AUDIT_DIR=(Join-Path (Get-Location) '.audit/SYN-pilot-demo')
$env:T2P_REVIEW_DIRECTORY=(Join-Path $env:AUDIT_DIR 'live')
$env:T2P_PILOT_DEMO='1'
npm run build
npm start
```

In the second terminal run `npm run audit:worker`. Open `http://127.0.0.1:8000/?hospital=1002`, select **Synthetic offline demo**, and queue the audit. Close the page, then reopen it. Refresh job status and reload findings. Inspect all 17 measures, immutable assessment JSON, saved evidence, overview and review inbox. The historical September 2025 rating stays separate. The synthetic calculated grade is B; institutional grade remains pending.

Queue the original again: a new completed revision, no material event. Queue **Corrected table**: calculated A, one source-change event. Queue it again: no duplicate event. Inspect **Recent changes** and its before/after snapshot downloads. The multilingual variant intentionally has unresolved coverage. Synthetic evidence is labeled and hidden from normal read views unless `T2P_PILOT_DEMO=1`.

Equivalent one-shot commands (same environment):

```powershell
npm run audit:pilot -- run --mode synthetic --hospital 1002 --year 2026 --date 2026-11-09 --request SYN-original
npm run audit:pilot -- run --mode synthetic --variant corrected --hospital 1002 --year 2026 --date 2026-11-09 --request SYN-corrected
npm run audit:pilot -- run --mode synthetic --hospital 1002 --year 2025 --date 2025-11-09 --request SYN-historical
```

Request keys are idempotent: retry the same key/context to retain the job; use a new key for a new refresh. Reusing a key with changed context is rejected. `queue` persists without executing; `work` claims one eligible pilot job; the continuous existing worker handles retries. Three failed attempts exhaust automatic retries; queue a new request after repairing the cause. Expired leases are reclaimed and stale attempts cannot publish. Content-addressed checkpoints resume preparation; changed rubric bytes require a new job. Never edit committed snapshots or decisions to repair a run.

## Reproduce the public Wave 1 reports

From a clean checkout with dependencies installed:

```powershell
Expand-Archive docs/validation/pilot-wave-one-evidence.zip .audit/portable-wave-one
npm run audit:pilot -- replay .audit/portable-wave-one/assessments/1002.json --root .audit/portable-wave-one
npm run audit:pilot -- replay .audit/portable-wave-one/assessments/362.json --root .audit/portable-wave-one
```

Both commands must report `replay: identical`, 17 measures, and pending grade. They verify original source bytes and re-run the deterministic grader without publishing a new assessment or changing retrieval dates. The ZIP contains 20 public snapshots and two bundles. Review the per-measure report in [wave-one-pilot-results.md](wave-one-pilot-results.md); full quotes, locators, source URLs and hashes live in the bundles. Earlier source-scoped drafts are preserved in `producer_records`.

For a new integrated run using an existing original evidence store:

```powershell
npm run audit:pilot -- run --mode replay --hospital 1002 --year 2026 --date 2026-11-09 --request wave1-new --evidence-root .audit/live
```

The original evidence root must include collector manifests, original snapshots and review artifacts for full available coverage. A clean checkout without those artifacts produces explicit missing-evidence blockers. The portable ZIP is sufficient for **report replay**, not a replacement for the complete collector/reviewer working directory.

## Live operation and monitoring

Use a separate non-demo `AUDIT_DIR` and `T2P_REVIEW_DIRECTORY`. All 212 facility keys in `data/maps/hospitals.geojson` work through the CLI and local queue API. Use the exact key, including `t2p-0001` for the facility with no assigned PFI. The worker chooses the roster's assistance URL. Facilities sharing a health-system URL keep separate inventories and review scopes.

| Manual mode | Source | Committed result |
|---|---|---|
| `discovery_only` | Bounded public collection | A document inventory, saved originals, link graph and coverage gaps. A scan creates no assessment and leaves prior findings in place. |
| `full_audit` (also `live`) | Bounded public collection and local extraction | An inventory and exactly 17 draft results. Insufficient evidence yields `unclear`. The institutional grade stays pending. |
| `replay` | Latest saved successful collection in `--evidence-root`, or available curated originals for Wave 1 | A new 17-result assessment using the original retrieval dates. An empty evidence directory yields explicit missing-evidence gaps. |

From the repository root on Linux or WSL, for example:

```bash
npm run audit:pilot -- run --mode discovery_only --hospital 739 --date 2026-11-09 --request scan-739-1
npm run audit:pilot -- run --mode replay --hospital 739 --date 2026-11-09 --request replay-739-1
npm run audit:pilot -- queue --mode full_audit --hospital t2p-0001 --date 2026-11-09 --request full-local-1
npm run audit:pilot -- work
```

`run` executes the specified job immediately. Alternatively, POST to `/api/pilot/hospitals/{key}` with the `X-Review-Request: 1` header and a JSON body containing `mode`, `year`, `review_date` and `request_key`. The worker consumes queued jobs. GET the same route for the job ID, mode, status, latest assessment ID and `latest_scan`. Retrieve a committed scan at `/api/pilot/scans/{latest_scan}`. The CLI also prints its immutable file path under the review directory. Each captured inventory entry identifies the original bytes by `artifact_path` and SHA-256 (`digest`). Open the bytes locally for classification. The collector manifest preserves failed and cross-host candidates, parent links, redirects, bounds and dates. A failed landing fetch uses the existing retry policy and leaves its attempt manifest in `collections/{key}/`.

**Classifying a new document.** Inspect the exact saved original. Record a source-language quotation and locator for its role, and a quotation and locator demonstrating campus applicability. An operator can supply a local JSON record with the following shape. Replace every example value with verified evidence.

```json
{
  "schema_version": "hospital-classifications-v1",
  "hospital_key": "739",
  "reviewed_at": "2026-11-09T19:00:00Z",
  "reviewer_role": "Document reviewer",
  "documents": [{
    "source_id": "https://example.invalid/verified-source.pdf",
    "sha256": "<64 lowercase hex digits from the inventory>",
    "role": "policy_summary",
    "language": "en",
    "locator": "page 1",
    "quote": "<exact role quotation>",
    "applicability": { "locator": "page 2", "quote": "<exact campus quotation>" }
  }]
}
```

Pass `--classifications ./review.json` with a new request key to a full run or saved-evidence replay. The CLI stores the exact record by hash under `source-classifications/` and binds that hash to the job. Include this directory when copying evidence for independent report replay. Only an exact hospital, source URL and snapshot match can use that classification. The verifier checks both quotations against the saved text. A different URL/hash stays unclassified, an invalid bound citation fails verification, and a known other-campus original stays unresolved. Supported document roles are `application`, `policy_statement`, `policy_summary` and `supplement`. Language uses a canonical language tag. Classification allows the grading adapter to evaluate supported evidence. Finding-level review and grade authorization remain separate.

A limited search, unavailable source, script-only page, unsupported form, or missing governing reference leaves an explicit gap. Positive posting evidence requires a saved path from the roster landing page to applicable, classified bytes. Live requests use no model. Offline regression commands are `node --test backend/test/roster-audit.test.js backend/test/multihop.test.js`. They exercise two non-Wave-1 facilities through the real collector with local responses and replay both Wave 1 hospitals from the packaged originals.

`npm run audit:pilot -- due` reports the full 212-hospital denominator and next due dates. It does not install a scheduler or assert monthly coverage. Saved-evidence replay updates the execution timestamp but retains source retrieval dates; the monitoring clock conservatively uses the oldest captured hospital source. Stop refreshes and overdue/never-checked states remain visible. Failed refreshes retain the prior successful revision and expose retry status.

Back up the entire local audit directory (SQLite plus snapshots, checkpoints and decisions) while the worker is stopped. Read APIs publish only committed bundles; orphan checkpoint files are not public evidence. Reviewer decisions bind to immutable inbox subjects. They do not independently authorize an institutional grade; the existing grading decision contract remains separate.

## Automated demonstration

```powershell
npm run test:pilot
```

The browser script starts its own isolated server/worker and uses fabricated fixtures. It tests closing/reopening the browser, evidence downloads, shared revisions, unchanged/corrected/failed refreshes, mobile layout and CSRF. Screenshots: `.audit/ui/pilot/{before-desktop,after-desktop,after-mobile,changes-after-desktop}.png`. Node tests additionally cover interruption, bounded retries, multilingual history, year changes, out-of-order completion and missing original evidence.

## Multi-hop discovery and trust policy (#56 follow-up)

The **existing** `documents.collect` performs deterministic breadth-first traversal. It follows PDF/DOCX anchors, financial-assistance/resource/billing/application pages, and nested descendants of a resource page. It records every processed page, failed resource, anchor relationship, source/final URL, retrieval timestamp and SHA-256 in the collection manifest. Page traversal is an evidence search, not proof of exhaustive coverage. URL fragments/default HTTPS ports are normalized; path case and query parameters/order remain distinct. Duplicate URLs are visited once; identical document bytes share immutable snapshot storage without merging distinct URL or language identities.

| Limit | Default | Hard cap |
|---|---:|---:|
| Link depth (landing = 0) | 3 | 8 |
| HTML pages | 20 | 100 |
| Documents | 100 | 100 |
| Bytes per resource | 12 MiB | 12 MiB |
| Total bytes | 64 MiB | 128 MiB |
| Request deadline | 20 seconds | 30 seconds |
| Traversal time budget | 120 seconds | 150 seconds |
| Redirects per request | 5 | 8 |
| Unique anchors per page / recorded relationships overall | 5,000 | 5,000 |

Limits are validated and become part of the immutable/idempotent job context. Example CLI configuration:

```powershell
npm run audit:pilot -- run --mode live --hospital 362 --year 2026 --date 2026-11-09 --request live-multihop-362 --discovery-bounds '{"depth":3,"pages":20,"documents":50,"timeout":15}'
```

The local queue API accepts the same object as `discovery_bounds`. Python callers can use `Bounds(...)`. Hitting a limit records a gap; it cannot prove absence. DNS lookup uses a deadline-bounded daemon lookup, and the Node subprocess also has a 180-second hard timeout; an interrupted collection is retried rather than published as successful. The traversal clock is checked between resources, and a final in-flight request can consume its remaining request budget.

Only HTTPS port 443 on the exact roster hostname or its `www` alias is trusted. This rule applies to every redirect, not just the first URL. Credentials, local/internal hosts, private/reserved/link-local addresses, unsupported schemes and cross-domain redirects are rejected. Every DNS answer must be globally routable. The downloader connects to that validated IP directly with TLS certificate verification and SNI for the original hostname, preventing a second DNS lookup from rebinding the connection. Environment HTTP proxies are not used. Redirect hops and the final URL are retained. `snapshot.final_url` is optional additive provenance in the existing grading input schema and supplies the base for resolving saved relative anchors; it cannot change the original source identity or host trust rule.

Scripts are never executed. Pages containing scripts retain a JavaScript coverage warning; HTML-only discovery remains partial. There is no arbitrary browser navigation fallback or external search-engine authority in this release. Moved documents are found through allowed redirects or newly linked resource pages; documents outside those boundaries require operator discovery and classification. HTTP 404/410 is recorded as inaccessible/gone, **not** independently confirmed withdrawal or a violation.

Classification uses the pinned Wave 1 campus inventory, the #81/#86 summary citations, or an explicit hash-bound operator classification as described above. Link labels alone cannot establish campus applicability. Unknown or other-campus documents remain review tasks. A Wave 1 pinned content hash can match at a new URL for the same campus. Operator classifications also bind the exact URL. Old snapshots survive failed attempts, but are not silently relabeled as current captures. Publisher dates remain null unless independently established.

## Reproduce Little Falls discovery and observation normalization

```powershell
.venv/Scripts/python.exe -m unittest discover -s tools/live-audit -p test_multihop.py
node --test backend/test/multihop.test.js
```

The Python regression traverses Little Falls's **original saved HTML** using an offline transport backed by the portable ZIP. It discovers both summaries at depth 2 and verifies their hashes, campus classification and recorded English/Spanish identities. The Node regression runs the integrated 17-measure pipeline from those saved bytes and verifies S = yes, shared page/overview revision, independent report replay, and rejection of altered quotations/snapshots. No live hospital response or paid model is needed.

`node scripts/test-pipeline-e2e.js` additionally renders the real saved Little Falls assessment after the synthetic recovery/change scenarios. It verifies all read-view revisions and captures the expanded summary citation chain at `.audit/ui/pilot/little-falls-summary-chain-desktop.png`. The legacy single-measure demo panel is scoped to legacy jobs, so it cannot interpret an integrated publication as its older envelope.

The posting evaluator rebuilds reachable paths from exact saved anchor labels and verifies document-role and campus citations. A detached child page, incorrect campus, missing intermediate capture or untrusted host cannot create a pass. The pipeline uses its configured depth; the independent verifier caps paths at eight links. All supported historical direct-link reports remain replayable.

`normalize-observations.js` reuses only verified source-field or bounded text-profile facts from supported native adapters. It checks hospital, rubric/reference version, guideline year, source URL/hash, role, language and exact original citations, then binds facts to the new assessment context. It retains producer IDs, decisions and rejection reasons. Stale references, changed bytes, conflicting reviews, incomplete facts and qualitative interpretations are rejected. An old human approval never authorizes a new assessment subject. AE/AG/AL/AM/AN interpretations still need the contract's independent review; an AI yes/no label is never an observation.

Historical HHS reference bytes differ only by verified LF/CRLF serialization. The adapter now accepts that narrow representation compatibility after checking embedded reference content and version; unsupported hashes or substantive/context differences remain rejected. It independently re-extracts numeric facts before reuse. See `normalization` in each bundle for exact accepted/rejected facts and original/current hashes. Engine context is now `multilingual-v1`; pending jobs from an older engine must be queued with a new request key rather than resuming stale checkpoints.

## Reproduce all seven application-language reviews (#72)

```powershell
.venv/Scripts/python.exe scripts/export-application-reviews.py
.venv/Scripts/python.exe -m unittest discover -s tools/live-audit -p test_multilingual_applications.py
node --test backend/test/application-languages.test.js backend/test/multihop.test.js
```

`wave-one-application-reviews.json` and its Markdown coverage matrix are generated deterministically from `pilot-wave-one-evidence.zip` (seven hospital originals) and `application-reference-evidence.zip` (captured official 2026 DOCX, preserved rendered PDFs, historical application results/comparisons and available exact decisions). Original historical records inside the package are not rewritten. `--capture-root .audit/live` is an explicit maintainer-only packaging option using the previously captured public bytes; normal reproduction needs no `.audit` state or network.

To rerun the integrated pipeline with historical producers, extract **both** ZIPs into the same evidence directory, then pass it as `--evidence-root` using the earlier queue/run commands. Each new immutable bundle contains `application_reviews`: six source-specific drafts per language, extraction locators/drawings, reference identity and structural-template context. The existing review inbox receives their exact original-language quotations. AH/AI/AJ numeric observations are independently verified by JavaScript against re-extracted originals; AE/AG qualitative drafts are not promoted to approved facts. Unknown languages are never treated as English. The deliberately English synthetic legacy fixture is explicitly labeled English in its adapter.

The shared profile file is `references/application-language-profiles-v1.json`; it contains bounded source-language patterns, not translations substituted into citations. Numeric cells retain household size, percentage and printed dollars. Discount bands retain their own payment passages and rate percentages. Nonmatching, duplicate or unreadable content remains unknown. The 5% installment cap is parsed from its explicit gross-monthly-income sentence, never from the separate 2% interest clause.

Reference compatibility is recorded separately from observation acceptance. Exact current bytes are accepted; the LF/CRLF alternative additionally requires semantically identical embedded reference content. Arbitrary reserialization is not accepted. Context/year/source/role/language/decision checks still apply. New assessments never inherit a prior subject's human approval. The official six-person 300% typo ($133,880) and HHS/Little Falls value ($133,080) are preserved separately.

AD remains unclear. The reference package verifies #78's English rendered-byte bindings; English rendering is no longer a blocker. Twenty-one checks (eleven sections and ten fields) provide review locations, not proof of complete semantic equivalence. Structural inventories retain DOCX table/cell/grid/section properties and PDF page dimensions. Spanish DOCX pagination and authoritative translated-template applicability remain explicit. No `permitted` customization option is inferred or exposed without an approved rule.

The four translated Ellenville PDFs additionally carry complete, hash-bound model visual reviews in `references/application-visual-review-v1.json`. Every page locator and exact question quotation is verified against re-extracted originals before attachment. All 25 pages were inspected; visible fields and continuations showed no clipping. Semantic questions remain source-specific. The integrated job context pins the visual-review file hash; changed reviews require a new job. This attachment leaves AD unclear and human review pending.

## Reproduce Ellenville's four unresolved cross-document measures (#64)

Run `.venv/Scripts/python.exe scripts/export-full-review.py`. The checked-in `ellenville-full-review-evidence.zip` contains the original collection/extraction manifests, all 11 snapshots, complete source-review state (22 revisions), historical result files and any available exact-result decisions. Normal replay uses no network or local `.audit` state; `--capture-root .audit/live` is the explicit maintainer packaging option. Package hashes detect changes; the checked-in package/repository is the provenance trust anchor, not an external digital signature.

The script re-extracts all originals, verifies every stored source/page identity, coverage claim and quotation in every revision, and requires the recomputed three-measure aggregate to match the preserved result. It emits `ellenville-full-review.json` and `.md`, including a fourth, still-unclear PSA finding with source citations and specific rule questions. Original model dates remain separate from the follow-up date; no fresh full-source review or human approval is invented. See `issue-64-review-questions.md` for research/retrieval limitations and decisions needed.

To include this history in an integrated replay, extract this ZIP into the same evidence root as the pilot and application-reference ZIPs before running `pipeline-cli.js run --mode replay --hospital 1002 ... --evidence-root <directory>`. The existing adapter/inbox handles the preserved native results. A follow-up run verified 17 measures, 3 resolved / 14 unclear, with the institutional grade pending. No qualitative or translation gate is relaxed.
