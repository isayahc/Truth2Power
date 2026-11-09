# Audit reporting API v1

Base path `/api/pilot/v1`. JSON responses carry `schema_version: "audit-reporting-v1"` and disable caching. The API reads the configured local review directory in a single SQLite snapshot per request. Synthetic demo jobs are excluded. A clean store returns empty history and the full roster denominator. Start the local worker once to migrate a pre-history store.

| Method and path | Contract |
|---|---|
| POST `/hospitals/{key}/runs` | Queue one job. Required JSON fields are `request_key` (1–100 alphanumerics/hyphens), `year` (2025 or 2026), matching ISO `review_date`, and `mode` (discovery_only, full_audit, live, replay). Optional `discovery_bounds` uses the collector's existing limits. Returns 202 and the stable run URL, including on an identical retry. |
| GET `/hospitals/{key}/runs` | Hospital identity, operational clocks, newest-first page of run summaries. A roster key may be a numeric PFI or the roster's local key. |
| GET `/runs/{audit_run_id}` | Status, mode, execution times, attempt history, unresolved count, published scan/assessment IDs and links. Attempt IDs are stable hashes for correlation. |
| GET `/runs/{audit_run_id}/timeline` | Oldest-first event page. Includes sequence, timestamp, state, public attempt ID, known worker stage and reason code. Legacy jobs can have attempt records without events. |
| GET `/runs/{audit_run_id}/revision/{sha256}` | Requires a committed revision bound to this exact job. Returns a page of source identities and, for assessments, the 17 measure IDs and outcomes. Each captured source links to a hash-verified binary attachment scoped to its run and revision. |
| GET `/runs/{audit_run_id}/receipt` or `/receipt.csv` | One logical-run receipt including all retry work and any later billing reconciliation. CSV is a header and one row; structured columns contain quoted JSON. |
| GET `/summary` | Roster denominator, eligible facilities, distinct facilities with matching runs, run counts by status, usage totals, known money subtotals and incomplete receipt count. Each logical run contributes once. |

The three paginated reads take `limit` (default 25, maximum 100) and the previous response's `next_cursor`. Stop at null. Hospital cursors walk descending job IDs; timeline cursors walk ascending event sequences; immutable revisions use source offsets.

Summary filters are `pfi` (roster key), `region` (exact NY economic region), `from` / `to` (inclusive UTC queue dates), `status` (queued, running, retrying, failed, cancelled, partial, completed), `mode`, and `evidence` (unknown, partial, complete). Date filters exclude legacy jobs with unknown queue dates. Geography limits the eligible denominator; run predicates affect the matching numerator. A hospital with multiple qualifying retries still represents one facility.

Clocks are independent. Last attempted is a claim, completed execution includes replay, fresh retrieval comes from capture timestamps on committed live publications, and last eligible assessment comes from the newest live/full published job. Next due is 30 days after fresh retrieval. Unknown timestamps are null.

## Example

```bash
curl -sS -H 'Content-Type: application/json' -H 'X-Review-Request: 1' \
  -d '{"mode":"replay","year":2026,"review_date":"2026-11-09","request_key":"example-739"}' \
  http://127.0.0.1:8000/api/pilot/v1/hospitals/739/runs
curl -sS http://127.0.0.1:8000/api/pilot/v1/runs/audit-run-1/receipt.csv
```

Selected fields of an illustrative offline receipt:

```json
{"audit_run_id":"audit-run-1","cost_status":"partial","complete":false,"known_billed_usd":0,"billed_by_currency":{},"estimated_local_usd":null,"calculated_provider_usd":null,"zero_incremental_api":true,"unpriced_units":["elapsed_ms","storage_bytes"]}
```

USD fields are known subtotals. Missing amounts are null in JSON and empty CSV cells. A recorded zero incremental API charge can coexist with unknown local cost. `billed_by_currency` preserves reported native amounts. `units` and `stage_usage` report milliseconds, bytes, request/artifact/document/page counts and reported token counts by type. The hash of the queue-pinned pricing card and its effective date identify pricing provenance. Receipts with no usable prices or recorded charges say unknown; incomplete receipts with known amounts say partial. Aggregate subtotals can contain known values alongside incomplete runs. A total with no known contributors is null.

Local writes require the existing review-request header, loopback Host and allowed Origin and are capped at 8192 bytes. These controls assume a trusted local operator. Error responses carry a stable `error` code. 400 covers invalid requests, dates, filters or parameters; 403 forbidden; 404 unknown hospital, run, revision or endpoint; 405 unsupported method; 409 idempotency conflict; 413 oversized body; 422 revision integrity failure; 503 migration required; 500 report unavailable. The localhost server may reject an unsafe or oversized POST before JSON dispatch and return an empty 403/413.
