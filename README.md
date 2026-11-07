# Truth2Power

Truth2Power maps how 212 New York hospitals scored in the Community Service Society of New York’s September 2025 financial assistance review. Select a hospital to see its rating, latitude and longitude, financial assistance page, and source audit row.

## Run the React app

Install Git and Node.js 22.13 or newer with npm. Run these commands in a terminal (including WSL2 on Windows).

```bash
git clone https://github.com/isayahc/Truth2Power.git
cd Truth2Power
npm ci
npm run dev
```

Open [http://127.0.0.1:8000/](http://127.0.0.1:8000/) in your browser. The same app is available at `/maps/`. The Node.js server serves the React frontend and the local datasets on one port. Press **Ctrl+C** to stop it.

### Run the production build

After installing dependencies, stop the development server, then run:

```bash
npm run build
npm start
```

Open the same local URL. To choose a different port on Linux or WSL2, use `PORT=8080 npm start`. Both modes bind to the loopback interface.

### Open the standalone map offline

For the original self-contained map, download [maps/index.html](maps/index.html) using GitHub’s **Download raw file** button and open the file in a browser. This HTML snapshot includes its own data. The React app reads the files in `data/maps/` each time you load the page.

## Check that it’s working

The statewide map should show **212 hospital locations**. Select **0 ★** in the rating legend to show the four hospitals that had no application posted. Choose **Show all**, then select any hospital to see its latitude and longitude.

## Data and rating definitions

- [Map guide](maps/README.md) explains the star ratings and how the coordinates were matched.
- Browse the [hospital audit records](data/) for one JSON file per hospital.
- [CSV coordinates](data/maps/hospital-coordinates.csv) and [GeoJSON points](data/maps/hospitals.geojson) are available for use in other mapping tools.

## Application layout

- `frontend/src/` contains the React map, search, ratings, and hospital details.
- `backend/src/local-server.js` serves the frontend and adapts local requests for the read-only dataset handler in `backend/src/handler.js`.
- `GET /api/hospitals` returns hospital points, `GET /api/counties` returns the 62 county boundaries, and `GET /api/coordinates.csv` returns a coordinate table.

The demo uses public hospital-level audit data and facility coordinates. It requires no AWS credentials. The September 2025 grades describe hospital policies at the time of the review. Production use with patient information would require privacy and security review, appropriate agreements, and eligible services. The API handler accepts API Gateway HTTP API v2 events for a future Lambda deployment; the built frontend can be served as static assets.

### Run a background audit

Use Node 22.13+ with built-in SQLite, install Poppler (`sudo apt install poppler-utils` on Ubuntu/WSL), then run `npm ci` and `npx playwright install chromium`. From the repository root, start `npm run dev` and, in a second terminal, `npm run audit:worker`. Both use port 8000 and the same local `.audit/` directory by default. Set the same PORT and AUDIT_DIR in both terminals to override them. CHROMIUM_PATH optionally selects an installed Chromium executable.

Open Little Falls Hospital and select **Recheck application**. This first audit uses a labeled synthetic hospital page and a PDF with a one-person 400% FPL row. Choose 2025 and then 2026 to compare the identical PDF against two reference years. The panel shows the latest completed finding and lets you inspect the saved evidence. This demonstration evaluates one measure and produces a partial assessment for #28. The statewide map grades describe the historical audit.

SQLite stores queued jobs, rule and reference context, attempts, prior findings, reviewer notes, extraction cache and successful envelopes. SHA-256-addressed snapshots live under `.audit/snapshots/`. A stopped worker's lease expires after 90 seconds. The next worker retries the job and reuses any cached extraction. A failed retrieval can be retried with Recheck. To process just one queued job use `npm run audit:worker -- --once`.

To replay a saved assessment, read the JSON in the SQLite assessments.output column. It uses schemas/live-audit-v1.schema.json. The observations, expected values and immutable PDF citation are available without another browser call.

Record a reviewer note for the pilot with `node backend/audit/correction.js "reviewed correction"`. Subsequent jobs include it as prior context. The evaluator bases the new finding on the newly retrieved application.

Run the browser regression with `npm run test:audit`. It starts an isolated server and database, interrupts a claimed job, rechecks the same PDF under both references and opens its saved citation.

### Audit the real Little Falls site with OpenCode

The `hospital-auditor` primary agent starts at Little Falls Hospital's URL from the roster. Its two local MCP tools discover the English application and policy, verify campus coverage in the policy PDF and compare the application’s one-person, 400% FPL table cell with the 2026 HHS reference. It saves a partial live assessment under `.audit/live/assessments/`. The React recheck panel continues to run the synthetic SQLite pilot. This live workflow reads DOCX and PDF directly and requires Python 3.10+ and Chromium.

From the repo root in Windows PowerShell, install the tool dependencies:

```powershell
python -m venv .venv
.\.venv\Scripts\Activate.ps1
python -m pip install -r tools/live-audit/requirements.txt
python -m playwright install chromium
```

On Linux or WSL use `python3 -m venv .venv` and `source .venv/bin/activate`, then run the two Python installation commands. Start OpenCode from this activated terminal so its MCP subprocess uses the same Python. The checked-in project config targets OpenCode CLI 1.19.x. Use your configured model/provider.

```shell
opencode mcp list
opencode run --agent hospital-auditor "Audit Little Falls Hospital's live 2026 one-person 400% FPL row. Cite the original application and campus policy."
```

For a provider-independent live smoke test, run `python tools/live-audit/smoke.py`. Both entry points use the same MCP tools. Review the reported URLs, snapshot hashes, PDF page and DOCX table locator. Source files are stored under `.audit/live/snapshots/`; paths inside each assessment resolve relative to `.audit/live/`. If the documents or link labels change, inspect the live sources and the reported limitation. An ambiguous table or unverified campus produces an unclear finding. The reference for this single check is [the 2026 HHS contiguous-state poverty guideline](https://aspe.hhs.gov/poverty-guidelines), $15,960 annually for one person (400% = $63,840).
