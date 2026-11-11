# frontend_2 — Truth2Power React frontend (redesign)

Modular React frontend for the Truth2Power redesign. Mirrors the old
`frontend/` app's views and data, rebuilt as feature folders with one shared
API client and a token-based design system.

> For demonstration only. Not medical advice. Synthetic data.

## Phase 1 — read-only atlas (done Nov 11)

Ported from the old `frontend/` with the same logic, strings, class names
and behaviour:

- `features/atlas/` — statewide SVG map (pan/zoom + NYC metro inset),
  hospital search, ratings sidebar and filter
- `features/hospital/` — hospital detail, 17-measure findings, reporting
  context (languages + service area), saved-assessment check
- `features/audit/` — audit overview (coverage by region, findings,
  directory, coverage map)
- `i18n/` — English + Spanish throughout (`locale.jsx` + `spanish.js`,
  copied from the old app); hospital names, numbers and evidence quotes
  stay untranslated

Not yet: audit operations, recent changes, and the review inbox are
Phase 2/3 — the header links for them are intentionally absent, and the
hospital detail's Audits tab says so until Phase 3 lands.

## Phase 0 — what exists now

- App shell: header (brand + view nav), main area, footer — same
  structure as the old `App.jsx`.
- `src/api/client.js`: the only fetch path. Relative `/api/*` calls, proxied
  to `backend_2` (:8080) in dev. No CORS needed.
- `src/styles/tokens.css`: palette lifted exactly from the old `atlas.css`.
- Backend health status shown on the page, proving the proxy works.

## Run

```bash
npm ci
npm run dev
# open http://127.0.0.1:5173/ (backend_2 must be running on :8080)
```

## Layout (per the redesign plan)

```
src/
  api/         # client.js — every fetch goes through here
  components/  # shared, feature-free UI
  features/    # atlas, hospital, audit, review, changes — each owns its
               # components, hooks, API calls, and CSS
  i18n/        # locale provider + en/es strings
  styles/      # tokens.css (design system) + base.css
  hooks/
```
