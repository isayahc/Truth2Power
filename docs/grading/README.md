# Deterministic hospital grading

The calculator consumes one explicitly scoped hospital assessment with 17 distinct findings. It has no network, LLM, retrieval or database-write path. The rubric, HHS reference, local snapshots and independent decision records are its inputs. The September 2025 atlas remains the published historical dataset.

## Reproduce the examples

Install Node 22.13+, Python 3.10+ and the existing live-audit dependencies (`python -m pip install -r tools/live-audit/requirements.txt`). Set `T2P_PYTHON` to choose the interpreter. Node evaluates the measures and grade. Python validates Draft 2020-12 schemas with a local registry and reuses the existing extractor for PDF, DOCX and HTML. Plain-text locators use one-based line numbers.

```bash
npm ci
node backend/grading/cli.js grade docs/grading/examples/SYN-multilingual.json > /tmp/SYN-grade.json
diff -u docs/grading/examples/SYN-multilingual.expected.json /tmp/SYN-grade.json
node backend/grading/cli.js grade docs/grading/examples/SYN-2025.json
node backend/grading/cli.js grade docs/grading/examples/SYN-2026.json
```

| Saved synthetic assessment | Verified result |
| --- | --- |
| SYN-2025 | All 17 resolve, calculated A. The one-person 400% cell is $62,600. |
| SYN-2026 | The same English application SHA-256 and $62,600 fail AH against $63,840. Explicit 400% eligibility passes AI. One verified error calculates B. |
| SYN-multilingual | R, S, T, V, AL, AM and AN resolve. Ten measures remain unresolved. AI shows English and Spanish results individually and lists the three uncovered sources. AH preserves the dated English mismatch. The report withholds the institutional grade. |

The fixtures use a synthetic hospital at roster key 1002. The county rule, template and source documents in these examples are fabricated. They do not assert any current finding about Ellenville.

## Contracts

| Artifact | Use |
| --- | --- |
| [Rubric](../../rubrics/css-17-v1.json) and [schema](../../schemas/grading-rubric-v1.schema.json) | Stable IDs, CSS columns, document roles, typed expectations, evidence requirements, evaluation functions, bands, exemptions, override order and decision provenance. |
| [Hospital assessment](../../schemas/grading-assessment-v1.schema.json) and [finding](../../schemas/grading-finding-v1.schema.json) | Validated replay input. Shared v1 definitions supply hospital keys, result vocabulary, timestamps, digests and citation fields. |
| [Grading report](../../schemas/grading-report-v1.schema.json) | Verified and submitted outcomes, reasons, per-document coverage and numeric comparisons, feasible grades, human status and authorization. |
| [Review identity](review-identity.md) | Immutable versions, current views, migration and original decision binding. |

Each finding repeats the exact assessment ID, scope ID, hospital, rubric version, reference version, guideline year and review date. The loader rejects mixed contexts, duplicate or missing IDs, wrong expected values, wrong roles, invalid dates and missing provenance. It verifies each URL, digest, snapshot ID and local artifact path. A source URL occurs once per assessment inventory. Competing roles or versions at the same URL require a new, explicitly scoped assessment. Different URLs can cite the same bytes. The required inventory includes known-but-unreviewed sources with null snapshots. Declare an incomplete inventory and its specific gaps even if only an English application is available.

Each observation points to its own evidence index. Every citation names a source URL, snapshot ID, SHA-256, locator and exact excerpt. Inputs identify a hospital and reviewed scope through the local collection and its accountable reviewer. A hash verifies bytes. It cannot establish campus applicability or confer review authority. The accepted observation methods are:

- `source_field` reads an original structured publication with `format: published-fields-v1`, hospital, URL, language, role and `fields`. The fixed locator is `/fields/<rubric evaluator>`. The quote is the field's compact JSON serialization. The synthetic snapshots demonstrate each supported shape. A model's output or a transcription of a PDF does not qualify as an original publication.
- `text_profile` re-extracts saved original text at its locator. Supported profiles cover the Node worker's annual row, the Python 200/300/400% annual table, its explicit eligibility statement and its gross-monthly installment language. Conflicting, incomplete or unsupported observations need review. Live facility and role binding use the pinned content-confirmed inventory or a separately reviewed observation.
- `human_coded` accepts a structured interpretation of a located quote only with a matching independent observation decision. Use this path for qualitative readings of ordinary public documents. The source value, citations, assessment context and inventory are part of the decision fingerprint. A `yes` or `no` label is never itself an observation.

For complete findings, the evaluator independently computes the outcome and rejects a contradictory submitted result. An original `unclear` remains unresolved. Qualitative terms distinguish an actual restriction, explicit support, and a source that did not address the question. Different results across documents require reconciliation. A complete search for a genuinely absent posting needs accessible reviewed pages, saved links and search notes. An unavailable document, broken link, older publisher date, missing keyword, or partial library cannot establish absence. A confirmed outdated provision retains its evidence under its relevant measure.

AH compares USD annual amounts against the reference for the chosen review year. Matching one cell cannot pass the full-table check. Incorrect verified cells can establish a contradiction. AI evaluates the explicit eligibility statement independently. A lower table band alone leaves eligibility unresolved. U includes the online application when posted, or evidence of the completed online-application search. Displaying a language or listing counties adds no independent error.

## Calculation and policy status

The denominator stays at 17. A has zero errors, B has 1–3, C has 4–6, D has 7–9 and F has at least ten. A verified R or AD failure forces F. Unclear and N/A findings remain unresolved. This version has no approved exemptions or denominator adjustments.

