# Wave 1 official-template comparison — 2026-11-08

Source-checked supervising-assistant notes for #72/#70/#23. These are draft observations, not human approval or whole-form equivalence findings.

## Official reference capture

- Listing: https://www.health.ny.gov/facilities/hospital/financial_assist/hosp_info/
- Download: https://www.health.ny.gov/facilities/hospital/financial_assist/hosp_info/docs/2026_uniform_financial_assistance_application.docx
- The browser clicked the listing's English 2026 DOCX link; network request 82 returned HTTP 200 from that exact URL. Browser action observed at `2026-11-08T21:07:06Z`.
- SHA-256: `558cb8933ccabf12a6b86acea145f1077cebd4c9e71fc108bacf2d07f333811a`.
- Capture ID: `9d1674693c5249fa854b159cf2010f3a`; manifest: `.audit/live/reference-captures/9d1674693c5249fa854b159cf2010f3a.json`.
- Browser network evidence: `.audit/72-reference-download-network.txt`. Import verifies bytes against the observed hash; it does not independently authenticate the session's supplied provenance or re-fetch the URL. Separate HTTP/headless clients remained blocked, so comparisons reuse the captured bytes explicitly.

## Saved comparisons

| Hospital | Packet under `.audit/live/template-comparisons/` | Verified evidence lines | Changed alignment blocks |
| --- | --- | ---: | ---: |
| Little Falls (362) | `f81fd1bb22ed4d33bcd34ac8d9d2432b.json` | 169 | 12 |
| Ellenville (1002) | `ab76b25dcdd148f1a6a890d4d5d1a4d6.json` | 249 | 17 |

All **418 evidence lines** were independently verified against re-extracted, hash-checked original snapshots. Parser `document-text-v5` adds the official footnote as `reference-80`; prior body evidence IDs are unchanged. Changed-block counts are formatting/text alignment diagnostics, not counts of violations. Earlier packets remain preserved.

The auditor saved the evidence correctly, but its initial prose incorrectly claimed that common sections were absent from the reference. Those claims are rejected: the source-checked observations below supersede the prose summaries. Compact tool delivery now includes each cited source line once instead of duplicate source/evidence copies that could exceed output limits. Even complete delivery did not make the model's interpretation reliable; source verification remains necessary.

## Little Falls: concrete differences and shared provisions

Evidence IDs refer to the Little Falls packet above; reference IDs are stable across both packets.

| Observation | Exact evidence |
| --- | --- |
| Hospital/network names and a blank MRN field are added before the common title. | `application-1`–`application-4`; `reference-1` |
| The official contact placeholders are replaced with Bassett's assistance office and telephone. This is a customization, not a missing contact section. | `application-46`; `reference-38` |
| **Six-person 300% FPL differs:** Little Falls prints **$133,080**, while the official DOCX prints **$133,880**. The HHS annual base is $44,360; multiplying by three gives **$133,080**. The hospital amount matches HHS; do not mark the hospital wrong for differing from this reference-table cell. | `application-63`; `reference-54`; `references/hhs-poverty-contiguous-v1.json`, 2026 household size 6 |
| Little Falls adds an eight-person row: $111,440 / $167,160 / $222,880. The reference body table has rows 1–7. Additional row coverage is not evidence of a prohibited omission. | `application-65`; reference table `reference-48`–`reference-55` |
| Eligibility, discounts, installments and income-proof sections occur in **both** documents. They are not hospital-only additions. | Eligibility: `application-48`–`application-55` / `reference-40`–`reference-47`; discounts: `application-67`–`application-73` / `reference-57`–`reference-63`; installments: `application-74`–`application-75` / `reference-64`–`reference-65`; income proof: `application-76`–`application-89` / `reference-66`–`reference-79` |

The six-person official value was checked directly in `word/document.xml` table cells, not inferred from line alignment. This is a specific discrepancy requiring reference-owner clarification; the versioned HHS arithmetic remains the authority for dollar checks.

## Ellenville: concrete differences and shared provisions

Evidence IDs refer to the Ellenville packet above.

| Observation | Exact evidence |
| --- | --- |
| The title is the same; PDF wrapping differs from DOCX paragraph extraction. A different-title claim is unsupported. | `application-2`; `reference-1` |
| The published table is **2024**, versus **2026** in the reference. One-person 400% is **$60,240**, versus **$63,840** in both the reference and HHS arithmetic. | `application-96`–`application-98`, PDF page 4; `reference-47`–`reference-49` |
| The hospital fills the reference's name/telephone placeholders with Ellenville's assistance office. | `application-76`–`application-77`, PDF page 3; `reference-38` |
| Both permit applying at any point during collections. This selected English application comparison does not establish a new submission deadline. | `application-57`, PDF page 3; `reference-31` |
| Eligibility, discounts, installments and income-proof sections occur in both. PDF line wrapping and bullets are not evidence that sections are missing. | `application-80`–`application-95` / `reference-40`–`reference-47`; `application-106`–`application-126` / `reference-57`–`reference-65`; `application-128`–`application-169` / `reference-66`–`reference-79` |

## Remaining limits (before #76)

The official DOCX now has **nine individually covered XML parts**, all extracted: body, footnotes, and seven empty endnote/header/footer parts. Empty parts are explicitly recorded, not treated as unreadable pages. The primary-language definition is formally cited as `reference-80`, locator `DOCX word/footnotes.xml (auxiliary part; pagination unverified)`. It corresponds to Little Falls `application-19` and Ellenville `application-28`–`application-31`. Unknown Word fields or unsupported auxiliary content still trigger review flags. XML coverage does not verify rendered pagination or visual layout.

Both whole-form findings remain **unclear** pending interpretation of permitted customizations/layout. New inbox drafts attach verified observations, exact quotes and source links, reference coverage, and specific questions:

- Little Falls: `.audit/live/application-reviews/3758793319154842aa88cc2f63339d76/results/56b15522b0a740f6969cfcbea420aecb.json`.
- Ellenville: `.audit/live/application-reviews/af547d4cb3ca48fdb95de3cf4a04d22c/results/dce4309264d54716b3f62d1e35a84d8d.json`.
- Verify visual fields, signature areas and table layout; decide permitted campus/MRN/extra-row customization; clarify treatment of the official numeric discrepancy. For Ellenville, decide whether the outdated table also fails whole-form currency under the approved rubric.

Prior drafts and human decisions remain preserved; new drafts inherit no approvals. Wave 1's application drafts remain **9 yes / 1 no / 2 unclear**. Four additional Ellenville language versions and one Little Falls Spanish version remain unassessed. Live inbox at `http://127.0.0.1:8098/` was verified for both hospitals at 1440×1000 and 390×844, with 16 pending items and no decisions recorded. Local screenshots: `.audit/72-inspection/{Ellenville,Little Falls}-v5-{desktop,mobile}.png`; verification manifest: `.audit/72-inspection/v5-verification.json`.

## #76 follow-up

The [completed whole-form review](wave-one-whole-form-review.md) supersedes the visual-review blocker above. Every rendered page and all 80 reference text units are accounted for. New drafts contain the visual section matrix, derived-PDF page links, recommendations and narrower rubric-owner questions. Both remain unclear for explicit customization/scoring rules, with outcomes unchanged.
