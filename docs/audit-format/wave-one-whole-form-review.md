# Wave 1 whole-form interpretation — #76

Reviewed 2026-11-08 by the supervising model. **Both whole-form drafts are unclear pending specified rubric decisions.** Visual/content review is complete. This is not human approval.

The versioned interpretation is [`references/whole-form-wave-one-v1.json`](../../references/whole-form-wave-one-v1.json). It binds original and rendered hashes, parser version, page-by-page observations, reviewed text exceptions, authority, recommendations and questions. Original URLs, capture provenance and exact comparison evidence IDs are in [the template comparison report](wave-one-template-comparison.md).

## Visual evidence

Every page of the official six-page Word export, Little Falls five-page Word export, and Ellenville original five-page PDF was visually inspected. Required fields, writable areas, checkboxes, certification/signature, tables and instructions remain visible. No missing section was identified. Shorter pagination comes from layout, especially the income-proof table.

| Section | Official pages | Little Falls pages | Ellenville pages |
| --- | --- | --- | --- |
| Identity and language definition | 1 | 1 | 1 |
| Household table | 1–2 | 2 | 1–2 |
| Insurance, expenses, certification/signature | 2 | 2 | 2 |
| Rights, contact, eligibility | 3 | 3 | 3 |
| FPL, discounts, installments | 4 | 4 | 4 |
| Income-proof instructions and all nine categories | 5–6 | 5 | 5 |

The original official DOCX hash is `558cb8933ccabf12a6b86acea145f1077cebd4c9e71fc108bacf2d07f333811a`.

| Artifact | SHA-256 | Render time UTC |
| --- | --- | --- |
| Official derived PDF | `4da163d0c2a4775668da0e3c4c682cc787ee218e049a23dc6d6afab0575cee71` | 2026-11-08T22:05:53.725445+00:00 |
| Little Falls derived PDF | `bb12b6c32b4c87161f42957a6c569627343606a48625cd2abaff49e8594d50ed` | 2026-11-08T22:05:56.564871+00:00 |
| Ellenville original PDF | `eebf29d4d7ae77615ba3841de0d93f7029230c0406711ea3d1aa373605f242c1` | Not derived |

PDFs are saved locally as `.audit/live/snapshots/<sha256>.pdf` and linked by page in the inbox. Original snapshots and earlier drafts remain available. Local provenance: `.audit/76/render-provenance.json`.

### Reproducing the rendering

Use Microsoft Word 16.0 on Windows with the saved public DOCX originals; verify their SHA-256 against the versioned record first. Open read-only, disable macros (`Application.AutomationSecurity = 3`), suppress conversion prompts, and export the entire document with `Document.ExportAsFixedFormat(destination, 17)` (PDF). Close without saving. This run used `Word.Application` COM automation with `DispatchEx`, `Documents.Open(ReadOnly=True, AddToRecentFiles=False, Visible=False, OpenAndRepair=False)` and `ComputeStatistics(2)` to check page counts. Inspect every exported page alongside Ellenville's original PDF.

Re-exported PDF bytes may differ because of metadata, fonts, printer settings or Word versions. A new hash is new evidence: do not replace this pinned record or claim the earlier visual review covers a different render. Preserve the new artifact and review it in a new version. The DOCX PDFs are local derivatives, not hospital-published PDFs. The original sources remain authoritative. Rendered page quotes provide navigation; completeness is supported by visual inspection plus the section matrix and text correspondence, not page-opening quotes alone.

## Authority and conclusions

[Public Health Law §2807-k(9)](https://www.nysenate.gov/legislation/laws/PBH/2807-K), displayed revision 2026-05-29, requires “utilizing only a uniform financial assistance form developed and provided by the department”. The statute was read successfully on 2026-11-08. The DOH listing and DAL fetches failed with transport/connection-reset errors; a separate statutory snapshot fetch returned 403. No verified customization guidance or approved CSS scoring interpretation was obtained. The statutory passage alone does not settle additions, corrected typos or scoring overlap.

**Resolved:** official `reference-38` says “If you need assistance with this application, please contact (HOSPITAL NAME)’s financial assistance office at (PHONE NUMBER).” Filling these placeholders is contemplated by the template. The official page-4 six-person 300% cell visibly prints **$133,880** (`reference-54`), whereas HHS arithmetic is **$44,360 × 3 = $133,080**. Little Falls prints the HHS-correct value (`application-63`). HHS remains the dollar-check authority.

### Little Falls (362): unclear

All required sections and fields are retained. Campus/MRN additions are on page 1; the extra eighth household-size row and corrected six-person amount are on page 4. Under a content-preserving customization rule, the model recommends a completeness pass. No such rule has been approved.

**Question — CSS rubric owner, or NYS DOH for legal form requirements:** May campus/MRN additions, the eighth household row and corrected HHS arithmetic count as use of the entire Uniform Application when all required content is retained? Approve a cited rule before resolving this draft.

### Ellenville (1002): unclear

All sections and fields are retained. Page 4 explicitly says “Federal Poverty Levels (2024)” and “1 Person $30,120 $45,180 $60,240” (`application-96`–`application-98`); the 2026 one-person 400% amount is $63,840. This already fails the separate FPL measure. Model recommendation: retain that established failure and withhold an additional whole-form penalty until scoring overlap is resolved.

**Question — CSS rubric owner:** Does the 2024 table also fail the entire-form measure and its automatic-F override, or only the separate FPL currency measure? Specify whether whole-form means content completeness or exact current-year template use. Also confirm whether the logo, repeated table headers and pagination changes are acceptable when all required fields/instructions remain visible; NYS DOH can clarify legal form requirements.

## Persisted drafts and verification

The bounded `hospital-auditor` runs saved new drafts with `whole_form_review_id=whole-form-wave-one-v1` and existing verified comparisons:

- Little Falls: `.audit/live/application-reviews/92a7f73f6631499d92f7cc98994c63cb/results/0c231c5f3c06435893b5e7a0a8b6aec4.json`.
- Ellenville: `.audit/live/application-reviews/b5f0c57e2a374b6284415ccee5e467b0/results/82ea3df7ac534102b25f70b2f5c7d42c.json`.

Independent re-extraction verified **80 reference units per hospital**, 165 Little Falls and 243 Ellenville correspondence citations, all source/render hashes, six reference/five hospital pages, and unchanged six-measure results against prior drafts. These citation counts include correspondence reuse and differ from the 418 distinct comparison lines verified previously. Verification metadata: `.audit/76/verification.json`. Prior drafts remain without the new interpretation; no human decision or historical grade was changed.

Outcomes remain **9 yes / 1 no / 2 unclear**. The inbox exposes conclusions, recommendations, exact questions, authority, section/page links and separately labeled derived PDFs. Live verification at `http://127.0.0.1:8098/` passed at 1440×1000 and 390×844: both hospitals, 16 pending items, no browser errors, PDF links HTTP 200, no horizontal overflow. Screenshots: `.audit/76/{Ellenville,Little Falls}-after-{desktop,mobile}.png`; earlier screenshots: `.audit/72-inspection/{Ellenville,Little Falls}-v5-{desktop,mobile}.png`. These are local artifacts, not hosted links.

Checks: 64 Python tests, 12 backend tests, production build, synthetic inbox browser checks and live desktop/mobile verification. #76's investigation deliverable is complete with explicit unresolved-rule conclusions. Rubric-owner agreement remains #67; five additional language reviews remain #72.
