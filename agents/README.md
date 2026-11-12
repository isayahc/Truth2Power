# Hospital audit CLI

K17: `npm run audit -- ellenville --step k17` reviews the saved English/Spanish
summaries and live assistance landing page for explicit assistance income levels.
One model call per source, no retries; source-matched thresholds and contextual
quotes are saved separately for summaries and webpages. This is a presence check,
not a current-FPL accuracy or legal-compliance verdict. F5: **Truth2Power: debug k17
summary income levels**. Inspect `language-summary/income-levels/`.

K16: `npm run audit -- ellenville --step k16` checks submission instructions in
the k2 summaries and the live financial-assistance landing page. Webpage findings
are saved with their own citations and reading status; the designated-summary
criterion still requires summary evidence. Download links and help contacts alone
do not establish a submission route. English/Spanish only, one call per source,
no retries (two summaries plus one webpage for Ellenville). Linked webpages are
not exhaustively reviewed. HTML snapshots, preparation tasks and sessions are saved.
F5: **Truth2Power: debug k16 summary application process**. Inspect the explicit
loop in `language-summary/application-process/run.ts`, quotation checks in
`validate.ts`, and submission-route checks and aggregation in `result.ts`.

Deferred follow-up: compare verified English/Spanish findings in k4 with paired
source evidence. Extraction/schema failures are processing gaps, not demonstrated
translation discrepancies. Preserve each language's evidence and outcome separately.

## Language and cost scope

All criteria now target English and Spanish. Shared discovery and reuse filtering
exclude explicitly labeled other-language documents before model calls and record
the exclusions. Unlabeled sources remain eligible; filename/link labels are budget
routing hints, not proof of content language or compliance. Earlier saved results
retain their original scope; no paid historical reruns are performed automatically.

K12: `npm run audit -- ellenville --step k12`. One extraction call per scoped
application, no repair or confirmation calls. Arithmetic and comparisons run locally
against `references/hhs-poverty-contiguous-v1.json` for the UTC assessment year.
Unverified rows are excluded individually; a verified outdated table year can establish
a draft failure even if some rows are unreadable. A pass requires the year and all
24 household-size/percentage cells. Debug using **Truth2Power: debug k12 FPL guidelines**
and `application-financialterms/fpl-guidelines/{run,validate,result}.ts`.

K13: `npm run audit -- ellenville --step k13` checks explicit eligibility through
400% FPL, rather than table headings or discretionary additional aid. One call per
English/Spanish application, no retries. Quotations and printed percentages are
validated locally; conflicting or unclear lower limits stay unresolved. F5 target:
**Truth2Power: debug k13 maximum FPL**. The source loop, validation, and per-application
decisions are in `application-financialterms/maximum-fpl/{run,validate,result}.ts`.

K14: `npm run audit -- ellenville --step k14` checks the 5%-of-gross-monthly-income
installment cap separately from interest. One call per English/Spanish application,
no retries or downloads. Ambiguous bases and conflicting caps stay unresolved.
F5 target: **Truth2Power: debug k14 installment cap**. Source iteration and named
intermediate values are in `application-financialterms/installments-cap/run.ts`;
quotation validation and aggregation are in `validate.ts` and `result.ts`.

K15: `npm run audit -- ellenville --step k15` reviews the summaries identified by k2
for an explicit primary/non-emergency service-area description. It preserves
emergency coverage separately and does not decide legal boundary compliance (k5).
English/Spanish only, one call per summary, no retries or downloads. F5 target:
**Truth2Power: debug k15 summary service area**. The explicit source loop and
validation/determination functions live in `language-summary/service-area-described/`.

Run from the repository root with **Node.js 26+**, the existing OpenCode/Bedrock
configuration, and AWS credentials supplied through the default credential chain.
The CLI uses Amazon Bedrock Nova Micro by default. Each executed criterion can
make multiple model calls (typically one per document); saved prerequisites avoid
repeating those calls. Help and CLI tests make no model calls.

```sh
npm run audit -- ellenville
npm run audit -- ellenville --step k6
npm run audit -- ellenville --through k6
npm run audit -- ellenville --step k6 --refresh
npm run audit -- --help
npm run test:agents-cli
```

- Hospital only: run all implemented criteria, currently k1–k17.
- `--step`: run that criterion; reuse intact prerequisite inventories or run
  missing prerequisites. Requested criteria always execute again.
- `--through`: execute k1 through the selected criterion.
- Default: reuse downloaded sources where available. The existing k3 search
  still checks live hospital pages and may fetch newly discovered documents.
- `--refresh`: ignore older inventories; run required prerequisite steps with
  fresh sources, then reuse those sources within this run.

