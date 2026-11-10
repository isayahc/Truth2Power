# Statewide audit operator release gate

Candidate built from `cb64ee1` (PR #106) with the #100 fixture, handoff and dependency updates. Reproduction uses the [independent operator procedure](pilot-operations.md#independent-operator-handoff-100). The [raw benchmark](roster-replay-benchmark.json) includes the rate card, per-run counters, revisions, runtime versions and scenario arithmetic.

## Saved-evidence benchmark

Eight sequential CLI executions replayed four evidence inventories twice in one isolated Linux store. Each started a fresh Node worker process. The source store was populated before timing. The second pass could reuse immutable bytes; it still reran extraction and grading. PFIs 1 and 2 use synthetic local transport responses on the shared Albany system. The two Wave 1 sites use packaged public originals. Unknown or other-campus documents remain outside the grading parser until classified.

| PFI | Pass | Wall s | CPU s | Max RSS MiB | Store growth MiB | Parsed PDF / DOCX | PDF pages | Reused artifacts | Unclear / 17 |
|---|---:|---:|---:|---:|---:|---:|---:|---:|---:|
| 2 | 1 | 0.38 | 0.40 | 55.8 | 0.26 | 0 / 0 | 0 | 0 | 17 |
| 1 | 1 | 0.38 | 0.40 | 56.8 | 0.23 | 0 / 0 | 0 | 0 | 17 |
| 362 | 1 | 3.53 | 3.59 | 94.7 | 6.90 | 5 / 3 | 37 | 1 | 14 |
| 1002 | 1 | 5.14 | 5.20 | 104.9 | 10.49 | 10 / 1 | 51 | 0 | 14 |
| 2 | 2 | 0.37 | 0.39 | 56.2 | 0.16 | 0 / 0 | 0 | 1 | 17 |
| 1 | 2 | 0.36 | 0.38 | 56.7 | 0.19 | 0 / 0 | 0 | 4 | 17 |
| 362 | 2 | 3.94 | 3.84 | 100.5 | 5.47 | 5 / 3 | 37 | 9 | 14 |
| 1002 | 2 | 5.16 | 5.23 | 103.3 | 6.20 | 10 / 1 | 51 | 11 | 14 |

Wall time includes worker startup. CPU includes user and system time reported by Linux wait4, including waited-for children. Max RSS is the OS high-water metric for the largest contributing process; simultaneous process memory is unmeasured. Store growth measures logical file lengths including SQLite. Receipt storage measures newly retained artifact payloads. Parser counts cover bridge invocations; the independent verifier also consumes worker time. OS filesystem cache and shared-machine load were uncontrolled.

## Monthly scenario for #41 and #42

Every replay recorded zero HTTP requests, zero downloaded bytes, zero paid-model calls and $0 incremental model charges. The explicit illustrative rate card `handoff-illustrative-v1` allocates $1 per worker wall-hour and $0.02 per decimal GB of new artifact payload for one month. These are modeling assumptions, not vendor quotes. The benchmark recomputes each receipt from elapsed milliseconds and retained bytes, then checks the persisted local subtotal. Separate ledger regressions exercise duplicate provider callbacks, cached input, missing rates, changing prices and late bills in native currency.

For **one replay per hospital per month**, multiplying the lowest and highest measured per-run allocations by 212 gives **$0.017–$0.335** under that card. The corresponding observed wall-time scenarios are approximately **1.3–18.2 minutes** of sequential execution. This four-site sample mixes deliberately sparse fixtures and richer saved originals. The range is a sensitivity scenario, not a statistical confidence interval. Live retrieval, changing sites, OCR, human review, retries, taxes, hosting and longer retention would change the result. Statewide live monthly spend remains unknown. No live benchmark or paid provider call was authorized for this gate.

## Epic #93 final acceptance matrix

| Acceptance area | Reproducible evidence | Disposition |
|---|---|---|
| Any roster key, three run modes, honest coverage | Roster tests queue 212 keys. Operations browser selects PFI 739, scans and downloads a source, replays, inspects history and observes a failed audit. | Passed offline |
| Unfamiliar facilities and 17 draft slots | New PFI 2 fixture has a missing PDF and cross-host candidate. PFI 1 includes unclassified and other-campus bytes. Wave 1 replays retain 3 resolved and 14 unclear findings per site. No final grade is authorized. | Passed |
| Retrieval, execution, assessment and due clocks | Run-history and budget suites cover failed retries, lease reclaim, timeout, cancellation and stale publication. Replay assertions check unchanged fresh/eligible clocks. Schedule preview reports due facilities without queueing. | Passed |
| Durable identity, retry and cache accounting | Concurrent CLI processes reused one request key and returned one job ID. Ledger and paid-reservation tests cover retries, repeated usage IDs and receipt reconciliation. | Passed |
| Cost and reporting API | JSON/CSV exports, cursor pagination, historical revisions, safe attachment hashes, unknown and zero costs, filtered statewide counts and operator-path redaction. | Passed |
| Historical data, review, atomic publication and recovery | Tests cover corrupt bytes, blocked redirects, source change, superseded approvals, migration/backfill and late attempts. Cold restore reproduced the full file hash inventory, SQLite integrity, receipt, decision and independent grading replay; rolling back removed the post-backup job. | Passed |
| UI and API integration | 79 Node tests, 103 Python tests, production build and all nine Chromium suites passed using the patched candidate sources and an isolated store. Desktop/mobile and Spanish implementation checks included. | Passed |
| Setup, budgets, exports and rollback | Detached checkout, lockfile install, new Python virtual environment, rate/limit documentation and backup drill. npm audit reported zero advisories. Initial pip-audit flagged MCP 1.29.0 and bootstrap pip 25.0.1. MCP 1.30.0 and pip 26.3 passed pip check and the repeat audit reported zero known vulnerabilities in this environment. | Technical drill passed |
| Independent operator handoff | Operator instructions specify expected records and a sign-off template. The implementer ran the exercise. A second operator has not recorded an outcome. | Pending |

**Closure recommendation.** Merge the engineering package if accepted. Keep #93 open through the independent operator observation, then review the matrix and record the decision. Subject-matter interpretation, institutional grade authorization and fluent Spanish review remain separate external gates. The app assumes a trusted localhost operator. Recurring statewide execution and production authentication remain outside this release.
