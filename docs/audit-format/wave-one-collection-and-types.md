# Wave 1 landing-page and document-type completion

Verified 2026-11-08 against saved original bytes. Scope: Ellenville (1002) and Little Falls (362), as selected by the user. Supports #16 and #18; does not certify compliance or complete the additional-language assessments.

## Landing pages (#16)

| Hospital | Landing page | Attempt time (UTC) | Successful retrieval (UTC) | Collection manifest under `.audit/live/collections/` |
| --- | --- | --- | --- | --- |
| Ellenville | https://erhny.org/patient-guests/financial-assistance-program/ | 2026-11-08 16:58:33.331388 | 2026-11-08 16:58:33.572258 | `1002/dffc1dee76d746829c386e3b4752424a.json` |
| Little Falls | https://www.bassett.org/patients-visitors/billing-insurance/financial-assistance | 2026-11-08 20:34:11.772480 | 2026-11-08 20:34:11.984163 | `362/833f736450a346bca5b638ecb0809a44.json` |

Both HTML snapshots exist and their SHA-256 hashes match the manifests and [inventory](wave-one-document-inventory.json). The snapshot paths are `snapshots/<landing_sha256>.html` under `.audit/live/`. Publisher update dates remain explicitly unknown; retrieval dates are not publication dates or successful compliance-assessment dates.

The collector records `attempted_at`, `completed_at`, and per-source `retrieved_at` separately. Each attempt has its own manifest. A failure has no successful snapshot/retrieval timestamp and does not overwrite a prior successful manifest. For a latest-retrieval view, select the most recent successful landing snapshot across attempts; never use the most recent attempt time as a successful retrieval. Refresh scheduling and assessment freshness remain separate deliverables (#36/#37).

Ellenville's collection is `partial` because one linked 2021 policy returned HTTP 404, **not** because its landing page failed. Little Falls's pinned collection is `complete` for directly linked PDFs/DOCX. Neither status claims recursive site coverage, material currency, or compliance.

## Document types (#18)

The machine-readable inventory gives every linked document a type, source-content quote and page/part locator when available, exact snapshot hash, language label, and classification status. Match its filename to `documents[].source_url` in the specified collection manifest for the full original URL, retrieval timestamp and saved path. All 16 link records are included; no failed download is silently omitted.

| Hospital | Type | Documents |
| --- | --- | --- |
| Ellenville | Application | English, Spanish, Polish, Ukrainian, Russian `ERH-FA-APP-*.pdf` (5) |
| Ellenville | Policy statement | English `Hospital-Financial-Assistance-FINAL-11.24.pdf`; Spanish `Hospital-Financial-Assistance-Spanish.pdf` (2) |
| Ellenville | Plain-language summary | English and Spanish `2024-ERH-FA-Summary-*.pdf` (2) |
| Ellenville | Other / `supplement` | `ERH-Privacy-Practices-2021-v1.pdf` — privacy notice (1) |
| Ellenville | Unavailable; candidate policy statement | `2021-ERH-Financial-Assistance-Policy-Procedure-English.pdf` — HTTP 404; type/content unconfirmed (1) |
| Little Falls | Application | English and Spanish `2026-NYS-Bassett-FA-Form-*.docx` (2) |
| Little Falls | Policy statement | English network `Charity-Care-and-Financial-Assistance-07-09-2026.pdf`; Spanish `Charity-Care-and-Financial-Assistance-Spanish.pdf` (2) |
| Little Falls | Other / `supplement`, summary scope unresolved | `46607191876acfcc504a7cc8048608fc.pdf` — 15-page Patient Financial Assistance Guide (1) |

**14 content-confirmed classifications; 2 explicitly flagged records.** A type-confirming title is sufficient for inventory routing, not for whole-form equivalence or translation accuracy. The Spanish and other language headings here do not constitute the five deferred six-measure reviews.

### Doubtful records and ownership

- The linked Ellenville 2021 policy is unavailable. Its filename suggests a policy but cannot establish contents. Recover/resolve under the existing missing-source review in #64; no finding may cite unavailable text.
- Bassett's resource guide is retained as `supplement` (other). Determine whether a specific section is the designated hospital plain-language summary and verify campus applicability during #24. Do not substitute this guide or the policy statement automatically for summary evidence. The PDF parser reports a missing optional font decoder; the cited title extracts successfully, but this inventory does not clear full-document extraction concerns.

### Document scope enforcement

`cross_documents.load_sources` currently infers initial types from URLs. The verifier checks those actual types against this independently content-checked inventory for every saved document. `applications.review_application` rejects a selected policy/summary/supplement instead of treating it as application evidence. Other/supplement remains outside application and summary types. Cross-document checks deliberately span types; they are not application-only checks. The summary-only evaluator is tracked in #24 and must select only the designated summary source.

This verification is pinned to these collections, not a claim that filename inference correctly classifies arbitrary future documents. New collections require their own content/type confirmation.

## Reproduce

With the saved `.audit/live` artifacts available:

```powershell
.\.venv\Scripts\python.exe tools/live-audit/verify_wave_one_inventory.py
```

The command is read-only and offline. It checks collection/extraction identity, both landing hashes and timestamp ordering, complete link coverage, failed-record evidence, each saved document hash through re-extraction, exact type quotes/locators, and the document type actually returned to evaluators. It prints metadata counts, not document contents.

Expected: Ellenville 11 records / 10 confirmed / 1 flagged; Little Falls 5 records / 4 confirmed / 1 flagged. Source bytes remain in the existing ignored local audit store; the inventory and verification command are committed for traceability.
