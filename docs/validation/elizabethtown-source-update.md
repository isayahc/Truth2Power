# Automatic source migration validation — 2026-11-10

Hospital key: `303`.

Run `audit-run-4` failed on three collection attempts. Each saved manifest recorded
`Document or redirect is outside the roster site's HTTPS host` before any bytes
were downloaded. The historical failed run is retained.

The former roster URL, `https://www.ech.org/About-Us/financial-assistance`, returned
HTTP 301 with Location
`https://www.uvmhealth.org/patients-visitors/billing-insurance/financial-assistance`
(observed 2026-11-10). The destination was fetched over HTTPS and explicitly lists
an **Elizabethtown Community Hospital** section with application, policy, summary,
and credit/collection links. An initial manual roster edit was reverted: the
collector now discovers the migration from the original URL at run time.
The roster and September 2025 source audit record remain unchanged.

This is a shared network page, also covering Vermont hospitals and other New York
campuses. Updating the starting URL does not establish campus applicability for
every linked document. Existing host restrictions and scope checks remain active.

HTTPS server redirects can delegate retrieval across domains. Each hop retains
public-address DNS validation, pinned TLS with hostname verification, resource
limits, loop detection and the hop cap. Ordinary off-host HTML links do not gain
trust. Only the final landing host becomes an additional traversal origin for
this collection. Every successful redirect chain is preserved in the collection,
source inventory and assessment snapshot and checked again during grading.
It does not establish campus or clinical applicability.

Blocked scope, private destinations, loops and hop limits produce allowlisted
diagnostic codes and stop automatic retries. Raw exceptions are not exposed.

## Live retest

The generic implementation was tested with **unchanged roster URLs**:

- `audit-run-10`: Alice Hyde (`15485`), completed with partial findings in one attempt.
- `audit-run-11`: Elizabethtown (`303`), completed with partial findings in one attempt.

Both followed the original hospital-domain HTTP redirect to UVM automatically.
All 17 measures remain unresolved: document discovery/campus interpretation is
still incomplete. No claim of a complete compliance audit is made.
Run 9 exposed a second same-host restriction in grading; that test run was
cancelled after diagnosis. The final fix propagates and validates redirect
provenance through grading rather than bypassing it.

Regression checks cover cross-host TLS/DNS pinning, private DNS rejection, loops,
ordinary external links remaining blocked, forged/missing redirect provenance,
preservation of unknown campus scope, and non-retryable failure recording.

### Earlier manual-URL experiment (superseded)

`audit-run-6` ran a fresh `full_audit` for hospital `303` on 2026-11-10 using
the project virtual environment. It published a partial 17-measure assessment
after one attempt, with 32 network requests, 3,603,601 downloaded bytes, nine
HTML parses, and zero paid model calls. All 17 measures remain unresolved.
No PDF/DOCX was parsed. The collection records non-HTML resource pages,
traversal limits and additional out-of-host links; campus/document discovery
needs further work. The landing redirect failure is resolved, not overall
evidence completeness.

Revision: `7d85ea67e616a102e65bb940f80a375a58271a10bddbda05ba94ba6758f213c7`.

The initial npm CLI invocation dropped named arguments under this shell and
created `audit-run-5`, a saved-evidence replay for the CLI's default hospital
`1002`. It is not the Elizabethtown retest. The targeted command used for run 6:

```powershell
$env:T2P_PYTHON = "$PWD\.venv\Scripts\python.exe"
node backend/audit/pipeline-cli.js run --hospital 303 --mode full_audit --date 2026-11-10 --request ech-source-fix-20261110
```
