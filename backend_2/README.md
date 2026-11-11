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
