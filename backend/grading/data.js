import { readFileSync, realpathSync, statSync } from "node:fs";
import { resolve, sep, isAbsolute } from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { sha256 } from "../review/identity.js";

const here = (path) => fileURLToPath(new URL(path, import.meta.url));
export const rubric = JSON.parse(readFileSync(here("../../rubrics/css-17-v1.json")));
export const hhs = JSON.parse(readFileSync(here("../../references/hhs-poverty-contiguous-v1.json")));
export const referenceHash = sha256(readFileSync(here("../../references/hhs-poverty-contiguous-v1.json")));
const inventoryBytes = readFileSync(here("../../docs/audit-format/wave-one-document-inventory.json"));
export const postingReference = "wave-one-document-inventory-sha256:" + sha256(inventoryBytes);
const { hospitals: waveOne } = JSON.parse(inventoryBytes);
const roster = JSON.parse(readFileSync(here("../../data/maps/hospitals.geojson")));
export const assistancePages = new Map(roster.features.map((f) => [String(f.id), f.properties.assistance_url]));
export const confirmedDocuments = waveOne.flatMap((h) => h.documents.filter((d) => d.status === "content_confirmed")
  .map((d) => ({ hospital_key: h.hospital_key, role: d.type, sha256: d.sha256, quote: d.quote, locator: d.locator, language: d.language_label })));
export const byId = new Map(rubric.measures.map((m) => [m.measure_id, m]));
export const contextKeys = ["hospital_key", "assessment_id", "scope_id", "rubric_version", "reference_version", "guideline_year", "review_date"];
export const contextOf = (input) => Object.fromEntries(contextKeys.map((key) => [key, input[key]]));
export const expectedFor = (measure, year) => measure.evaluator === "fpl"
  ? { ...measure.expected, guideline_year: year } : measure.expected;

export function requireValue(condition, message) { if (!condition) throw Error(message); }

export function validateSchema(input, name = "grading-assessment-v1.schema.json") {
  const cmd = spawnSync(process.env.T2P_PYTHON || "python", [here("validate.py"), name],
    { input: JSON.stringify(input), encoding: "utf8", timeout: 30000, maxBuffer: 1024 * 1024 });
  if (cmd.error) throw cmd.error;
  requireValue(cmd.status === 0, "Schema validation failed: " + (cmd.stderr.trim().slice(-500) || "validator unavailable"));
}

/** Restrict all user-supplied artifact paths, including symlink targets, to the evidence root. */
export function readArtifact(root, relative) {
  requireValue(typeof relative === "string" && !isAbsolute(relative) && !relative.split(/[\\/]/).includes(".."), "Invalid artifact path");
  const parent = realpathSync(root);
  const full = realpathSync(resolve(parent, relative));
  requireValue(full.startsWith(parent + sep) && statSync(full).isFile() && statSync(full).size <= 20 * 1024 * 1024, "Invalid artifact path or size");
  return readFileSync(full);
}

export function canonical(value) {
  if (Array.isArray(value)) return value.map(canonical);
  if (value !== null && typeof value === "object") return Object.fromEntries(Object.keys(value).sort().map((k) => [k, canonical(value[k])]));
  return value;
}
export const fingerprint = (value) => sha256(JSON.stringify(canonical(value)));
