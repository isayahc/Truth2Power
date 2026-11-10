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

## Logical run history (#95, epic #93)

Run `npm run audit:pilot -- history --hospital 739` for the local operator receipt. The queue response includes the numeric job ID and its store-scoped stable alias `audit-run-<id>`. A request-key retry returns the same run. Each worker claim generates a distinct attempt token. To stop a selected pending or running job, use `npm run audit:pilot -- cancel --job 123`. Cancellation fences subsequent publication. A network request already in flight can finish.

Opening the writable store installs the additive `audit_run_events(seq,job,attempt,state,at,detail)` table and indexes on job/sequence, attempt job and hospital/rule/job. Sequence is the event order. Timestamps are UTC. The worker appends actual collection, extraction, checkpoint reuse and grading boundaries. A successful publication commits its terminal event, revision pointer and attempt status atomically. A partial execution records the gap count. Source capture entries retain original retrieval times and hashes. A failed attempt keeps its failure reason even after a retry. Three failed or expired claims exhaust the job.

The local read contract returns jobs newest first, original pinned context (including evidence root), request keys, attempts, ordered events, current state and scan/assessment IDs. The read uses one SQLite snapshot. Operator receipts include local paths. History is scoped to the configured review directory. Synthetic runs are inspectable but excluded from operational clocks. Each clock includes the run, attempt and mode supplying it.

- Last attempted uses the latest worker claim.
- Last completed execution includes scans, replays and partial publications.
- Last successful retrieval uses the latest captured source timestamp from a committed live run or scan. Next due is 30 days later. With no known retrieval both are null.
- Last eligible assessment uses the highest published live/full job ID, including partial evidence-backed assessments. A late older job cannot supersede it. Replays never advance this clock.

Legacy integrated jobs keep their original IDs, attempts, request keys, recorded completion times and revisions. Historical events, capture clocks and missing timestamps are not synthesized. The older single-measure demo has a separate history contract. Keep the SQLite database and the complete evidence directory together for the lifetime of the audit history. Stop all writers before backup, preserve SQLite WAL files if present, and restore both database and artifacts together. An older application can ignore the additive table; restoring a pre-upgrade backup loses subsequent runs.

## Per-run cost receipts (#96)

Run `npm run audit:pilot -- receipt --job 12` against the same SQLite store as the worker. The JSON receipt joins every attempt, including retries. It contains the raw usage rows, stage and run totals, pinned rates, native billed subtotals, the known USD billed subtotal, calculated provider cost, estimated local cost and unpriced units. A missing bill yields a pending warning. A deterministic run with no provider calls can show zero incremental API cost while its local workload remains unpriced. Receipts for legacy, interrupted or still-running attempts flag incomplete coverage.

To configure pricing, set `T2P_RATE_CARD` to a JSON file before enqueueing. Its contents are copied to the immutable `audit_prices` row in the queue transaction. Reusing an idempotency key keeps the original prices. Without a card, positive resource usage remains unpriced. The following empty template contains no rate assumptions:

```json
{"currency":"USD","version":"operator-v1","effective_date":"2026-11-09","local":{},"models":{}}
```

Local keys are USD per `elapsed_ms` of worker wall time, per `network_bytes` received and per `storage_bytes` of newly retained artifact payload. Choose a storage attribution period and record it and the rate source in the card. Model rates are keyed by `provider/region/model` and specify USD per individual `input_tokens`, `cached_input_tokens` and `output_tokens`. Input excludes cache reads. Omitted prices are unknown. Adding a zero price is an explicit assumption.

For reported usage from an external provider, run `npm run audit:pilot -- import-usage --file usage.json` locally. For example, the structure below illustrates a fabricated provider response:

```json
{"job":12,"attempt":"<existing attempt token>","stage":"model","provider":"bedrock","region":"us-east-1","model":"example","usage_id":"SYN-example","usage":{"input_tokens":15,"cached_input_tokens":8,"output_tokens":3}}
```

