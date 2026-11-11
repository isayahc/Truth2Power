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
- No database yet: JPA auto-configuration is excluded in
  `application.properties` until Phase 2 wires TiDB.

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
