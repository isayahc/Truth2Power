import { readFile } from "node:fs/promises";

/** Read only the public atlas datasets exposed by the local HTTP API. */
const datasets = new Map([
  ["/api/hospitals", ["hospitals.geojson", "application/geo+json"]],
  ["/api/counties", ["counties.geojson", "application/geo+json"]],
  ["/api/coordinates.csv", ["hospital-coordinates.csv", "text/csv"]],
]);
const dataDirectory = new URL("../../data/maps/", import.meta.url);

function errorResponse(statusCode, message) {
  return {
    statusCode,
    headers: { "Content-Type": "application/json; charset=utf-8" },
    body: JSON.stringify({ error: message }),
  };
}

/** Serve an API Gateway HTTP API v2 event with a response usable by Node or Lambda. */
export async function handler(event) {
  const dataset = datasets.get(event.rawPath);
  if (!dataset) return errorResponse(404, "Dataset not found.");
  const method = event.requestContext?.http?.method;
  if (method !== "GET" && method !== "HEAD") {
    const response = errorResponse(405, "Use GET or HEAD.");
    response.headers.Allow = "GET, HEAD";
    return response;
  }

  const [filename, type] = dataset;
  try {
    const body = await readFile(new URL(filename, dataDirectory), "utf8");
    return {
      statusCode: 200,
      headers: { "Content-Type": type + "; charset=utf-8" },
      body: method === "HEAD" ? "" : body,
    };
  } catch (error) {
    console.error("dataset_read_failed", filename, error.code);
    return errorResponse(500, "The dataset could not be loaded.");
  }
}
