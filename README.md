# Truth2Power

Truth2Power maps how 212 New York hospitals scored in the Community Service Society of New York’s September 2025 financial assistance review. Select a hospital to see its rating, latitude and longitude, financial assistance page, and source audit row.

## Open the map directly

Open [maps/index.html](maps/index.html) on GitHub, click **Download raw file**, then open the downloaded HTML in a web browser. The map, search, and rating filters work offline. Following a hospital or audit link requires an internet connection.

## Run locally from a clone

With Git and Python 3 installed, run these commands in a terminal. On Windows, you can run the same commands in WSL2.

```bash
git clone https://github.com/isayahc/Truth2Power.git
cd Truth2Power
python3 -m http.server 8000 --bind 127.0.0.1
```

Leave the terminal running and open [http://localhost:8000/maps/](http://localhost:8000/maps/) in your browser. If you already cloned the repo, start the server from the `Truth2Power` directory. Press **Ctrl+C** in that terminal to stop it.

## Check that it’s working

The statewide map should show **212 hospital locations**. Select **0 ★** in the rating legend to show the four hospitals that had no application posted. Choose **Show all**, then select any hospital to see its latitude and longitude.

## Data and rating definitions

- [Map guide](maps/README.md) explains the star ratings and how the coordinates were matched.
- Browse the [hospital audit records](data/) for one JSON file per hospital.
- [CSV coordinates](data/maps/hospital-coordinates.csv) and [GeoJSON points](data/maps/hospitals.geojson) are available for use in other mapping tools.
