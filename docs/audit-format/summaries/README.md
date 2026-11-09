# Wave 1 summary measures (#24)

**Draft model findings — human review pending.** Review date: 2026-11-08 (local); execution/capture timestamps are recorded separately in UTC. Only the designated plain-language summaries supply measure evidence. All seven PDF pages across four English/Spanish summaries were read and visually inspected.

| Hospital | AL: PSA described | AM: Applying explained | AN: Income levels included |
| --- | --- | --- | --- |
| Ellenville (1002) | yes | yes | yes |
| Little Falls (362) | no | yes | yes |

These are presence measures under `css-17-v1`, not PSA boundary compliance, current FPL dollar accuracy, adequacy of discount rates, or a hospital grade. Results: [`1002.json`](1002.json), [`362.json`](362.json). Each v1 envelope contains three findings with exact source-language quotes, page locators, source URLs, SHA-256, retrieval dates, observed values and per-language coverage. [`review.json`](review.json) records the model's source identity/campus evidence, complete reviewed pages and visual/extraction limitations. No human decisions or historical findings are replaced.

## Ellenville: both two-page summaries

- [English summary](https://erhny.org/wp-content/uploads/2024/01/2024-ERH-FA-Summary-English.pdf), SHA-256 `43520848e6f87fae9b2c60b93e3c69138f1a425eba7fadc8ac5e57513bb9a883`.
- [Spanish summary](https://erhny.org/wp-content/uploads/2024/01/2024-ERH-FA-Summary-Spanish.pdf), SHA-256 `e0c54eef21e7db1cdb65f37f777251556e63d77ddd381c5a4ae97fb34fc5bd13`.

**AL — yes, page 1:** “other necessary medical services, assistance is offered within our primary service area of Ulster, Dutchess,” followed by “Orange, Sullivan, Delaware, Greene and Columbia counties.” Spanish likewise names these seven counties. Both distinguish New York State emergency coverage from the listed primary service area. Whether these boundaries comply is a separate measure.

**AM — yes, page 2:** “You will need to fill out a financial assistance application. One can be requested/received from the” followed by “hospital or downloaded from our website: www.erhny.org.” Both give the Business Office mailing destination at 10 Healthy Way, Ellenville. Spanish starts “Deberá completar una solicitud de asistencia económica.”

**AN — yes, page 1:** “Family Size HHS Poverty Income $ 150% 200% 300%”. Spanish states “de pobreza HHS 150 % 200 % 300 %”. Both include annual dollar rows for household sizes 1–8. They explicitly print a January 17, 2024 revision; that date comes from the document, not its URL. Presence of this older table is a yes for AN, not a finding that its amounts or eligibility levels are current.

## Little Falls: designated network summaries found one link deeper

The saved roster landing HTML (`226373789547027be6f33106a3360e0716ca85bf64faa1f3f780c17bfbcb710c`) links to [Financial Assistance – Plain Language Summary](https://www.bassett.org/patients-visitors/billing-insurance/financial-assistance/financial-assistance-plain-language). That page links to the actual summaries:

- [English, one page](https://www.bassett.org/sites/default/files/2025-03/FAP-Plain-Language-Summary.pdf), SHA-256 `b3aef8b3347234aec466321191ad6a7eca495ba6d95bbfb7d19f1d3290ef1733`.
- [Spanish, two pages](https://www.bassett.org/sites/default/files/2025-03/FAP-Plain-Language-Summary-Spanish.pdf), SHA-256 `58310a62ee2674f5926f8116c3ea718bf79ebda1cb773f78bbe941bb18f68523`.

The new summary-page HTML hash is `2d93d9880035f4deb81d104430f7bc588b383ce9d6cda560656c47e97659b87b`. The capture records are in `review.json`, with retrieval timestamps and exact URLs. Files are stored locally under `.audit/live/snapshots/<sha256>.<pdf|html>`. These are new bounded child-page captures; the earlier direct-link inventory and posting results remain historical records of their original scope.

**Campus applicability is explicit, page 1:** “O’Connor Hospital, Cobleskill Regional Hospital and Little Falls Hospital (collectively \"Bassett Healthcare” continues “Network\")”. Spanish also explicitly names Little Falls. The financial-assistance summaries apply to the listed network entities, rather than only the Cooperstown campus.

**AL — no, after complete search:** The opening paragraph lists hospitals, not a geographic primary service area. English: “Financial assistance applies to medical necessary services that are provided and billed by the” followed by “entities above including emergency room care.” Neither summary gives counties, geographic boundaries or a residence-based coverage description anywhere in the reviewed pages or tables. The Cooperstown mailing address describes where to apply, not where eligible patients live. Exact opening-paragraph quotes from both languages and complete search notes accompany the `missing_after_search` finding. No absence conclusion is based solely on a keyword search.

**AM — yes, page 1:** “Submit or mail your completed application to: Attention: Financial Assistance Program, One Atwell” followed by “Road, Cooperstown, NY 13326”. Both provide web, telephone and registration routes to obtain the application and the submission destination. Spanish says “Envíe su solicitud completa por correo a: Attention: Financial Assistance Program, One Atwell Road,” followed by “Cooperstown, NY 13326”.

**AN — yes, page 1:** “financial assistance when their family household income is less than 200% of the Federal Poverty Level” and “(“FPL”). Patients with household income greater than 200% but less than or equal to 400% of FPL may” followed by “be eligible for discounted care.” The Spanish paragraph states the same thresholds. The English discount tables are images omitted by text extraction; both were visually inspected. The finding uses the explicit extracted narrative, not invented OCR. The exact-200% narrative/table boundary is outside this presence measure.

### Resource-guide scope resolved

The 15-page **Patient Financial Assistance Guide** (`46e36a10a8964085dd8c30a81f53c6407fccc9d14bed712824576c8e199c7b96`) remains a supplement, not the designated summary. Its PDF page 4 explicitly lists Little Falls contact/submission details, and page 10 describes the network Community Services Program, but it is a broader insurance/resource guide with a printed 2014 revision. The separately labeled summary page and PDFs establish the correct source scope. No guide, policy or application language was substituted into the three summary findings.

## Reproduction and checks

```powershell
# Contract, scope and language coverage (works without ignored live artifacts)
.\.venv\Scripts\python.exe tools/live-audit/verify_summaries.py
# Also re-extract original bytes, verify hashes/quotes/page counts and discovery links
.\.venv\Scripts\python.exe tools/live-audit/verify_summaries.py --root .audit/live
.\.venv\Scripts\python.exe -m unittest discover -s tools/live-audit -p "test_summaries.py"
```

The live verifier checked 20 citations across four sources/seven pages plus the Bassett discovery chain. It does not turn a model interpretation into human approval. Missing snapshots fail rather than silently re-fetch; fresh downloads must retain their own provenance and be re-reviewed if hashes differ. Public metadata and bounded evidence quotes are committed; original public PDFs remain local. These partial v1 results do not by themselves establish all 17 measures or a whole-hospital grade.

#24 is complete: both Wave 1 hospitals have all three results with quotes. Spanish **summary** review here does not complete the separate Spanish/application-language work in #72. Later discovery can inform a new posting assessment; this review does not rewrite earlier posting or cross-document findings.
