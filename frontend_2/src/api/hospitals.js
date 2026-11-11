// Atlas read API — thin wrappers with the same fetch paths the old app used.
// hospitalFeatures / countyFeatures validate the GeoJSON exactly like the
// old App.jsx getFeatures: a FeatureCollection with a non-empty features
// array, or the same "Dataset request failed." / "Empty or invalid map data."
// errors. hospitalPage / reportingContext return the raw Response instead of
// parsed JSON, because their callers distinguish 409 (changed) and 404
// (unavailable) statuses before reading the body — getJson throws on any
// non-OK status and cannot preserve that distinction.
import { getJson } from "./client.js";

async function getFeatures(path, signal) {
  let data;
  try {
    data = await getJson(path, signal);
  } catch {
    throw new Error("Dataset request failed.");
  }
  if (data.type !== "FeatureCollection" || !Array.isArray(data.features) || !data.features.length) {
    throw new Error("Empty or invalid map data.");
  }
  return data.features;
}

export function hospitalFeatures(signal) {
  return getFeatures("/api/hospitals", signal);
}

export function countyFeatures(signal) {
  return getFeatures("/api/counties", signal);
}

export function hospitalPage(hospitalKey, revision, signal) {
  const query = revision ? "?revision=" + encodeURIComponent(revision) : "";
  return fetch(`/api/hospitals/${encodeURIComponent(hospitalKey)}/page${query}`, { signal });
}

export function reportingContext(hospitalKey, signal) {
  return fetch(`/api/hospitals/${encodeURIComponent(hospitalKey)}/reporting-context`, { signal });
}
