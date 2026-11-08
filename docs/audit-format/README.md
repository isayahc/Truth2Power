# Hospital-measure output contract — v1

**Status: proposed for technical and subject-matter agreement (#20).** The v1 schema and examples are implemented; this document does not imply that either group has approved the rubric. Record agreement in [agreement.md](agreement.md). Scope: public hospital documents and synthetic examples, not patient records.

Issue #20 defines the exchange between the worker (#53) and the grader (#28). Serialize one attempt per hospital, using its stable roster key. A completed assessment contains one finding per requested measure. Each finding inherits the hospital key, assessment ID, rubric version and guideline reference from the envelope. Store these keys with the finding if flattening to SQLite. Full grading requires all 17 distinct measure IDs. Partial extractions are valid inputs for review.

| Result | Meaning |
| --- | --- |
| yes | Cited evidence satisfies the measure's rule within its required scope. Required coverage must be complete; unresolved contradictions cannot be ignored. |
| no | Cited evidence contradicts the rule. `missing_after_search` is reserved for a rubric that explicitly treats absence as failure, with complete applicable search coverage, cited searched material and `search_notes`. No keyword hit or a broken link does not establish absence. |
| n_a | The versioned rubric grants an exemption. Explain the exemption and why it applies. Missing evidence, an unrelated source or an unimplemented check is not a measure exemption. Display as **N/A**. |
| unclear | Evidence is insufficient, unreadable, conflicting or dependent on an unresolved rule/translation. Name the specific gap and preserve favorable evidence. This is not a violation or a pass. |

Use observed and expected values of the type defined by the measure. Monetary tables include household size, percentage, currency and income period. Cite exact text or table cells using the snapshot ID and page, section or row. Treat the publisher date as unknown when unavailable.

## One logical record per hospital and measure

The transport envelope is [`schemas/live-audit-v1.schema.json`](../../schemas/live-audit-v1.schema.json). It avoids repeating hospital and document metadata on every finding. A logical row joins `hospital_key` + `assessment.assessment_id` + `finding.measure_id`; historical assessments of the same hospital/measure are retained. Never key by hospital name. In a current-results view, select an explicitly identified assessment rather than silently combining findings from different runs.

| Row field | v1 location / rule |
| --- | --- |
| Hospital | `hospital_key`: stable roster identity from #14, not a display name. |
| Measure | `assessment.findings[].measure_id`: unique within the assessment, drawn from the versioned rubric. |
| Outcome and reason | `result`, `reason_code`, `explanation`: explain the measure outcome in plain language. |
| Compared values | `observed`, `expected`: typed to the measure, including units/period for money. Null is allowed when a comparison cannot be established; never fabricate a value. |
| Quoted text and location | `evidence[].quote`, `locator`: verbatim source-language text with page/section/table locator. Translations or paraphrases belong in explanation, not the quote field. |
| Document and evidence URL | Resolve each `evidence[].snapshot_id` through `snapshots[]` to `document_type`, `url`, `sha256` and `artifact_path`. A finding may cite multiple documents. Keep conflicting citations. |
| Date checked | `assessment.completed_at`, labelled **Assessment completed**. Not the publisher's update date or a claim of approval. |
| Reference | `rubric_version`, `reference_version`, `guideline_year`: the rule/reference used, not an inferred document year. |

Every exported flat row must carry its hospital, assessment and measure IDs, result, reason, explanation, checked date and the resolved evidence metadata. Repeating the quote for each citation in a child evidence table is preferable to dropping multiple citations. The evidence URL is the cited document's URL, not a substituted landing page.

## Dates and run outcomes are independent

| Field | Meaning and display label |
| --- | --- |
| `attempt.attempted_at` | **Last attempt**: when this run was attempted, whether it completed or failed. |
| `attempt.status` | `completed` or `failed`: execution status, not compliance and not human approval. |
| `assessment.completed_at` | **Assessment completed**: completion of this assessment; may contain `no` or `unclear`. |
| `last_successful_assessment_at` | **Last completed assessment**: completion time of the latest successfully produced assessment. “Successful” means the process completed, not that the hospital passed. |
| `snapshots[].retrieved_at` | **Retrieved**: when the cited bytes were downloaded. |
| `snapshots[].publisher_updated_at` | **Publisher update**: optional publisher-supported date, otherwise null / **Unknown**. Retrieval time, filename and URL directory are not evidence of a publisher update. |
| `guideline_year` | **Review guideline year**: the year being checked against. A new check may find an older or incorrect published table. |

A failed attempt has `assessment: null` and an error, preserves the previous `last_successful_assessment_at` exactly, and does not replace the previous assessment's findings. Before any successful assessment that field is null. For a completed assessment, it equals that assessment's completion timestamp. These cross-record relationships require application validation; JSON Schema alone cannot enforce them.

Do not show a failed attempt's timestamp as “last checked” beside older findings. Show the failed attempt and the retained assessment date separately. Do not use one ambiguous “updated” date for the publisher, download, attempt and assessment.

## Review status is separate from the finding

Model results are **Draft — human review pending** unless an actual human decision is recorded for that exact artifact. A `yes` remains a draft `yes`; approval of an `unclear` result confirms uncertainty and does not convert it to `yes`. Avoid labels such as “compliant” or “verified” based solely on schema/citation checks.

The v1 envelope has no human-approval field. Do not insert an unsupported property or infer approval from `attempt.status: completed`. Keep review decisions alongside the assessment, linked to its result ID and SHA-256. The #64 implementation uses separate records with `decision` (`approve`, `reject`, `needs_changes`), `reviewer_role`, `notes`, `recorded_at`, `result_id`, and `result_sha256`. Its local CLI uses self-attested roles, not authenticated identities.

| Separate review state | Display |
| --- | --- |
| No matching human decision | Draft — human review pending |
| Matching `approve` | Human-approved interpretation, with decision date and role |
| Matching `needs_changes` | Changes requested |
| Matching `reject` | Rejected draft |
| Multiple inconsistent decisions without an explicit resolution | Conflicting review decisions — review required |

Retain earlier drafts, corrections and decisions. A decision for one hash cannot approve a revised artifact. A new model revision requires its own review. Reviewer identity/access controls and automated display of these states are follow-up implementation work, not guarantees of the existing UI.

## Existing producer mapping and limits

| Producer | Current representation | How to consume |
| --- | --- | --- |
| Local worker / Little Falls cell check | v1 envelope, attempt + assessment + snapshots | Validate against v1 and enforce citation/identity/time relationships. Completion is not human approval. |
| #22 bounded review | Draft envelope with v1-compatible findings and snapshots | Preserve its draft status and partial coverage. It has no successful-assessment timestamp to advance. |
| #64 full review | Separate envelope with `checked_at`, result/review IDs, snapshots, `coverage`, `gaps`, `source_reviews`, three findings and a separate `psa` question | Display as a draft review. `checked_at` is draft-generation time, not a v1 completed-assessment event. Preserve source/page/language coverage and interpretation questions. |

The #64 findings include `unresolved_questions`, which v1 findings do not permit. Its PSA object is a rule question, not a fourth schema-validated finding. Do not feed that envelope directly to the v1 grader or silently discard its coverage fields. A future promotion/export adapter must validate each finding against the agreed rubric, retain coverage and review provenance, and explicitly create the target assessment. No such automatic promotion is implemented by #20.

For deadlines/assets/immigration, a source's silence (`not_addressed`) is neutral. An excluded privacy notice is not an N/A finding for the hospital. Applying during collections differs from an appeal deadline, processing time, collections waiting period or approval duration. Income documentation is not itself an asset-value test or an immigration eligibility condition. An absent approved service-area rule produces `unclear`, not a guessed legal rule. #64 and subject-matter review resolve those interpretations.

## Producer and consumer checks

Within each assessment, measure IDs must be unique. Snapshot IDs must be unique within the envelope. Resolve every citation to a saved snapshot, verify its SHA-256 against its bytes, and confirm the excerpt at its stated location. Schema validation checks structure; the worker and grader must enforce these relationships and the versioned rubric. Publish a completed assessment atomically with its completion time as the last success. A failed recheck carries forward the previous success timestamp, or null before the first success, and produces no assessment. Partial assessments must be identified as partial; they cannot establish a whole-hospital grade. Calculation of scores and treatment of N/A/unclear denominators belong to the approved grading rubric (#28), not to this transport format.

## Review examples

The examples are synthetic and use the existing hospital key 362 solely to illustrate the join. All observations come from the local fixture. The four findings demonstrate every outcome; the exemption is a test-only measure. The completed check reports a published amount that differs from the 2026 reference; a completed check does not imply a passing document. Publisher date remains unknown. The second example simulates a failed retrieval the following day. Reviewers can compare the dates and replay the two numeric findings from the same cited row. The checker also exercises a first-ever failed attempt and rejects an advanced success date after failure, duplicate IDs, unresolved citations and invalid result/reason pairs.

From the repository root, run the fixture check with Python 3 and the jsonschema package (with format support):

```bash
python docs/audit-format/check_examples.py
```