Use the actual provider response and omit unavailable token categories. To reconcile a bill, use the same identity with `bill` in place of `usage`, containing `amount` and `currency`. An optional `fx` object carries `usd_per_unit`, `source` and `as_of`. Foreign bills without conversion remain in their native subtotal. Each provider/region/request identity supports one usage record and one bill. Identical redelivery is idempotent. Conflicting attribution or values fail. A bill supersedes the calculated request estimate in totals. Imports do not contact a paid service.

The worker measures actual HTTPS GET attempts (including redirects), response body bytes read, successful bridge parser invocations and PDF pages, checkpoint hits, immutable artifact reuse/writes and logical storage growth. Repeated parsing and download work count again; identical retained artifacts only grow storage on first creation. Stage elapsed time includes waiting. Independent grading-verifier parser invocations are included in grading time but excluded from parser counts. Network headers, transient files, SQLite/WAL overhead, physical disk allocation, outside services without imported records and retention beyond the selected rate period are outside the receipt. Hard process termination can lose the unfinished stage counters. Inspect completeness before using any subtotal.

For #41, export `units`, `stages` and the money subtotals from one representative live run. For #42, this example produces a one-run-per-hospital monthly scenario from recorded quantities. Repeat with different campuses and workload sizes to estimate a range. Preserve the rate card and missing-price warnings with each projection.

```bash
node backend/audit/pipeline-cli.js receipt --job 12 | jq '{run:.audit_run_id,mode,complete,warnings,unknown_unpriced,monthly_units:(.units | del(.meter_finished,.telemetry_missing) | with_entries(.value *= 212)),monthly_estimated_subtotal_usd:(.estimated_subtotal_usd * 212),monthly_known_billed_usd:(if .known_billed_usd == null then null else .known_billed_usd * 212 end)}'
```

Back up `audit_prices` and `audit_usage` with the existing SQLite backup. Receipts replay persisted quantities with the frozen card. Subsequent billing reconciliation appends a row and changes the reconciled receipt.

The [audit reporting API v1](reporting-api.md) exposes hospital histories, monitoring clocks, filtered statewide totals, and JSON/CSV run receipts.

## Hospital audit dashboard (#98)

Start the local app and worker in the same audit directory. Open **Audit operations** to search all 212 hospitals by name, identifier or region. Sort the roster by hospital, status or monitoring date. The financial summary covers statewide recorded runs; the hospital search narrows the table. The cost availability column refers to the latest run.

Select a hospital and choose **Scan documents**, **Full audit** or **Replay saved evidence**. Read the scope and confirm the individual run. If the queue response is lost, **Retry same request** reuses its request key. Active jobs refresh at five-second intervals, up to 120 refreshes. Leaving the hospital stops monitoring. **Refresh** checks again manually. The worker continues independently of the page.

Open any run in the hospital's history to inspect the ordered attempt timeline, saved sources, draft measures, stage costs or CSV receipt. Missing amounts display as unknown. A completed replay advances execution time while preserving the source-fetch timestamp. The September 2025 rating remains the historical published rating.

### Reproduce the offline demo

Run `npm run test:operations` after installing Playwright Chromium and the existing Python dependencies. Set `CHROMIUM_PATH` to use an installed Chromium binary. The test creates an isolated store, starts a localhost server, searches for PFI 739, queues a scan with a simulated lost response, collects fixture documents, replays them and inspects an older revision after a failed full audit. It switches to Spanish at mobile width and checks keyboard navigation and the accessibility tree. It also exercises controlled stale, completed and checkpoint-reuse display states. The test writes `operations-desktop.png` and `hospital-mobile-es.png` under `.audit/ui/operations/`. Spanish strings are implementation translations pending fluent-reader review.

Offline fixture screenshots: [statewide operations](operations-ui/desktop.webp) and [hospital controls in Spanish on mobile](operations-ui/mobile-es.webp).