The calculator enumerates feasible grades under unresolved outcomes and the disputed T override. A definite applicable override can narrow that set to F while the overall assessment still awaits evidence. A calculated band is reported only when all measures resolve and the rule yields a single grade. The shipped rubric always withholds a final institutional grade. Its authority records technical agreement on the prior v1 format at `576aa33`, with subject-matter agreement and institutional release pending.

**Worked #10 case.** A hospital published as B in September 2025 has no statement on the fully reviewed pages on November 8, 2026. With saved search evidence and the other 16 measures passing, T is one verified failure. The possible grades are B and F. Neither is final. An inaccessible page instead yields an unclear posting finding. An outdated posted statement still counts as posted, with separately cited substantive discrepancies. The sprint board’s “Must ask?” column is marked Yes. Its Answer, Answered by and Date answered cells are empty. [Risks and Decisions, row 35](https://docs.google.com/spreadsheets/d/1ZN3A_JSYtHAG6dtEPlofrENfFCfNRm1uWvULk3zH1AI/edit#gid=109&range=A35:G35). The project owner tracks the CSS follow-up in [#9](https://github.com/isayahc/Truth2Power/issues/9) and [#10](https://github.com/isayahc/Truth2Power/issues/10).

The live PSA check needs an applicable approved boundary reference. The pinned official form supplies the reference for a whole-form comparison. Unresolved customization or visual questions leave AD unclear. The synthetic examples exercise both predicates with explicit fixture authorities. Format agreement, individual finding decisions, translation certification, release authorization and scoring policy each have their own scope. See [the agreement record](../audit-format/agreement.md), [#28](https://github.com/isayahc/Truth2Power/issues/28) and [#67](https://github.com/isayahc/Truth2Power/issues/67).

## Native artifacts and review provenance

```bash
node backend/grading/cli.js adapt "$RESULT_FILE" --root .audit/live --review-date 2026-11-08 > /tmp/adapted.json
node backend/grading/cli.js grade /tmp/adapted.json --root .audit/live
```

For the Node worker, save the v1 `latest` envelope returned by `GET /api/audits/362` and use `--root .audit`. The synthetic worker has one measure. Supported producer versions are explicitly mapped in [adapter.js](../../backend/grading/adapter.js). A worker row establishes the printed amount in its own scope. The adapter treats a matching partial table as insufficient for a full AH pass. Python application reviews can contribute bounded numeric observations after source verification. Full-document drafts retain their scope, original source-by-source interpretations, gaps and decisions. Their model conclusions require structured verification. Missing findings become named, unresolved collection tasks. No adapter gathers sources or combines independent runs.

The adapter emits `partial` with a validated input, original artifact provenance and actionable blockers, `blocked` when the input cannot safely be constructed, or `failed_recheck` with zero new findings. A review date supplied on the command line fills an absent native field. It cannot override a recorded date. Native result approval and correction records are read from the established local directories and matched by result SHA-256 and item ID. Conflicting decisions remain visible. Approval of an original result does not approve a new normalized observation. A supplied human-review label alone cannot authorize anything.

For an independently reviewed transcription, the trusted local operator can supply an observation decision store with `--decisions DIR` or `T2P_OBSERVATION_DECISIONS` for the read endpoint. Records live at `DIR/<subject SHA-256>/<record-id>.json` and contain `subject_sha256`, `decision` (approved, rejected or needs_changes), `reviewer_role`, `recorded_at` and `reason`. The exported `reviewSubject(input, finding)` in [evidence.js](../../backend/grading/evidence.js) defines the fingerprint. Decisions are self-attested local records, protected by the operator's filesystem. The grader only reads them. Disagreement blocks the interpretation. No production approvals ship with the examples.

Attempt time, last completed assessment, review date, snapshot retrieval time, optional publisher date, HHS year and refresh status appear separately. An overdue refresh adds zero errors. A missing or stale guideline year withholds AH. A failed worker attempt produces no new assessment. Pass the explicitly retained normalized input with `--previous FILE` to the adapter. To replay a normalized assessment carrying a failed last attempt, the grade command requires the prior completed input and checks that its findings, completion time and evaluation context are identical.

## Read-only local API and browser

`GET /api/grading/demo` replays the checked-in multilingual fixture. `GET /api/grading/hospitals/<hospital_key>` replays the operator-selected file `<hospital_key>.json` under `T2P_GRADING_DIRECTORY`, which defaults to `.audit/grading`. Keep the bundle's relative evidence paths under that directory. The API accepts GET only. It has no publication or decision endpoint. To see the demo in the hospital detail panel with isolated files:

```bash
demo_dir=$(mktemp -d)
cp -r docs/grading/examples/sources "$demo_dir/"
cp docs/grading/examples/SYN-multilingual.json "$demo_dir/1002.json"
T2P_GRADING_DIRECTORY="$demo_dir" npm run dev
```

Select Ellenville and open **View saved 17-measure assessment**. The panel labels this record synthetic and shows the pending institutional grade. The September 2025 historical rating remains in the map.

## Verify from a clean checkout

```bash
npm ci
npm run build
node --test backend/test/*.test.js
python -m unittest discover -s tools/live-audit -p "test_*.py"
python docs/audit-format/check_examples.py
npx playwright install chromium
npm run test:audit
npm run test:review
```

The browser suites use isolated temporary stores. Install Poppler for the worker. Set `CHROMIUM_PATH` to an available Chromium or Chrome Headless Shell executable if needed. The review browser test exercises five independent source identities, Spanish revision history, an English-only adapter run, a withheld grade and the historical map rating. Approval tests use synthetic records in temporary directories.
