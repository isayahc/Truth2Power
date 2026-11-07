# Live audit JSON v1

Issue #20 defines the exchange between the worker (#53) and the grader (#28). Serialize one attempt per hospital, using its stable roster key. A completed assessment contains one finding per requested measure. Each finding inherits the hospital key, assessment ID, rubric version and guideline reference from the envelope. Store these keys with the finding if flattening to SQLite. Full grading requires all 17 distinct measure IDs. Partial extractions are valid inputs for review.

| Result | Meaning |
| --- | --- |
| yes | Cited evidence satisfies the rule. |
| no | Cited evidence contradicts the rule, or a documented search of accessible applicable sources establishes absence. For absence, cite the searched material and supply search_notes. |
| n_a | The versioned rubric grants an exemption. Explain which condition applies. |
| unclear | Evidence is insufficient, unreadable or contradictory. Route to review. |

Use observed and expected values of the type defined by the measure. Monetary tables include household size, percentage, currency and income period. Cite exact text or table cells using the snapshot ID and page, section or row. Treat the publisher date as unknown when unavailable.

## Producer and consumer checks

Within each assessment, measure IDs must be unique. Snapshot IDs must be unique within the envelope. Resolve every citation to a saved snapshot, verify its SHA-256 against its bytes, and confirm the excerpt at its stated location. Schema validation checks structure; the worker and grader must enforce these relationships and the versioned rubric. Publish a completed assessment atomically with its completion time as the last success. A failed recheck carries forward the previous success timestamp, or null before the first success, and produces no assessment.

## Review examples

The examples are synthetic and use the existing hospital key 362 solely to illustrate the join. All observations come from the local fixture. The four findings demonstrate every outcome; the exemption is a test-only measure. The second example simulates a failed retrieval the following day. Reviewers can compare the dates and replay the two numeric findings from the same cited row.

From the repository root, run the fixture check with Python 3 and the jsonschema package (with format support):

```bash
python docs/audit-format/check_examples.py
```
