/** Project WGS 84 positions into the atlas SVG, keeping the local aspect ratio. */
function projection([west, south, east, north], [x, y, width, height]) {
  const k = Math.cos(((north + south) * Math.PI) / 360);
  const scale = Math.min(width / ((east - west) * k), height / (north - south));
  const left = x + (width - (east - west) * k * scale) / 2;
  const top = y + (height - (north - south) * scale) / 2;
  return ([lon, lat]) => [left + (lon - west) * k * scale, top + (north - lat) * scale];
}

export const statewide = projection([-79.83, 40.46, -71.8, 45.05], [20, 12, 852, 523]);
export const metro = projection([-74.28, 40.47, -71.8, 41.18], [38, 415, 391, 111]);
export const metroFull = projection([-74.28, 40.47, -71.8, 41.18], [35, 65, 830, 420]);
export const metroCounties = new Set([
  "Bronx",
  "Kings",
  "New York",
  "Queens",
  "Richmond",
  "Nassau",
  "Suffolk",
]);

/** Convert polygon rings (including islands and holes) into a single SVG path. */
export function countyPath(geometry, project) {
  const polygons = geometry.type === "Polygon" ? [geometry.coordinates] : geometry.coordinates;
  return polygons
    .flatMap((polygon) =>
      polygon.map(
        (ring) =>
          ring
            .map((point, index) => {
              const [x, y] = project(point);
              return (index === 0 ? "M" : "L") + x.toFixed(2) + "," + y.toFixed(2);
            })
            .join("") + "Z",
      ),
    )
    .join("");
}
