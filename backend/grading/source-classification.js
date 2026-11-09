import { readArtifact, requireValue } from "./data.js";
import { languageTag, sha256, sourceUrl } from "../review/identity.js";

const roles = ["application", "policy_summary", "policy_statement", "supplement"];
const cited = (c) => typeof c?.locator === "string" && c.locator.trim() && typeof c.quote === "string" && c.quote.trim();

/** Operator testimony about document identity only. Never an observation-review decision. */
export function classificationFile(raw, hospital) {
  const file = JSON.parse(raw);
  requireValue(file.schema_version === "hospital-classifications-v1" && file.hospital_key === hospital &&
    typeof file.reviewer_role === "string" && file.reviewer_role.trim() && typeof file.reviewed_at === "string" &&
    /T.*(?:Z|[+-]\d\d:\d\d)$/.test(file.reviewed_at) && Number.isFinite(Date.parse(file.reviewed_at)) &&
    Array.isArray(file.documents) && file.documents.length > 0 && file.documents.length <= 100, "Invalid classification record");
  const urls = new Set();
  for (const d of file.documents) {
    requireValue(sourceUrl(d.source_id) === d.source_id && !urls.has(d.source_id) && /^[a-f0-9]{64}$/.test(d.sha256) &&
      roles.includes(d.role) && d.language !== "und" && languageTag(d.language) === d.language &&
      cited(d) && cited(d.applicability), "Invalid or ambiguous source classification");
    urls.add(d.source_id);
  }
  return file.documents.map((d) => ({ ...d, hospital_key: hospital }));
}

export function readClassifications(root, hash, hospital) {
  if (!hash) return [];
  requireValue(/^[a-f0-9]{64}$/.test(hash), "Invalid classification hash");
  const raw = readArtifact(root, `source-classifications/${hash}.json`);
  requireValue(sha256(raw) === hash, "Classification identity changed");
  return classificationFile(raw, hospital);
}