## Per-run budgets (#99)

Every newly queued integrated run freezes an operator policy. Defaults are 600 HTTPS requests including redirects, 128 MiB of response bodies, 100 HTML pages, 100 documents, 600 seconds from first claim, two retries and zero paid calls/tokens/dollars. Existing traversal bounds still apply independently on each collection. A retry, checkpoint restore or process restart shares the logical run's limits. Legacy queued jobs use built-in defaults.

Set `T2P_BUDGET_FILE` to a local JSON object to configure deployment ceilings. For example, `{"network_requests":30,"network_bytes":8388608,"pages":10,"documents":5,"seconds":120,"retries":1}`. Request-level `--budget` (or the v1 queue body's `budget` object) may only tighten those ceilings. Values are nonnegative integers. Repeated identical request keys keep the original policy. To change an existing job, cancel it and explicitly queue a new logical run.

```bash
npm run audit:pilot -- estimate --mode full_audit --budget '{"network_requests":10}'
npm run audit:pilot -- queue --hospital 739 --mode discovery_only --budget '{"pages":3,"documents":2}' --request manual-739-cap1
npm run audit:pilot -- schedule-preview --max-facilities 5
```

The estimator reports resource ceilings and marginal paid cost bounds. When a rate card prices bytes or worker milliseconds it also returns a component range in USD. Storage growth and total allocated local cost remain unknown before execution. Public UI runs use paid-services-off. To prepare a local paid-capable run, the operator must explicitly configure positive ceilings for `paid_requests`, `paid_tokens` and `paid_usd_micros` (1,000,000 per USD), supply a pinned model rate card, and pass `--allow-paid`. The integrated worker currently uses no paid transport. Any future adapter must call `reservePaid` before dispatch, supply enforceable worst-case uncached, cached and output token bounds, and dispatch only on a true return. Match the provider/region/model and request identity when importing usage. Unknown prices stop dispatch. A lost acknowledgment retains the reservation. Imported external bills are accounting records; the worker can only limit future calls under its control.

`audit_quota` debits a page/document before fetching it, each GET before sending it, and each bounded body read before receiving bytes. Unused bytes from a successful short read are returned. A crash may conservatively consume reserved capacity. A stream of unknown length that exactly fills the allowance can remain unverified because probing it would require another read. Headers and DNS traffic are outside the body-byte limit. Reservations recheck the current worker token and deadline. Cancellation fences new actions; already-issued network operations may finish. The Python bridge is time-bounded; synchronous local grading is checked at stage/publication boundaries. These are operational execution controls, not OS-level CPU or disk quotas.

Budget stops are terminal. The receipt's `budget_stop` and timeline distinguish `quota_exceeded`, `budget_exhausted` and `unknown_price`. When the collector can stop normally it saves its partial manifest, downloaded originals and a collection-stopped event recording the manifest name and capture hashes. A forcibly interrupted subprocess may leave only the immutable artifacts written before interruption. The previous successful assessment stays published. Inspect `history --hospital KEY` and `receipt --job ID` for details.

### Monthly scheduling design and dry run

Only the read-only planning command is implemented. It examines all 212 roster entries against the existing 30-day fresh-fetch clock, includes never-checked facilities, and selects at most the requested interval throughput. Selection skips currently queued/running/retrying latest jobs and applies a 24-hour backoff after a failed latest attempt. The plan reports due keys, selected keys, max operations and cost uncertainty; it does not enqueue, install a timer or contact hospitals.

Recurring execution remains disabled. A future #36 opt-in controller should persist an enabled/paused flag, take an interval lock, recheck due and active state under that lock, use one deterministic request key per facility/interval, and enqueue at most the configured limit under a shared interval spend cap. Pause must prevent new admissions; resume must replan without catch-up bursts. #90 owns concurrent execution. Today an operator can run individual jobs explicitly or cancel them with `cancel --job ID`. To roll back, stop workers, retain the whole SQLite and evidence directory, and restore a pre-upgrade backup before running an older worker that cannot enforce pinned caps.

## Independent operator handoff (#100)

Use Linux or WSL, Python 3.12, a supported Node release (22.13 or newer), and Git. Install dependencies and the browser before disconnecting from the network. The release exercise used Chromium headless shell via `CHROMIUM_PATH`; leave it unset to use the Playwright-managed binary. If Chromium lacks system libraries, install its Linux dependencies before running the suites.

```bash
git clone https://github.com/isayahc/Truth2Power.git
cd Truth2Power
# Select the merged release or the #100 PR commit under review.
python3 -m venv .venv
source .venv/bin/activate
python -m pip install --upgrade pip
python -m pip install -r tools/live-audit/requirements.txt
npm ci
npx playwright install chromium
export T2P_PYTHON="$VIRTUAL_ENV/bin/python"
npm run build
```

**Offline demo and restore drill.** Run the command below from the repository root. It creates a new, isolated demo store containing fabricated responses for real roster keys and saved Wave 1 originals. Keep this store separate from operational records. Allow roughly a minute. No model key is needed. The Python command exits nonzero if the receipt reconciliation, draft grades, history, duplicate requests or restoration assertions fail.

```bash
handoff_dir=$(mktemp -d)
python scripts/verify-operator-handoff.py --keep "$handoff_dir/demo" > "$handoff_dir/benchmark.json"
export AUDIT_DIR="$handoff_dir/demo/audit"
export T2P_REVIEW_DIRECTORY="$AUDIT_DIR/live"
node backend/audit/pipeline-cli.js history --hospital 1
node backend/audit/pipeline-cli.js receipt --job 8
node backend/audit/pipeline-cli.js schedule-preview --max-facilities 2
npm start
```

Open `http://127.0.0.1:8000/?view=operations`, search for Albany Medical Center, and select PFI 1. Open the first replay and download an original source and CSV receipt. Reopen the second replay. Both have 17 draft slots and 17 unresolved measures. The replay execution timestamp exists; the fresh-fetch clock stays unknown. The completed second-round Ellenville replay (job 8) has 14 unresolved measures and a pending institutional grade. The fixture exercise also writes one clearly labeled request for information and verifies it after restoration.

**Regression run.** Stop the demo server first. Use a separate empty store for the suites. The nine browser scripts start their own localhost servers on the ports specified in each script. Set `CHROMIUM_PATH` only if selecting an existing compatible browser. Save command outputs and the candidate Git SHA with your observations.

```bash
set -e
export AUDIT_DIR="$(mktemp -d)/audit"
export T2P_REVIEW_DIRECTORY="$AUDIT_DIR/live"
node --test backend/test/*.test.js
python -m unittest discover -s tools/live-audit
npm run build
for suite in scripts/test-*-e2e.js; do node "$suite"; done
```

**Recovery.** Stop all writers and copy the entire audit directory, including SQLite/WAL files, snapshots, classifications, assessments, run events, cost ledger and review decisions. Separately copy any external evidence roots, pinned price/budget files and environment configuration. Restore to the same absolute locations because job contexts bind those paths. Preserve the pre-restore directory until the integrity check, receipt comparison, review history and independent assessment replay pass. Rolling back to a backup intentionally drops subsequent jobs. Restoring an older application that predates budgets requires its matching pre-upgrade store. The handoff script rehearses these checks on disposable data. Retention and cleanup of real evidence remain operator decisions.

**Independent observation — pending.** Record operator role, date, Git SHA, OS/Node/Python/browser versions, benchmark JSON, observed run IDs and receipt fields, source download, restored decision, pass/fail, and any unclear step in #100 or #93. Include only public/synthetic evidence. Independent operator observation and legal/policy approval are separate gates.
