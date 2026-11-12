# backend_2 — Truth2Power Spring Boot backend

API-only backend for the Truth2Power redesign. Mirrors the portfolio
optimizer's shape: Spring Boot serves `/api/*`, the React app lives in
`frontend_2/`, TiDB Cloud is the database (Phase 2).

> For demonstration only. Not medical advice. Synthetic data.

## Phase 1 — read-only atlas (done Nov 11)

Same routes and responses as the old Node backend, verified by a 38-check
parity script (`parity_phase1.py` — kept outside the repo) run against both
servers on the same data:

- `GET /api/hospitals`, `GET /api/counties`, `GET /api/coordinates.csv`
  (byte-identical files; GET + HEAD; 405 otherwise)
- `GET /api/hospitals/{id}/page` (with `?revision=` — 409 on mismatch,
  404 when unassessed)
- `GET /api/hospitals/{id}/reporting-context` (GET + HEAD)
- `GET /api/overview` (freshness, grades, findings, per-region breakdowns)

Data is read from the repo, not a database: `data/maps/*`,
`docs/hospital-pages/*`, `docs/audit-format/*`,
`references/ny-economic-regions-v1.json`, `rubrics/css-17-v1.json`, plus the
live audit records under `.audit/live/` (local JSON records and the
`audit.sqlite` pipeline publications, read via sqlite-jdbc). The repo root is
found by walking up from the working directory, so start the app from the
repo root or from `backend_2/`; override with `t2p.data-dir` /
`T2P_REVIEW_DIRECTORY` if the layout differs.

Known cosmetic difference: Tomcat renders the charset as
`application/geo+json;charset=utf-8` where Node writes
`application/geo+json; charset=utf-8` (a space). Same media type per
RFC 9110; no client distinguishes them.

## Phase 0 — what exists now

- `GET /api/health` → `{"status":"ok","app":"truth2power-backend_2"}`
- Security headers on every response (`nosniff`, `DENY`, `no-referrer`),
  same as the old Node server.
- Binds `127.0.0.1:8080` only (repo AGENTS.md rule — never `0.0.0.0`).
- Default profile: no database; JPA auto-configuration is excluded in
  `application.properties` and the app serves the files directly (Phase 1
  behaviour, unchanged).

## Phase 2 — TiDB read model + write paths (done Nov 11)

- Flyway `V1__truth2power.sql` (`counties`, `hospitals`, `assessments`,
  `measure_results`, `audit_runs`, `dataset_meta`) runs automatically under
  the `tidb` profile. **Boot 4 note:** Flyway auto-config only arrives via
  `spring-boot-starter-flyway` — `flyway-core` alone never runs migrations.
- Import the Wave 1 data (62 counties / 212 hospitals / 212 assessments /
  3604 measure results; 2 known BronxCare count quirks are stored as both
  counts and reported, never adjusted):
  ```bash
  SPRING_DATASOURCE_URL='jdbc:mysql://<host>:4000/truth2power?sslMode=VERIFY_IDENTITY' \
  SPRING_DATASOURCE_USERNAME='<prefix>.root' \
  SPRING_DATASOURCE_PASSWORD='...' \
  ./mvnw spring-boot:run -Dspring-boot.run.profiles=tidb,import
  ```
  TiDB cluster choice (Option A: new `truth2power` database on the existing
  portfolio cluster; Option B: second free Starter cluster) is a deploy-time
  pick — the code is identical either way, only the env values differ.
- Flip reads to the database with `--t2p.reads-from-db=true` (default false).
  DB `/api/hospitals` is JSON-equal to the file in roster order (compact
  output); the file path still serves the pretty-printed bytes.
- `ReviewController` (`GET /api/reviews`, `GET /api/reviews/{id}`,
  `GET /api/reviews/{id}/sources/{snapshotId}`, `POST /api/reviews/{id}/decisions`)
  and `ChangesController` (`GET /api/changes`, `/assessments/{sha256}`,
  `/snapshots/{sha256}.{html|pdf|docx}`) port the old app exactly — same
  routes, same error strings, same file/compute backing (`.audit/live/`
  result files, append-only decision JSONs, `tools/live-audit/changes.py` +
  `audit.sqlite`). No review/changes tables. POST decisions need the
  `x-review-request: 1` header (the frontend sends it via
  `api/client.js` `reviewRequest()`); without it the request is rejected
  with a bare 403.

