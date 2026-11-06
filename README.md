# Truth2Power

Truth2Power maps how 212 New York hospitals scored in the Community Service Society of New York’s September 2025 financial assistance review. Select a hospital to see its rating, latitude and longitude, financial assistance page, and source audit row.

## Run the React app

Install Git and Node.js 22.12 or newer with npm. Run these commands in a terminal (including WSL2 on Windows).

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
