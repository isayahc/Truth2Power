# Ellenville: four-measure full-review evidence (#64)

Reproduce: `.venv/Scripts/python.exe scripts/export-full-review.py`. Offline; no model calls.

The ZIP preserves original source bytes, collection/extraction manifests, every source-review revision and historical results. The JSON adds URL/hash/date to every finding citation. This is verified replay of the 2026-11-08 model review, with a 2026-11-09 follow-up; human review remains pending.

## Complete source coverage

| Source | Language | Reviewed units | Status | Revisions |
|---|---|---:|---|---:|
| s1 | English | 1/1 | reviewed | 2 |
| s2 | English | 6/6 | reviewed | 2 |
| s3 | Spanish | 6/6 | reviewed | 2 |
| s4 | English | 5/5 | reviewed | 2 |
| s5 | Spanish | 6/6 | reviewed | 2 |
| s6 | Polish | 6/6 | reviewed | 2 |
| s7 | Ukrainian | 6/6 | reviewed | 2 |
| s8 | Russian | 7/7 | reviewed | 2 |
| s9 | English | 2/2 | reviewed | 2 |
| s10 | Spanish | 2/2 | reviewed | 2 |
| s11 | English | 5/5 | unrelated | 2 |

Ten sources reviewed for eligibility, one fully read privacy notice excluded with scope evidence. Total: landing page plus 51 PDF pages, five languages, 22 model-review revisions. Delivery alone is not review.

## Findings and precise blockers

### `posted_materials.primary_service_area_boundaries_compliant` — unclear

- Obtain the commissioner's PSA criteria and Ellenville's filed/approved service-area boundaries for the review date; assess emergency NY-resident coverage separately from medically necessary non-emergency services.
- Verify the 2007 DOH county-of-location table and whether it remains applicable on 2026-11-09, including later revisions and any hospital-specific boundary changes. The PDF was discovered but original bytes could not be captured in this follow-up.
- Obtain a separate human decision on the governing rule and the exact hospital finding. A matching county list or source URL is not approval.

### `posted_materials.no_submission_time_limit` — unclear

Found 6 supportive observations; 3 ambiguous observations. Remaining coverage gaps: [{"url": "https://erhny.org/wp-content/uploads/2021/12/2021-ERH-Financial-Assistance-Policy-Procedure-English.pdf", "reason": "source_not_downloaded"}] Interpretation questions: After a Medicaid denial, the application must be completed in a timely manner. No interval is specified; clarify how this is reconciled with applying anytime. The application must be completed oportunamente after a denial letter, with no defined interval; reconcile with the anytime provision. Allows applying at any time during data collection (period sbora dannykh). This differs from debt collection in the English form; clarify intended temporal scope rather than infer a definite deadline or unlimited collections access.

- After a Medicaid denial, the application must be completed in a timely manner. No interval is specified; clarify how this is reconciled with applying anytime.
- The application must be completed oportunamente after a denial letter, with no defined interval; reconcile with the anytime provision.
- Allows applying at any time during data collection (period sbora dannykh). This differs from debt collection in the English form; clarify intended temporal scope rather than infer a definite deadline or unlimited collections access.

### `posted_materials.no_evidence_of_asset_checks` — unclear

Found 5 supportive observations; 2 ambiguous observations. Remaining coverage gaps: [{"url": "https://erhny.org/wp-content/uploads/2021/12/2021-ERH-Financial-Assistance-Policy-Procedure-English.pdf", "reason": "source_not_downloaded"}] Interpretation questions: The earlier procedure refers to exhausting personal resources before evaluation. Scope is unspecified; reconcile with the express asset prohibition rather than assume an asset test. Es posible que no se tengan en cuenta los bienes is weaker than an unequivocal asset prohibition; earlier personal-resource exhaustion language also needs reconciliation. No explicit asset test is established.

- The earlier procedure refers to exhausting personal resources before evaluation. Scope is unspecified; reconcile with the express asset prohibition rather than assume an asset test.
- Es posible que no se tengan en cuenta los bienes is weaker than an unequivocal asset prohibition; earlier personal-resource exhaustion language also needs reconciliation. No explicit asset test is established.

### `posted_materials.no_immigration_status_barrier` — unclear

Found 8 supportive observations; 1 ambiguous observations. Remaining coverage gaps: [{"url": "https://erhny.org/wp-content/uploads/2021/12/2021-ERH-Financial-Assistance-Policy-Procedure-English.pdf", "reason": "source_not_downloaded"}] Interpretation questions: Text says immigrant status is not a basis for awarding aid. This is not an explicit immigration exclusion, but its equivalence to the English prohibition on using immigration as an eligibility criterion needs qualified translation review.

- Text says immigrant status is not a basis for awarding aid. This is not an explicit immigration exclusion, but its equivalence to the English prohibition on using immigration as an eligibility criterion needs qualified translation review.

## Favorable evidence and context

- Policies/applications permit applications during collections. “Timely” completion after Medicaid denial and Russian “data collection” wording need interpretation; neither is automatically a fixed submission deadline.
- English policy excludes assets; income from assets and income documentation do not establish an asset eligibility test. Resource-exhaustion and Spanish asset wording remain reconciliation questions.
- Policies and applications prohibit immigration-based eligibility restrictions. The Ukrainian phrase is not treated as a definite exclusion. The law’s Medicaid-application exception for immigration-ineligible patients also merits reviewer attention; the historical draft did not separately decide it.
- Appeal deadlines, processing periods, collection waiting periods and approval duration remain distinct timing contexts in the saved observations.

## External follow-up

- The linked 2021 policy returned HTTP 404 again on 2026-11-09. It remains a coverage gap, not a finding that the hospital has no policy. Obtain the document or authoritative withdrawal/supersession confirmation.
- See [rule and interpretation questions](issue-64-review-questions.md) for current statute context, the discovered DOH service-area guidance lead, retrieval limitations and decisions needed.
- #20/#67 subject-matter agreement and exact-result approval remain pending. Do not close #64 or promote these drafts based on passing software checks.
