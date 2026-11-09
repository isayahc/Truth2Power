import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { createReviewService } from "../review/service.js";

import { gradingRoute } from "../grading/routes.js";
import { reportingContext } from "../reporting/context.js";
import { changesRoute } from "../changes/routes.js";
import { overview } from "../overview/service.js";
import { hospitalPage } from "../hospital-page/service.js";

let reviewService;
async function reviewHandler(event) {
  reviewService ??= createReviewService(process.env.T2P_REVIEW_DIRECTORY || fileURLToPath(new URL("../../.audit/live/", import.meta.url)),
    JSON.parse(await readFile(new URL("../../data/maps/hospitals.geojson", import.meta.url), "utf8")).features);
  const method = event.requestContext?.http?.method;
  const match = /^\/api\/reviews\/([a-f0-9]{64})(?:\/(decisions|sources)(?:\/([a-f0-9]{64}))?)?$/.exec(event.rawPath);
  try {
    let result;
    if (event.rawPath === "/api/reviews" && method === "GET") result = reviewService.list(event.queryStringParameters);
    else if (match && !match[2] && method === "GET") result = reviewService.detail(match[1]);
    else if (match?.[2] === "sources" && match[3] && method === "GET") return { statusCode: 200, ...reviewService.source(match[1], match[3]) };
    else if (match?.[2] === "decisions" && !match[3] && method === "POST") {
      if (event.headers?.["x-review-request"] !== "1") return errorResponse(403, "Review request rejected.");
      if (typeof event.body !== "string" || Buffer.byteLength(event.body) > 8192) return errorResponse(400, "Invalid review decision.");
      let input;
      try { input = JSON.parse(event.body); } catch { return errorResponse(400, "Invalid review decision."); }
      result = reviewService.decide(match[1], input);
    } else return errorResponse(404, "Review endpoint not found.");
    return { statusCode: 200, headers: { "Content-Type": "application/json", "Cache-Control": "no-store" }, body: JSON.stringify(result) };
  } catch (error) {
    if (error.status) return errorResponse(error.status, error.message);
    console.error("review_request_failed", error.code ?? error.name);
    return errorResponse(500, "The review request could not be completed.");
  }
}

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
  if (event.rawPath === "/api/changes" || event.rawPath.startsWith("/api/changes/")) return changesRoute(event);
  if (event.rawPath === "/api/overview") {
    if (event.requestContext?.http?.method !== "GET") return errorResponse(405, "Use GET.");
    try {
      return { statusCode: 200, headers: { "Content-Type": "application/json", "Cache-Control": "no-store" }, body: JSON.stringify(overview()) };
    } catch (error) {
      console.error("overview_failed", error.name);
      return errorResponse(500, "Audit overview could not be loaded.");
    }
  }
  const page = /^\/api\/hospitals\/(\d{1,8}|t2p-\d+)\/page$/.exec(event.rawPath);
  if (page) {
    if (event.requestContext?.http?.method !== "GET") return errorResponse(405, "Use GET.");
    try {
      const data = hospitalPage(page[1]);
      const expected = event.queryStringParameters?.revision;
      if (expected && expected !== (data?.revision ?? "unassessed")) return errorResponse(409, "Assessment changed since the overview was loaded.");
      return data ? { statusCode: 200, headers: { "Content-Type": "application/json", "Cache-Control": "no-store" }, body: JSON.stringify(data) } : errorResponse(404, "Hospital page not yet assessed.");
    } catch (error) {
      console.error("hospital_page_failed", error.name);
      return errorResponse(500, "Hospital page could not be loaded.");
    }
  }
  const reporting = /^\/api\/hospitals\/(\d{1,8}|t2p-\d+)\/reporting-context$/.exec(event.rawPath);
  if (reporting) {
    const method = event.requestContext?.http?.method;
    if (!["GET", "HEAD"].includes(method)) return { ...errorResponse(405, "Use GET or HEAD."), headers: { "Content-Type": "application/json", Allow: "GET, HEAD" } };
    try {
      const context = reportingContext(reporting[1]);
      if (!context) return errorResponse(404, "Reporting context has not been assessed for this hospital.");
      return { statusCode: 200, headers: { "Content-Type": "application/json; charset=utf-8" }, body: method === "HEAD" ? "" : JSON.stringify(context) };
    } catch (error) {
      console.error("reporting_context_failed", error.name);
      return errorResponse(500, "Reporting context could not be loaded.");
    }
  }
  if (event.rawPath.startsWith("/api/grading/")) return gradingRoute(event);
  if (event.rawPath === "/api/reviews" || event.rawPath.startsWith("/api/reviews/")) return reviewHandler(event);
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
