# Truth2Power

Truth2Power maps how 212 New York hospitals scored in the Community Service Society of New York’s September 2025 financial assistance review. Select a hospital to see its rating, latitude and longitude, financial assistance page, and source audit row.

## Run the React app

Install Git and Node.js 22.13 or newer with npm. Run these commands in a terminal (including WSL2 on Windows).

```bash
git clone https://github.com/isayahc/Truth2Power.git
cd Truth2Power
npm ci
npm run dev
```

Open [http://127.0.0.1:8000/](http://127.0.0.1:8000/) in your browser. The same app is available at `/maps/`. The Node.js server serves the React frontend and the local datasets on one port. Press **Ctrl+C** to stop it.

### Run the production build

After installing dependencies, stop the development server, then run:

```bash
npm run build
npm start
```

Open the same local URL. To choose a different port on Linux or WSL2, use `PORT=8080 npm start`. Both modes bind to the loopback interface.

### Open the standalone map offline

For the original self-contained map, download [maps/index.html](maps/index.html) using GitHub’s **Download raw file** button and open the file in a browser. This HTML snapshot includes its own data. The React app reads the files in `data/maps/` each time you load the page.

## Check that it’s working

The statewide map should show **212 hospital locations**. Select **0 ★** in the rating legend to show the four hospitals that had no application posted. Choose **Show all**, then select any hospital to see its latitude and longitude.

## Data and rating definitions

- [Map guide](maps/README.md) explains the star ratings and how the coordinates were matched.
- Browse the [hospital audit records](data/) for one JSON file per hospital.
- [CSV coordinates](data/maps/hospital-coordinates.csv) and [GeoJSON points](data/maps/hospitals.geojson) are available for use in other mapping tools.

## Application layout

- `frontend/src/` contains the React map, search, ratings, and hospital details.
- `backend/src/local-server.js` serves the frontend and adapts local requests for the read-only dataset handler in `backend/src/handler.js`.
- `GET /api/hospitals` returns hospital points, `GET /api/counties` returns the 62 county boundaries, and `GET /api/coordinates.csv` returns a coordinate table.

The demo uses public hospital-level audit data and facility coordinates. It requires no AWS credentials. The September 2025 grades describe hospital policies at the time of the review. Production use with patient information would require privacy and security review, appropriate agreements, and eligible services. The API handler accepts API Gateway HTTP API v2 events for a future Lambda deployment; the built frontend can be served as static assets.

### Replay the 17-measure compliance assessment

Use Node 22.13+ and Python 3.10+ with the live-audit dependencies. These commands grade saved synthetic evidence offline. Set `T2P_PYTHON` if your interpreter is named `python3` or lives in a virtual environment.

```bash
python -m pip install -r tools/live-audit/requirements.txt
npm run --silent grade -- grade docs/grading/examples/SYN-multilingual.json
npm run --silent grade -- grade docs/grading/examples/SYN-2026.json
```

The multilingual example has five listed application languages. English and Spanish have separate evidence for 400% eligibility. Polish, Ukrainian and Russian still require review. The report identifies each coverage gap and withholds the hospital grade. The single-application 2025 and 2026 examples use identical application bytes. The outdated dollar table changes the calculated band from A to B. The institution has no approved new grade in either example.

The [grading contract and local operating guide](docs/grading/README.md) documents the rubric, input and output schemas, native artifact adapters, read-only API, test commands and outstanding CSS decisions. The hospital detail panel labels the published September 2025 rating and opens a separately staged draft assessment on request.

### Run a background audit

Use Node 22.13+ with built-in SQLite, install Poppler (`sudo apt install poppler-utils` on Ubuntu/WSL), then run `npm ci` and `npx playwright install chromium`. From the repository root, start `npm run dev` and, in a second terminal, `npm run audit:worker`. Both use port 8000 and the same local `.audit/` directory by default. Set the same PORT and AUDIT_DIR in both terminals to override them. CHROMIUM_PATH optionally selects an installed Chromium executable.

Open Little Falls Hospital and select **Recheck application**. This first audit uses a labeled synthetic hospital page and a PDF with a one-person 400% FPL row. Choose 2025 and then 2026 to compare the identical PDF against two reference years. The panel shows the latest completed finding and lets you inspect the saved evidence. This demonstration evaluates one measure and produces a partial assessment for #28. The statewide map grades describe the historical audit.

SQLite stores queued jobs, rule and reference context, attempts, prior findings, reviewer notes, extraction cache and successful envelopes. SHA-256-addressed snapshots live under `.audit/snapshots/`. A stopped worker's lease expires after 90 seconds. The next worker retries the job and reuses any cached extraction. A failed retrieval can be retried with Recheck. To process just one queued job use `npm run audit:worker -- --once`.

To replay a saved assessment, read the JSON in the SQLite assessments.output column. It uses schemas/live-audit-v1.schema.json. The observations, expected values and immutable PDF citation are available without another browser call.

The [output contract (#20)](docs/audit-format/README.md) defines one logical record per hospital/measure, evidence, separate date fields, draft/human-review labels and mappings for the full-review artifacts. [Technical and subject-matter agreement](docs/audit-format/agreement.md) is pending. Validate the synthetic contract examples with `python docs/audit-format/check_examples.py`.

Record a reviewer note for the pilot with `node backend/audit/correction.js "reviewed correction"`. Subsequent jobs include it as prior context. The evaluator bases the new finding on the newly retrieved application.

Run the browser regression with `npm run test:audit`. It starts an isolated server and database, interrupts a claimed job, rechecks the same PDF under both references and opens its saved citation.

### Connect the audit agent to Bedrock

The project defaults `hospital-auditor` to `amazon-bedrock/us.amazon.nova-lite-v1:0` in `us-east-1`. Connect an existing Bedrock API key once in your terminal:

```powershell
opencode auth login amazon-bedrock
```

Choose **Bedrock API key**. OpenCode saves it in its own credential database; do not put keys in chat, source files or `.env`. This path does not require SSO or repeated script/key entry. Once connected, use `opencode run --agent hospital-auditor "Your task"`. An explicit `--model` overrides the default, including the OpenRouter examples below. Bedrock usage is billed and may be covered by eligible credits; the catalog alone does not prove account access. Nova Lite was successfully invoked with the saved credential.

`scripts/start-bedrock.ps1` is an optional Ellenville sample shortcut using the same saved credentials. It no longer prompts for or manages API keys. Model-generated findings remain drafts requiring interpretation review, even when citation checks pass.

### Collect posted documents with the hospital-auditor agent (#17/#70)

After installing the Python dependencies below, use a hospital ID from `data/maps/hospitals.geojson`. Ellenville Regional Hospital (`1002`) is the second live sample; it is not a defined Wave 1 roster.

```powershell
opencode mcp list
opencode run --agent hospital-auditor --model "openrouter/nvidia/nemotron-3-nano-omni-30b-a3b-reasoning:free" "Collect posted PDFs for issue #17 at Ellenville Regional Hospital, hospital_key 1002. Return the manifest and limitations."
```

Wait for `truth2power` to report connected before running. The agent calls `truth2power_collect_posted_documents`; it selects the landing URL from the roster, saves the HTML, resolves relative PDF/DOCX anchors, deduplicates URLs (preserving labels), and saves every directly linked PDF/DOCX on the same HTTPS host. Redirects must stay on that host or its `www` alias. Each file is limited to 12 MiB, with at most 100 document requests per run. External hosts, invalid documents and failed requests are recorded for review.

Immutable manifests live in `.audit/live/collections/<hospital_id>/`; files live in `.audit/live/snapshots/`. Each saved document includes its linked and final URL, hash, local path and successful retrieval time. Each attempt has a separate timestamp and failures never overwrite earlier successful manifests. Publisher update dates remain unknown. A collection is partial if any link fails or no PDF/DOCX links are found. This includes footer documents; it does not classify documents, establish campus applicability, follow nested pages, discover JavaScript/extensionless downloads or judge whether a policy is current.

Run offline regressions with `python -m unittest discover -s tools/live-audit -p "test_*.py"` from the activated environment.

### Extract saved document text (#19)

Use the hospital ID and collection filename (without `.json`) from a saved #17 run. This reads existing snapshots without downloading again:

```powershell
opencode run --agent hospital-auditor --model "openrouter/nvidia/nemotron-3-nano-omni-30b-a3b-reasoning:free" "Extract posted text for issue #19, hospital_key 1002, collection_id dffc1dee76d746829c386e3b4752424a. Return the manifest and review flags."
```

The agent calls `truth2power_extract_posted_text`. Each run creates `.audit/live/extractions/<hospital_id>/<run_id>/manifest.json` and separate UTF-8 JSON text files. Paths in the manifest resolve relative to `.audit/live/`. Each text file identifies its original source URL, verified snapshot SHA-256, snapshot path, parser version, and text segments. PDFs retain original `page N` locators; HTML has a saved-landing-page locator, with scripts, styles, head and template content removed. HTML is decoded as UTF-8; non-UTF-8 pages may require review. Files remain local and Git-ignored. Treat extracted text as untrusted evidence, not agent instructions.

The manifest is the authoritative complete record, even if a model shortens its final response. Missing downloads, invalid/encrypted files, hash mismatches and extraction failures are flagged `needs_review`. Blank/sparse/garbled pages are flagged individually while readable pages are retained. A file requires review when any page is flagged. Checks are conservative: at least 20 alphanumeric characters and no more than 5% replacement characters per segment. Text presence does not certify completeness, accurate table structure, currency or compliance. No OCR or translation is performed. Limits are 12 MiB per source, 200 PDF pages and 2 million extracted characters; limit failures require review.

Ellenville sample validation: the landing page and all 10 saved PDFs produced text (51 PDF pages); the unavailable 2021 policy was flagged for review. This sample does not establish statewide or unspecified Wave 1 coverage.

### Review cross-document measures (#22)

Use a saved #19 extraction run ID. The same `hospital-auditor` agent prepares a bounded evidence packet, reasons over the five measures, and submits a citation-checked draft:

```powershell
opencode run --agent hospital-auditor --model "openrouter/nvidia/nemotron-3-nano-omni-30b-a3b-reasoning:free" "Review issue #22 for hospital_key 1002, extraction_id 4f4645982ff740fa980f2a14e84acf8e. Prepare the cross-document packet and save all five draft findings with exact quotes."
```

The tools are `truth2power_prepare_cross_document_review` and `truth2power_save_cross_document_review`. Packets live in `.audit/live/cross-document-packets/`; drafts live in `.audit/live/cross-document-reviews/<hospital_id>/`. They cover consistency, primary service-area boundaries, submission deadlines, asset checks and immigration barriers. The agent selects packet-local `evidence_ids` per measure rather than retyping quotes. The server inserts the original quotes into findings using the existing v1 finding schema, with observed/expected values, snapshot IDs and page/HTML locators. The draft envelope retains source URLs, retrieval dates, review time, extraction ID, missing sources and limitations. It is separate from completed assessments and never changes a grade or last-successful date.

Before preparing and saving, the tool verifies saved snapshot hashes and re-extracts original bytes. Fabricated quotes (including edited packet quotes), wrong pages, unknown/cross-measure evidence IDs, unknown/duplicate measure IDs and one-source inconsistency claims are rejected. Model tool arguments have an explicit schema with the five permitted measure IDs. This validates citation integrity, not the model's interpretation; a reviewer still needs to check relevance, exceptions, current rules and whether translations agree.

**Pilot limits:** six keyword-selected excerpts per measure, prioritizing English sources; this is not exhaustive multilingual review. Document roles inferred from URLs are hints. Missing keyword matches never prove absence. The tool accepts `no` only as a cited draft contradiction, or `unclear` for insufficient/conflicting evidence; global `yes` and `n_a` conclusions require a fuller review outside this pilot. PSA stays unclear until an approved boundary rule exists. #20's subject-matter agreement is still pending. Download dates and filenames do not establish current compliance. One sample does not establish statewide or unspecified Wave 1 coverage.

Ellenville validation produced a citation-checked draft mismatch: policy page 3 and application page 4 include the 301–400% range, while the summary page 1 income table stops at 300%. The other four measures remain unclear under the pilot's coverage/rule limits, while acknowledging explicit evidence allowing applications during collections and prohibiting asset/immigration criteria. The initial model explanations were inaccurate despite valid citations; a supervising-assistant correction pass was necessary. The corrected draft is not human-approved. The provider reached its free daily limit after saving it, so the local artifact—not a final model reply—confirmed persistence. Older draft files are retained and should not be treated as approved findings.

### Full-document review: deadlines, assets and immigration (#64)

The full-review tools extend the excerpt pilot with complete source/page coverage:

1. `truth2power_begin_full_document_review` creates an inventory from a saved extraction.
2. `truth2power_read_full_review_source` delivers complete pages with exact passage IDs. Follow `next_page` until null.
3. `truth2power_submit_full_source_review` records each source's language, reviewed pages and observations for all three measures. Delivery alone does not count as review. Untranslated/unreadable material stays a specific gap; unrelated material needs a complete read and scope citations.
4. `truth2power_finalize_full_review` revalidates original snapshots and saves the aggregate draft with source-level coverage, citations and gaps.

For bounded agent runs, assign one source from an existing review at a time: “Review only source_id s2 in review_id <ID>; read all pages, submit its review, then stop.” The auditor is restricted to audit MCP tools. Development, tests and repository maintenance belong to the calling coding session. OpenCode may still inject project instructions automatically; permissions deny the auditor code reads, edits and shell commands.

Complete coverage plus favorable evidence and no relevant restriction permits `yes`. An explicit restriction permits `no`; conflicting evidence produces `unclear`. Missing sources, unreviewed languages or ambiguous observations block `yes`. Silence in an individual source is neutral. Application submission, appeal deadlines, processing time, collection waiting periods and award duration are separate contexts. Income documentation is not automatically an asset or immigration eligibility test. These are model-reviewed posted-material findings, not proof of actual hospital practice or legal compliance. Exact citations do not validate interpretation; English semantic tripwires catch only selected known mistakes.

Artifacts live in `.audit/live/full-reviews/<review_id>/`: `state.json` retains appended source-review revisions; `results/<result_id>.json` preserves each finalized draft and its source reviews. The full-review envelope is separate from the existing per-measure v1 assessment schema. Human decisions are separate, hash-linked records and never silently modify a draft. An actual human reviewer can record a decision locally:

```powershell
python tools/live-audit/human_review.py <result-file> --decision needs_changes --reviewer-role policy-reviewer --notes "Reason for decision" --confirm-human-review
```

This CLI is not an MCP tool. Its role label is self-attested, not authenticated. No agent should invoke it to manufacture human approval.

**Service-area question remains open:** [NYS Public Health Law §2807-k(9-a)(f)](https://www.nysenate.gov/legislation/laws/PBH/2807-K), displayed revision May 29, 2026, distinguishes emergency coverage for New York residents from medically necessary services in the hospital's primary service area under commissioner criteria. We still need the applicable commissioner criteria, their effective date, and Ellenville's filed/approved boundaries for the review date. The statute and a county list alone do not establish boundary compliance. Rule approval and subject-matter review remain pending.

Run regression checks with `python -m unittest discover -s tools/live-audit -p "test_*.py"`. Tests use synthetic fixtures and cover full-page delivery, coverage gaps, exclusions, context distinctions, conflicts, revisions, snapshot mutation and separate human decisions.

**Ellenville live validation:** review `f3855e2408eb437e84e45e0c1319c02e`, corrected result `0a59d1543b5844ed8a0268f5e9425748`, accounts for the landing page and all 51 collected PDF pages across English, Spanish, Polish, Ukrainian and Russian. Ten sources were reviewed for eligibility; the five-page privacy notice was read and explicitly excluded. The audit agent ran on saved Bedrock credentials with one-source assignments after its initial whole-review run became stuck. Supervising-model corrections were required for every source, including wrong passage selections, income-versus-assets mistakes and reversed immigration classifications. Each source retains both revisions. Independently checked 63 source-review citation occurrences against re-extracted original snapshots.

All three aggregate drafts remain `unclear` for specific reasons: the linked 2021 policy was not downloaded (the collection reported 404); application timing includes unspecified “timely” completion and Russian wording about data collection; asset provisions need reconciliation with personal-resource exhaustion and weaker Spanish wording; Ukrainian immigration wording needs qualified translation interpretation. Favorable provisions remain cited. These are questions for review, not established violations. PSA criteria and human approval remain pending; the earlier incomplete result is retained for traceability.

### Application-only draft checks (#23)

The `hospital-auditor` can call `review_application_measures` with a saved `hospital_key`, `extraction_id`, exact application URL and ISO `review_date`. The tool re-extracts the original bytes and saves six cited drafts under `.audit/live/application-reviews/<review_id>/results/<result_id>.json`. Policy/summary documents cannot substitute for an application.

Checks cover entire Uniform Application, assistance contact, income/discount tables, FPL year/dollars, eligibility through 400% FPL, and the 5% gross-monthly-income installment cap. Arithmetic uses `references/hhs-poverty-contiguous-v1.json` (2025/2026 annual HHS values); unsupported years are rejected. The deterministic English uniform-form profile is deliberately narrow: unsupported languages/layouts remain unclear, and matching headings cannot establish complete official-form equivalence.

Ellenville's selected five-page English application was checked on 2026-11-08: **unclear / yes / yes / no / yes / yes**, respectively. Six citations were independently verified against original pages and 21 table cells compared. Its table is labelled 2024; the one-person 400% amount is $60,240 versus $63,840 for 2026. Dollar accuracy and maximum coverage are separate questions.

Local pilot artifact: `.audit/live/application-reviews/aa62e50484844230a5da77c4c5f96971/results/6f011dec62964a92946943ef1dc4f146.json`. Human approval remains pending. Four other application language versions are explicitly unassessed. The applicable official NYS template comparison remains outstanding; see #70 below for the subsequently confirmed Wave 1 roster and coverage.

The inbox groups each reviewed document by hospital, source URL, role, language and review scope. Filter by document language and expand **Source identity and revisions** to inspect the exact snapshot or open a previous draft. Each new result starts a separate decision history. The [identity contract](docs/grading/review-identity.md) covers URL changes, duplicate links and historical artifacts.

### Wave 1 follow-up (#70)

The user-defined initial Wave 1 roster is **Ellenville (1002) and Little Falls (362)**. Both now have six saved English-application draft records (12 total). This is draft coverage, not twelve resolved findings or human approvals.

Little Falls posts English and Spanish applications as DOCX. The collector now saves directly linked PDF/DOCX documents; extraction validates snapshot hashes and bounds DOCX archive expansion. DOCX citations identify the body rather than inventing rendered page numbers. Tracked changes, embedded drawings/objects and additional document parts require review. Saved DOCX sources download from the inbox with hash verification.

Little Falls collection `833f736450a346bca5b638ecb0809a44` and extraction `b218c29092c64bc29d8971e9d1f5c6e3` include both applications and three PDFs. Its initial English draft remains at `.audit/live/application-reviews/afa9e482a32942349841bb11e229be3b/results/68e4885e3d454acb8a480b72edfdfd6e.json` with all six findings unclear. The Spanish application is unassessed.

The #72 follow-up inspected the original vector structures: two modern straight lines, two legacy copies and three legacy field-border groups. Parser `document-text-v4` accepts only narrowly validated text-free line structures, including bounded inspection of embedded legacy metadata; unknown images, text boxes, alternate text, extensions, external relationships and other extraction gaps still require review. The original-coordinate preview confirms plain lines and field borders; Word automation timed out, so this is **not full Word rendering or pagination verification**.

The new English draft is `.audit/live/application-reviews/866a1fe3befb44ebb186a00f461cd1e2/results/2bdcc7f792d04c6886f2c601e3d1dc19.json`: **Uniform Application unclear; contact, tables, FPL year/dollars, maximum FPL and installment cap yes**. Six citations, 24 matching FPL cells and seven drawing-evidence records were independently verified. The one-person 400% amount is $63,840. The inbox displays drawing locators, XML hashes, parser version and limitations. Earlier drafts and human-review status remain intact. Local inspection artifacts: `.audit/72-inspection/line-preview.png` and `line-preview-provenance.json`.

`compare_application_template` compares a saved application with the pinned official 2026 English NYS DOCX and saves full-text evidence/alignment under `.audit/live/template-comparisons/`. It never promotes an entire-form finding from text similarity. A normal browser successfully downloaded the official DOCX with HTTP 200 after separate HTTP/headless clients failed. `import_official_template_download` imports only a session-observed download from `.playwright-mcp`, checking its supplied official URL, hash and timestamp. Pass its `reference_capture_id` to comparisons to re-extract the captured bytes without another network request. Import records supplied browser provenance; it does not independently authenticate it.

**Both Wave 1 text comparisons are saved and attached to new inbox drafts**, with 418 source-verified evidence lines. Parser `document-text-v5` covers the official body, footnotes and seven empty auxiliary parts individually. `review_application_measures` accepts a fresh `template_comparison_id` for 2026 drafts; stale-parser or mismatched evidence is rejected, and prior drafts/decisions remain preserved. The inbox shows cited shared text, formatting/customization observations, substantive differences, reference coverage and specific interpretation questions. The official reference contains a six-person 300% amount of $133,880, versus the HHS-correct $133,080 printed by Little Falls; template similarity must not override HHS arithmetic. Whole-form findings remain unclear pending rendered-layout and permitted-customization interpretation. See [the source-checked comparison report](docs/audit-format/wave-one-template-comparison.md) for capture IDs, packet paths, exact evidence IDs, corrections to inaccurate model summaries and remaining language work.

**#76 visual interpretation is complete:** every page of the official six-page Word export and both five-page hospital forms was inspected, with all 80 reference units accounted for per hospital. Pass `whole_form_review_id="whole-form-wave-one-v1"` with the verified comparison ID to attach the pinned interpretation to a new draft. Original/render hashes and parser identity are checked. The inbox now includes section/page links, recommendations and exact rubric-owner questions. Both whole-form results remain unclear for customization/scoring rules; rendering is no longer the blocker. See [the whole-form report and reproduction steps](docs/audit-format/wave-one-whole-form-review.md). Additional language reviews remain #72.

### Plain-language summary measures (#24)

[Wave 1 summary results](docs/audit-format/summaries/README.md) cover both English and Spanish summaries for Ellenville and Little Falls. Ellenville describes its service area, application process and income levels; Little Falls explains applying and income levels but omits a geographic service-area description. Bassett's designated summaries were found on its linked PLS page and explicitly include Little Falls. All three findings per hospital include exact quotes, source hashes and page/language coverage. These draft presence checks do not establish current-dollar accuracy or a hospital grade. Verify locally with `.\.venv\Scripts\python.exe tools/live-audit/verify_summaries.py --root .audit/live` (omit `--root` for contract-only checks).

### Hospital pages (#30)

Open `/?hospital=1002` for Ellenville or `/?hospital=362` for Little Falls, or select a hospital on the map. Wave 1 pages show all 17 checks with plain-language explanations, related law sections, dated evidence, separate publisher update dates, languages, PSA geography and the HFA link. They retain the historical grade and label the current institutional grade pending. Failed rechecks remain visible alongside the prior successful finding. [Data, scope and verification](docs/hospital-pages/README.md).

### Document languages and PSA counties (#25)

Ellenville and Little Falls hospital records show a **Languages and service area** panel with all 18 document-language records, exact PSA source quotes, and separate expected-county status. Ellenville reports seven counties; Little Falls's policy lists localities rather than counties. Expected county comparisons remain pending an independent reference. These informational fields are excluded from grade counts; the two distinct graded service-area checks remain. See [scope, provenance and verification](docs/audit-format/wave-one-reporting-context.md).

### Human review inbox (#27)

Open **Review inbox** in the header, or **Review notifications** on a hospital record. The badge counts pending and information-requested items. The local inbox reads the newest finalized full-document result per hospital from `.audit/live/full-reviews/`; it includes all three model findings and the unresolved service-area question. The existing Ellenville result supplies four notifications. A fresh checkout with no local drafts shows an empty inbox, not invented findings. Earlier result files remain on disk; the inbox explicitly shows the current result ID and date.

Notifications identify the hospital, measure, question, date and review status. The review panel shows the original result, exact source-language quotations, page locators, source-by-source reasoning, language/page coverage, missing sources and live links. **Open saved source** serves hash-verified original PDFs (with page anchors) or inert text for saved website HTML. Website HTML is never executed in the app's origin.

Reviewers may **confirm**, **correct**, or **request information / leave unresolved**, with a role and reason. Confirming `unclear` keeps the finding unclear. Correcting to yes/no requires existing cited evidence; missing evidence must first be supplied in a new draft. N/A requires the reviewer to explain the applicable rubric exemption. The UI records a reviewed-result overlay and an append-only decision history; original drafts and the September 2025 map ratings are not overwritten. Requests for information remain in the pending count. Stale submissions are rejected, and a new result hash requires fresh review.

Decisions are stored under `.audit/live/review-inbox-decisions/`, linked to the hospital, measure, result ID and SHA-256. This local workflow uses self-attested roles and is not a multi-user authenticated approval service. It does not import the terminal-only whole-result decisions or older #22 excerpt envelopes. Those remain separate artifacts. Only public hospital documents and synthetic test data belong here; do not enter patient information in review notes.

API routes: `GET /api/reviews`, `GET /api/reviews/<item-id>`, `POST /api/reviews/<item-id>/decisions`, and `GET /api/reviews/<item-id>/sources/<snapshot-id>`. Local mutations require same-origin requests and the review request header, and enforce an 8 KB body limit. `T2P_REVIEW_DIRECTORY` can select an isolated directory for tests; the default is `.audit/live`.

Verification:

```powershell
node --test backend/test/*.test.js
npm run build
node scripts/test-review-e2e.js
```

The browser test starts an isolated local server on port 8097 with synthetic drafts, verifies decisions and persistence, then removes only its temporary data. It does not approve live findings. Desktop/mobile screenshots are saved locally in `.audit/ui/27/`.

### Audit the real Little Falls site with OpenCode

The `hospital-auditor` primary agent starts at Little Falls Hospital's URL from the roster. Its two local MCP tools discover the English application and policy, verify campus coverage in the policy PDF and compare the application’s one-person, 400% FPL table cell with the 2026 HHS reference. It saves a partial live assessment under `.audit/live/assessments/`. The React recheck panel continues to run the synthetic SQLite pilot. This live workflow reads DOCX and PDF directly and requires Python 3.10+ and Chromium.

From the repo root in Windows PowerShell, install the tool dependencies:

```powershell
python -m venv .venv
.\.venv\Scripts\Activate.ps1
python -m pip install -r tools/live-audit/requirements.txt
python -m playwright install chromium
```

On Linux or WSL use `python3 -m venv .venv` and `source .venv/bin/activate`, then run the two Python installation commands. The MCP launcher selects the project's `.venv` explicitly, including when OpenCode's shared service was started outside the activated terminal. The checked-in project config targets OpenCode V2 and exposes the two audit tools directly (not as skills or through Code Mode). Use your configured model/provider; connect OpenRouter with `/connect` first.

```shell
opencode mcp list
opencode run --agent hospital-auditor --model "openrouter/nvidia/nemotron-3-nano-omni-30b-a3b-reasoning:free" "Audit Little Falls Hospital's live 2026 one-person 400% FPL row and cite the evidence."
```

For a provider-independent live smoke test, run `python tools/live-audit/smoke.py`. Both entry points use the same MCP tools. Review the reported URLs, snapshot hashes, PDF page and DOCX table locator. Source files are stored under `.audit/live/snapshots/`; paths inside each assessment resolve relative to `.audit/live/`. If the documents or link labels change, inspect the live sources and the reported limitation. An ambiguous table or unverified campus produces an unclear finding. The reference for this single check is [the 2026 HHS contiguous-state poverty guideline](https://aspe.hhs.gov/poverty-guidelines), $15,960 annually for one person (400% = $63,840).

### Wave 1 posted materials

The [Wave 1 posting results and replay commands](docs/audit-format/posting/README.md) cover application, summary and policy-statement availability for Ellenville and Little Falls. Each positive finding joins an actual landing-page anchor to a saved document and a content-confirmed role excerpt. The CLI reads saved captures offline.

The [Wave 1 CSS agreement report](docs/validation/wave-one-css-agreement.md) compares the September 2025 hospital row exports with the published Wave 1 draft projections for all 17 measures. Run `node scripts/compare-wave-one.js --json` for the cell, assessment scope, date and citation metadata behind each comparison.
