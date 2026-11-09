# #64: rule and interpretation decisions

Follow-up: **2026-11-09**. [Verified evidence and coverage](ellenville-full-review.md); machine-readable original-language citations in `ellenville-full-review.json`. This records research and pending decisions, not approval of a governing rule or a hospital finding.

## Service-area rule (V)

The Senate's [Public Health Law §2807-k](https://www.nysenate.gov/legislation/laws/PBH/2807-K) page was read during this follow-up. It displayed the most recent revision as **2026-05-29**. That revision date is not a determination of each provision's effective date.

Section 9-a(f) distinguishes financial aid for emergency services to New York residents from medically necessary services for residents of a hospital's primary service area determined by commissioner criteria. Subparagraphs (i)–(iii) address avoiding underserved/uninsured communities, statewide geographic coverage, and notification/reporting of PSA changes. Section 9-a(g) permits extending non-emergency aid outside the PSA. EMTALA treatment obligations alone are not proof of financial-aid geographic scope.

Ellenville's English/Spanish summaries list **Ulster, Dutchess, Orange, Sullivan, Delaware, Greene and Columbia** counties for medically necessary services, and NY-resident emergency coverage. Exact full-page evidence is in the replay JSON, with original URLs/hashes. The observed county list is not a verified required-county set.

An official guidance lead was discovered: [DOH letter, February 16, 2007](https://www.health.ny.gov/professionals/hospital_administrator/letters/2007/ceo/2007-02-16_financial_aid_doh_requirement.pdf). Its search result refers to a “Hospital Primary Service Areas by County of Location” list. **Its original PDF was not captured or reviewed**: local HTTPS and browser retrievals failed with connection resets; the text fetch tool does not support PDF output. Do not treat the search excerpt as the table or infer its Ulster row. A [2025 DOH financial-assistance letter](https://www.health.ny.gov/facilities/hospital/financial_assist/docs/25-04_hospital_financial_assistance.pdf) is linked on the current [DOH FAL page](https://www.health.ny.gov/facilities/hospital/financial_assist/), but its PDF was also not reviewed here.

**Decision needed:** obtain the original county table and applicable amendments, establish its effective/applicability dates for 2026-11-09, and obtain Ellenville's relevant filed boundary/changes or confirmation of the applicable default. Then a CSS/policy reviewer must record the rule decision and separately assess the hospital's emergency/non-emergency scope. Rule approval remains pending. The Senate and DOH HTML pages were read through the web tool, but no original-byte authority capture is included in the offline package; they are research references, not a newly approved machine-executable rule.

## Submission timing (W)

Favorable evidence: English/Spanish policy and English/Spanish/Polish/Ukrainian applications permit applying during collections. The model review records six supportive observations.

Questions: does policy “completed in a timely manner” / “completar oportunamente” after a Medicaid denial create an enforceable cutoff, or describe cooperation without forfeiting the right to apply? Does Russian “период сбора данных” mean a limited data-collection window, or is it a mistranslation of debt collection? Obtain authoritative clarification/corrected language. No fixed submission deadline is inferred from these phrases. Appeals, decision-processing, collection-wait and approval-duration observations remain separate.

Section 9-a(e) expressly permits applying at any time during collections and separately requires a decision within thirty days of a completed application. The two clocks must not be conflated.

## Assets (Y)

Favorable evidence: the English policy states eligibility is determined solely on household income and assets such as house/car may not be considered. Summaries and landing text are also favorable. Five supportive observations remain cited.

Questions: does “After all third party and personal resources have been exhausted” impose an asset/spend-down prerequisite despite the express prohibition? Does Spanish “Es posible que no se tengan en cuenta los bienes” convey a mandatory prohibition, or discretionary treatment? Resolve both passages together. No explicit asset test has been established by this review. Bank/benefit/income documentation and income from assets are not themselves asset eligibility tests.

## Immigration (Z)

Favorable evidence: eight observations prohibit immigration-based eligibility restrictions. The Ukrainian “статус іммігранта не є підставою для призначення фінансової допомоги” is ambiguous in equivalence to that prohibition; it is not classified as an explicit exclusion.

Additional reviewer question from the statute follow-up: §9-a(e)'s permission to require a Medicaid application expressly excludes patients who would not qualify based on immigration status. Reconcile Ellenville's Medicaid/cooperation/denial-letter procedure with that exception and its nondiscrimination clauses. This question was not separately decided in the historical review; it is a follow-up, not a retroactive alteration of that result.

## Coverage and approvals

- The linked [2021 policy](https://erhny.org/wp-content/uploads/2021/12/2021-ERH-Financial-Assistance-Policy-Procedure-English.pdf) again returned **HTTP 404** on 2026-11-09 through the web fetch tool. The package preserves the original failed collection record; this follow-up is a separate retrieval observation. Obtain the missing document or an authoritative withdrawal/supersession statement. Do not silently remove the gap because the 2024 policy is available.
- All 11 captured sources and all 52 units are accounted for. Ten sources were reviewed for eligibility; the privacy notice was fully read and excluded with scope evidence. Five languages and 22 model revisions are retained.
- `scripts/export-full-review.py` revalidates original bytes, complete source/page inventories, every saved revision's quotations, and the preserved aggregate. It cannot validate a model interpretation or establish website-wide completeness.
- Human review is pending. Record exact-result decisions through the existing human CLI/review inbox, separately from model observations. #20/#67 contract agreement is not individual-finding approval.
- **Keep #64 open** until the evidence/rule questions and required human decisions are resolved. Passing replay/tests is engineering verification only.
