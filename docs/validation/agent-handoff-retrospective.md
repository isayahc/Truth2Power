# Implementation failures and handoff — 2026-11-10

This records mistakes made by the coding assistant during this work. It is not a
claim that the audit pipeline is complete. Outstanding collector work is tracked
in [issue #112](https://github.com/isayahc/Truth2Power/issues/112).

## Failures

1. **Incorrect startup diagnosis.** I inferred what `npm run dev` did instead of
   reading the server implementation, treated HTTP 200 as proof of the correct
   UI, then launched standalone Vite without API routing. This produced a frontend
   that could not load its map. The project actually serves Vite and the API together.
2. **Ignored the worker dependency.** When runs remained queued, I improved the
   status display before checking whether the worker existed. The user had to ask
   for the check. A working web server does not imply an executing audit worker.
3. **Patched a symptom.** I manually changed Elizabethtown's roster URL to resolve
   a redirect. This was not scalable and contradicted the user's requirement.
   That manual URL change was subsequently reverted.
4. **Incomplete discovery model.** I implemented cross-domain redirect handling
   without covering directly linked, off-host documents. Hospital 324 found 15 PDF
   candidates but rejected all of them under the remaining same-host restriction.
   The external-CDN problem remains unresolved in #112.
5. **Incomplete end-to-end validation.** Initial fixes missed a second same-host
   restriction in grading. Selected tests passed while real collection scenarios
   still failed. A partial result with 17 unresolved measures is not a working
   institutional compliance assessment.
6. **Configuration mismatch.** A successful CLI test used a Python CA bundle that
   the persistent app worker did not yet use. I initially failed to verify the
   actual app-triggered path. The local worker was later restarted with the bundle,
   but another installation still needs the documented setup.
7. **Inadequate diagnostics.** I built the log download on an API that discarded
   collection errors. I tested successful download and event presence, not whether
   real failures were understandable. HTTP 403 was recorded in collection manifests
   while the downloaded log still said only `audit_failed`.
8. **Premature readiness language.** I described fixes as ready based on narrow
   checks and acknowledged missing pieces only after further user tests. Claims
   should have been limited to the exact paths exercised and unresolved limitations.
9. **Delayed implementation of the human handoff.** I described the desired flow
   without implementing it until the user explicitly pushed again. It is now tested
   with synthetic imports, but no human-completed live verification/import is claimed.
10. **CLI invocation mistake.** An npm invocation lost named arguments in this
    shell and created run 5 for the default hospital. This was a saved-evidence
    replay, not the intended live retest. It remains in history and is documented
    in `elizabethtown-source-update.md`.

## Current evidence and limits

- Run 17 was triggered through the actual app: HTTP 403, one attempt, failed URL
  and retry decision visible in the UI and log. This fixed reporting, not access.
- Run 18 was triggered through the app and created a live website-verification
  task in the inbox. It awaits human-supplied public documents.
- The synthetic browser test exercises inbox → PDF import → offline resume in
  English desktop and Spanish mobile layouts. It verifies linked runs and zero
  network requests during replay. Synthetic results are not live hospital findings.
- Run 19 remains the counterexample: completed execution, zero PDFs parsed,
  17 unresolved measures, and document-level failures missing from the run summary.
- Human import supports public blank PDFs only, up to 4 MB and 200 pages each,
  20 documents per task. Retrieval time is operator-attested. Document role and
  campus applicability are not automatically approved. DOCX import is unsupported.
- Logs now preserve structured terminal HTTP/TLS/redirect diagnostics and human
  handoff provenance. They still do not provide a complete per-resource discovery
  diagnostic report for partial runs.

## Verification expectations for the next agent

- Read the working code and process configuration before making readiness claims.
- Preserve local evidence and previous runs; do not rewrite failed historical runs.
- Solve trust and provenance policy generically, without hospital/CDN allowlists.
- Exercise collection, source inventory, schema validation, grading, reporting and
  the app-triggered persistent worker together.
- Explicitly test off-host document links, extensionless files, redirects, mixed
  campuses, browser challenges, certificate trust and private-network boundaries.
- Inspect the downloaded log from a failing and a partial real scenario. Event
  counts and an HTTP 200 response alone are insufficient acceptance criteria.
- Report what was actually verified, including unresolved checks and manual steps.
