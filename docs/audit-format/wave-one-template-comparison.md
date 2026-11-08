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
| Little Falls (362) | `eca1d67de925400c9c077f81e333db81.json` | 168 | 11 |
| Ellenville (1002) | `f15d388d259344bbb3e05497a2d0f629.json` | 248 | 17 |

All **416 evidence lines** were independently verified against re-extracted, hash-checked original snapshots. Changed-block counts are formatting/text alignment diagnostics, not counts of violations. Earlier packets remain preserved.

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

## Remaining limits

The official DOCX body extraction is flagged `needs_review` because it has footnotes and header/footer parts. Direct auxiliary-XML inspection located the primary-language definition in `word/footnotes.xml`; it must not be called missing merely because it is absent from body-only evidence. A local auxiliary inspection text is saved at `.audit/72-inspection/reference-extra-text.txt`, bound to the same original reference snapshot. This inspection is not a rendered-layout check or a replacement for formally cited auxiliary-part extraction.

Both whole-form findings remain **unclear** pending complete reference coverage and interpretation of permitted customizations/layout. No original application finding, human decision or historical grade was changed by these comparison packets. Wave 1's application drafts remain **9 yes / 1 no / 2 unclear**. Four additional Ellenville language versions and one Little Falls Spanish version remain unassessed.