## Phase 3 — audit engine integration (done Nov 11)

One-command startup: boot backend_2 and the audit engine comes with it.
`AuditWorkerSupervisor` launches the existing Node worker
(`backend/audit/worker.js`, untouched) as a child process with
`PORT` = this server's port and `AUDIT_DIR` = the resolved audit directory,
so the worker's demo audit fetches the fixture from backend_2 itself.
The supervisor restarts the worker **once** if it crashes, then stops
(the old app had no supervisor at all — a dead worker just left jobs
`running` with expired leases). Disable it with
`t2p.audit-worker.enabled=false`. The grading logic is **never** ported to
Java: `GradingService` shells out to `node` running a bundled wrapper
(`src/main/resources/grading/grade-wrapper.mjs`) that imports the repo's
own `backend/grading/grade.js`.

- `PilotReportingController` (`/api/pilot/v1/*`): run queue + history,
  run detail / timeline / log.json / receipt / receipt.csv, revision +
  snapshot downloads, summary, operations, and the human-intervention
  inbox + document upload + resume. Same envelopes as the old app:
  `schema_version: "audit-reporting-v1"` + machine error codes everywhere
  except the intervention routes, which carry no schema_version and
  default errors to 400.
- `PilotPipelineController` (`/api/pilot/*` non-v1): queue, hospital
  status, scan / assessment / snapshot reads. Plain `{"error": "<sentence>"}`.
- `AuditsController` (`/api/audits/*`, `/audit-demo/*`): the 362 demo
  surface, exposed here even though the old app only served it from its
  local server — the demo worker needs it, and so does `AuditPanel`.
  Demo enqueue needs the `x-audit-request: 1` header (not
  `x-review-request`).
- `GradingController` (`/api/grading/*`): hospital grading reads and the
  `/demo` report, via the Node wrapper above.
- Layer A guard (local loopback host + `x-review-request: 1` + 8 KB body
  cap, 6 MB for intervention documents) now covers POSTs under
  `/api/pilot/` as well as `/api/reviews/`. `/api/audits/` POSTs keep
  their own inline guard, as in the old server.
- Python default: every `T2P_PYTHON` spawn (worker bridge, grader
  validation, intervention PDF check, changes feed) defaults to
  `python3` when the variable is unset — `python` does not exist on
  macOS or in the sandbox. An explicit `T2P_PYTHON` is always honoured.
  The grader also needs `jsonschema>=4.18` + `referencing` in the
  Python environment (the system jsonschema 4.10.3 predates the
  `registry=` argument `validate.py` uses).

Verified Nov 11 in the sandbox (see `parity_phase3.py`, kept outside the
repo): **35/35 parity checks pass** against the old Node server on fresh
empty stores, including the grading demo report byte-identical. End to
end, the supervised worker completed the 362 demo audit (~4 s: fixture
fetch → PDF extraction → published assessment) and a v1 replay run for
hospital 1002 (published `partial`, 17 unresolved measures). What still
needs the user's Mac: a real `live`/`full_audit` run against real
`.audit/` state, an intervention round-trip against a genuinely
Cloudflare-blocked run, and the Phase 2 TiDB import.

## Run

```bash
./mvnw spring-boot:run
# then: curl http://127.0.0.1:8080/api/health
```

Requires Java 21+. No secrets in this repo: the Phase 2 datasource comes
from environment variables (`SPRING_DATASOURCE_URL/USERNAME/PASSWORD`).

## Layout (per the redesign plan)

`controller/` (HTTP only) → `service/` (logic) → `repository/` (data).
`AuditWorkerSupervisor` (Phase 3) launches the existing Node audit worker
as a child process — the Python grader is never ported to Java.
