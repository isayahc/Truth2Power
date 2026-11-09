# Run and demonstrate the integrated pilot

Prerequisites: Node 22.13+, Python 3.10+, `npm ci`, the existing Python requirements (`python -m pip install -r tools/live-audit/requirements.txt`), and `jsonschema` as required by the grading guide. Use `T2P_PYTHON` for the interpreter containing those packages. Browser tests need Playwright Chromium (`npx playwright install chromium`). No paid model or network access is needed **after dependency installation** for synthetic audits or packaged replay.

## Offline demonstration (PowerShell)

Use a new isolated directory; leave prior audit stores intact. Apply these environment variables in both the app and worker terminals:

```powershell
$env:T2P_PYTHON=(Resolve-Path '.\.venv\Scripts\python.exe').Path
$env:AUDIT_DIR=(Join-Path (Get-Location) '.audit/SYN-pilot-demo')
$env:T2P_REVIEW_DIRECTORY=(Join-Path $env:AUDIT_DIR 'live')
$env:T2P_PILOT_DEMO='1'
npm run build
npm start
```

In the second terminal run `npm run audit:worker`. Open `http://127.0.0.1:8000/?hospital=1002`, select **Synthetic offline demo**, and queue the audit. Close the page, then reopen it. Refresh job status and reload findings. Inspect all 17 measures, immutable assessment JSON, saved evidence, overview and review inbox. The historical September 2025 rating stays separate. The synthetic calculated grade is B; institutional grade remains pending.

Queue the original again: a new completed revision, no material event. Queue **Corrected table**: calculated A, one source-change event. Queue it again: no duplicate event. Inspect **Recent changes** and its before/after snapshot downloads. The multilingual variant intentionally has unresolved coverage. Synthetic evidence is labeled and hidden from normal read views unless `T2P_PILOT_DEMO=1`.

Equivalent one-shot commands (same environment):

```powershell
npm run audit:pilot -- run --mode synthetic --hospital 1002 --year 2026 --date 2026-11-09 --request SYN-original
npm run audit:pilot -- run --mode synthetic --variant corrected --hospital 1002 --year 2026 --date 2026-11-09 --request SYN-corrected
npm run audit:pilot -- run --mode synthetic --hospital 1002 --year 2025 --date 2025-11-09 --request SYN-historical
```

Request keys are idempotent: retry the same key/context to retain the job; use a new key for a new refresh. Reusing a key with changed context is rejected. `queue` persists without executing; `work` claims one eligible pilot job; the continuous existing worker handles retries. Three failed attempts exhaust automatic retries; queue a new request after repairing the cause. Expired leases are reclaimed and stale attempts cannot publish. Content-addressed checkpoints resume preparation; changed rubric bytes require a new job. Never edit committed snapshots or decisions to repair a run.

## Reproduce the public Wave 1 reports

From a clean checkout with dependencies installed:

```powershell
Expand-Archive docs/validation/pilot-wave-one-evidence.zip .audit/portable-wave-one
npm run audit:pilot -- replay .audit/portable-wave-one/assessments/1002.json --root .audit/portable-wave-one
npm run audit:pilot -- replay .audit/portable-wave-one/assessments/362.json --root .audit/portable-wave-one
```

Both commands must report `replay: identical`, 17 measures, and pending grade. They verify original source bytes and re-run the deterministic grader without publishing a new assessment or changing retrieval dates. The ZIP contains 20 public snapshots and two bundles. Review the per-measure report in [wave-one-pilot-results.md](wave-one-pilot-results.md); full quotes, locators, source URLs and hashes live in the bundles. Earlier source-scoped drafts are preserved in `producer_records`.

For a new integrated run using an existing original evidence store:

```powershell
npm run audit:pilot -- run --mode replay --hospital 1002 --year 2026 --date 2026-11-09 --request wave1-new --evidence-root .audit/live
```

The original evidence root must include collector manifests, original snapshots and review artifacts for full available coverage. A clean checkout without those artifacts produces explicit missing-evidence blockers. The portable ZIP is sufficient for **report replay**, not a replacement for the complete collector/reviewer working directory.

## Live operation and monitoring

Use a separate non-demo `AUDIT_DIR` and `T2P_REVIEW_DIRECTORY`. Select **Collect current public documents** or use `run --mode live`. This invokes the existing bounded direct-link collector/extractor for the two Wave 1 hospitals. It has network access but no model calls. New or changed documents need classification and interpretation; inaccessible sources cannot establish violations. This release was validated against saved public bytes, not a new live collection.

`npm run audit:pilot -- due` reports the full 212-hospital denominator and next due dates. It does not install a scheduler or assert monthly coverage. Saved-evidence replay updates the execution timestamp but retains source retrieval dates; the monitoring clock conservatively uses the oldest captured hospital source. Stop refreshes and overdue/never-checked states remain visible. Failed refreshes retain the prior successful revision and expose retry status.

Back up the entire local audit directory (SQLite plus snapshots, checkpoints and decisions) while the worker is stopped. Read APIs publish only committed bundles; orphan checkpoint files are not public evidence. Reviewer decisions bind to immutable inbox subjects. They do not independently authorize an institutional grade; the existing grading decision contract remains separate.

## Automated demonstration

```powershell
npm run test:pilot
```

The browser script starts its own isolated server/worker and uses fabricated fixtures. It tests closing/reopening the browser, evidence downloads, shared revisions, unchanged/corrected/failed refreshes, mobile layout and CSRF. Screenshots: `.audit/ui/pilot/{before-desktop,after-desktop,after-mobile,changes-after-desktop}.png`. Node tests additionally cover interruption, bounded retries, multilingual history, year changes, out-of-order completion and missing original evidence.
