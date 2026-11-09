# Wave 1 source-specific application coverage

Reproduce with `python scripts/export-application-reviews.py`. Inputs: the portable pilot ZIP and `application-reference-evidence.zip`. No network or model calls.

These are 42 source-specific drafts, not 42 approved findings. Original-language quotations, linked income/discount rows, exact source locators, extraction metadata, historical records and reference citations are in `wave-one-application-reviews.json`.

| Hospital | Language | Segments | AD | AE | AG | AH | AI | AJ |
|---|---|---:|---|---|---|---|---|---|
| 1002 | en | 5 | unclear | yes | yes | no | yes | yes |
| 1002 | es | 6 | unclear | yes | yes | no | yes | yes |
| 1002 | pl | 6 | unclear | yes | yes | no | yes | yes |
| 1002 | uk | 6 | unclear | yes | yes | no | yes | yes |
| 1002 | ru | 7 | unclear | yes | yes | no | yes | yes |
| 362 | en | 1 | unclear | yes | yes | yes | yes | yes |
| 362 | es | 1 | unclear | yes | yes | yes | yes | yes |

## Immutable source identities

- **1002 / en**: https://erhny.org/wp-content/uploads/2024/12/ERH-FA-APP-English.pdf
  - SHA-256 `eebf29d4d7ae77615ba3841de0d93f7029230c0406711ea3d1aa373605f242c1`; retrieved 2026-11-09T00:39:13.106234+00:00; publisher date unknown.
  - 3 preserved historical application records; campus/role classification retained from the exact-byte inventory.
- **1002 / es**: https://erhny.org/wp-content/uploads/2024/12/ERH-FA-APP-Spanish.pdf
  - SHA-256 `771f2f39d5fbb2f1044eefa5d7254c5c8052d1a3680224410f9ea10640536555`; retrieved 2026-11-09T00:39:19.765357+00:00; publisher date unknown.
  - 0 preserved historical application records; campus/role classification retained from the exact-byte inventory.
- **1002 / pl**: https://erhny.org/wp-content/uploads/2024/12/ERH-FA-APP-Polish.pdf
  - SHA-256 `0938950766a70636fc92c35154deab6fc9438ffe2c2ee50a948db98e886f1d8e`; retrieved 2026-11-09T00:39:24.570384+00:00; publisher date unknown.
  - 0 preserved historical application records; campus/role classification retained from the exact-byte inventory.
- **1002 / uk**: https://erhny.org/wp-content/uploads/2024/12/ERH-FA-APP-Ukrainian.pdf
  - SHA-256 `9d77607cd5b4448934e26bbfdd603dc0df75c80baee4e6762878ced7ab494fb1`; retrieved 2026-11-09T00:39:27.890691+00:00; publisher date unknown.
  - 0 preserved historical application records; campus/role classification retained from the exact-byte inventory.
- **1002 / ru**: https://erhny.org/wp-content/uploads/2024/12/ERH-FA-APP-Russian.pdf
  - SHA-256 `ae4fffcbb353785edf46ad99e1b73ff3ed2e6d54539fe995fa0ca1300aa63058`; retrieved 2026-11-09T00:39:31.775089+00:00; publisher date unknown.
  - 0 preserved historical application records; campus/role classification retained from the exact-byte inventory.
- **362 / en**: https://www.bassett.org/sites/default/files/2026-01/2026-NYS-Bassett-FA-Form-English.docx
  - SHA-256 `3b5149e5b95b27c043114aa6f287d49a2c2c69aa5cab75671ddcb3bd057c9fb8`; retrieved 2026-11-09T00:38:59.513465+00:00; publisher date unknown.
  - 5 preserved historical application records; campus/role classification retained from the exact-byte inventory.
- **362 / es**: https://www.bassett.org/sites/default/files/2026-01/2026-NYS-Bassett-FA-Form-Spanish.docx
  - SHA-256 `ae1641c61feb9d723b29af2f33d6d0bbe41f3d76670923dc2dc6a32764c10be6`; retrieved 2026-11-09T00:39:03.338557+00:00; publisher date unknown.
  - 0 preserved historical application records; campus/role classification retained from the exact-byte inventory.

## Findings and remaining decisions

- Ellenville: all five forms print 2024 income tables (21 linked cells each), including $60,240 for one person at 400%. AH is no for each document against 2026 HHS; household size 8 is not printed. AD remains unclear pending the AD/AH overlap rule.
- Little Falls: both forms print 2026 rows 1–8 (24 cells each). The six-person 300% cell is $133,080, consistent with HHS arithmetic; the official English form prints $133,880. Neither reference is rewritten.
- All seven documents have source-specific assistance contacts, income/discount bands, explicit eligibility through 400%, and a 5% gross-monthly-income installment statement. The separate 2% interest limit is not used as the installment cap.
- English whole-form visual reviews from #78 remain hash-bound and preserved, including all 80 reference units and Little Falls drawings. English rendering is not a pending blocker.
- Translated comparisons cover eleven sections and ten fields using original-language anchors. A missing anchor means not established, not absent. These checks do not establish every translated field or declaration as semantically equivalent to an authoritative translated template. DOCX table/cell/grid/section inventories and PDF page dimensions are preserved alongside extraction.
- PDF extraction retains actual page locators (Ellenville en/es/pl/uk/ru: 5/6/6/6/7 pages). Little Falls DOCX body is one structural segment per language; rendered pagination remains unverified for Spanish. Drawing metadata is retained; English visual conclusions are not transferred to Spanish.
- Specific translation questions remain: Ukrainian immigration wording and Russian collection/data-collection wording already tracked under #64; an AD decision requires review of these provisions as well as numeric tables. No certified translation or institutional authorization is claimed.
- Little Falls campus/MRN additions, eighth row and corrected official arithmetic require a cited customization rule. Formatting alone does not produce noncompliance.
- AE/AG are qualitative source-specific presence drafts. Existing independent-review and complete-scope gates remain in force in the integrated grader. AD and all institutional grades remain pending.

## Reference compatibility

Historical HHS SHA-256 `ca97094c4f6c7a4336428e615cfec96d2951a7b4e7d5e92f6bc0def81c1d141d` is reconstructed exactly by CRLF serialization of the current reference. LF SHA-256 is `a5d7f1a25efdc18e4b1907dde8a5923bd249276b1a521a975f0a966e0a481973`. Parsed content is identical. The classifier accepts only these reconstructed representations with matching embedded content/version; arbitrary reserialization, substantive changes and missing non-current embedded references are rejected. Original hashes and decisions remain unchanged; no approval transfers.