Hospital names, IDs, and aliases resolve through `hospitals.ts`. Add a verified
financial-assistance URL there for another hospital. Unknown names are rejected.
Add subsequent criterion implementations in `steps.ts`, with their source dependencies.

Run manifests are saved after each step under
`.audit/hospitals/<hospital-id>/runs/<run-id>.json`. Individual results, evidence,
and task graphs remain in `.audit/agents/`. Existing pre-CLI runs are discovered
automatically; hospital identity, criterion identity, and source hashes are checked
before reuse. Reused source retrieval dates and artifact paths are printed.
Old failed-source gaps are retained; reuse does not make missing evidence complete.

An unresolved (`null`) finding is a completed assessment, not an execution error.
An execution error stops the flow and produces a nonzero exit code. Completed
criterion artifacts remain available for the next invocation; abrupt termination
can leave a manifest marked `running`. Rerun the command to discover completed
prerequisites. This resumes at criterion boundaries, not individual model calls.

Use the VS Code F5 target **Truth2Power: audit CLI (Ellenville k6)** and edit its
arguments to debug another step. `example.ts` is a minimal programmatic example.

For k7 run `npm run audit -- ellenville --step k7`, or choose **Truth2Power: debug
k7 asset checks** in F5. Set breakpoints in
`website-and-policy/asset-checks/run.ts` at the source loop, `validate.ts` at
quotation/confirmation checks, and `result.ts` at `determineAssetChecks`.
The variables `source`, `reading`, `candidates`, `decisions`, `reviews`, and
`confirmations` expose each stage. Both favorable and restrictive interpretations
get a separate agent confirmation; ambiguous statements remain unresolved.

For k8 run `npm run audit -- ellenville --step k8`, or choose **Truth2Power: debug
k8 immigration barriers** in F5. Breakpoints go in
`website-and-policy/immigration-barrier/run.ts`, `validate.ts`, and `result.ts`.
It uses the same explicit source loop and separately confirms favorable and
restrictive findings. Optional fields and treatment rights are distinguished from
aid eligibility; unclear Medicaid prerequisites and translations remain unresolved.

For k9 run `npm run audit -- ellenville --step k9`, or choose **Truth2Power: debug
k9 uniform application** in F5. The explicit loop lives in
`application-financialterms/uniform-application/run.ts`; `validate.ts` verifies
page/section coverage and paired source quotations; `result.ts` records the outcome.
This step reuses k1's identified applications and the pinned 2026 NYS English DOCX
plus its derived PDF render already saved under `.audit/live/snapshots/` (hashes and
official URL in `reference.ts`). Missing or corrupt reference files leave the result
unresolved; no silent download or replacement occurs. This is a provisional text
comparison, including translated applications. Visual completeness, template
applicability, permitted customization and FPL scoring overlap are still unresolved;
k9 therefore does not yet issue a yes/no compliance verdict. Prior visual-review
notes are not treated as a fresh or approved visual review.

For k10 run `npm run audit -- ellenville --step k10`, or choose **Truth2Power: debug
k10 application contacts** in F5. Its source loop, quotation/format validation,
confirmation, and per-application verdict are in
`application-financialterms/contact-information/`. It reuses identified applications
and fetches at most four live hospital financial-assistance/contact/billing pages.
Web-only contacts cannot satisfy the application criterion. A yes requires a
source-matched, separately confirmed application-help channel on every identified
application; failed or silent readings remain unresolved. This presence check is
scoped to saved applications, not a certification of all current forms. Telephone
format is checked for US numbers, including extensions; actual reachability is not
tested. Contact matches on the website are corroboration, not a replacement for
document evidence. General billing, patient fields and complaint-only lines do not
qualify. Explicit application-help advocates are separately labeled.

For k11 run `npm run audit -- ellenville --step k11`, or choose **Truth2Power:
debug k11 income and discount tables** in F5. Code lives in
`application-financialterms/income-discount-tables/` with an explicit source loop.
Both tables require quoted headers, two distinct example rows, quoted cell values,
and a separate model confirmation of row/column relationships. A yes requires both
tables on every identified application. Missing/failed readings remain unresolved;
one schema/citation repair attempt is allowed and traced. No PDFs are downloaded
again. Presence does not establish current-year FPL amounts or correct discounts;
those belong to separate criteria. Set breakpoints in `run.ts`, `validate.ts`, and
`result.ts` to inspect `source`, `reading`, `decisions`, and per-application outcomes.

This pipeline uses public non-sensitive hospital materials; tests use synthetic
fixtures. Evidence quotation matching does not prove the model's interpretation
is correct. In particular, k6 has known overly broad favorable interpretations
requiring further validation. Results are drafts for human review. Production use
with PHI would require a BAA, HIPAA-eligible services, and institutional
IRB/privacy/security review.
