import { readdirSync, readFileSync, realpathSync, statSync } from "node:fs";
import { join, resolve, sep } from "node:path";
import { sha256, reviewIdentity } from "../review/identity.js";

export const validDate = (value) => typeof value === "string" && Number.isFinite(Date.parse(value));
export const safeUrl = (value) => {
  try { const u = new URL(value); return u.protocol === "https:" && !u.username && !u.password ? u.href : null; } catch { return null; }
};
function files(path) {
  try { return readdirSync(path, { withFileTypes: true }); } catch (e) { if (e.code === "ENOENT") return []; throw e; }
}
export function readBounded(root, path) {
  const actual = realpathSync(resolve(root, path));
  if (!actual.startsWith(realpathSync(root) + sep) || statSync(actual).size > 20 * 1024 * 1024) throw Error("Invalid artifact path");
  return readFileSync(actual);
}

/** Preserve producer findings, never promote these display records to grading inputs. */
export function projectRecord(raw, path, kind) {
  const a = JSON.parse(raw), hash = sha256(raw);
  if (a.synthetic || a.rubric_version === "demo-v1") return null;
  const at = a.attempt?.attempted_at ?? a.checked_at;
  const completed = a.assessment?.completed_at ?? a.checked_at;
  if (!/^(\d{1,8}|t2p-\d+)$/.test(a.hospital_key) || !validDate(at)) throw Error("Invalid assessment identity");
  const findings = a.assessment?.findings ?? a.findings ?? [];
  let scope = kind, label = { posting: "Posted document links", summaries: "English and Spanish summaries", "full-reviews": "Full posted-material review", "cross-document-reviews": "Cross-document review (excerpt coverage)" }[kind];
  if (kind === "application-reviews") {
    const identity = reviewIdentity(a, kind, hash);
    scope = identity.group;
    label = `${a.scope_label || "Selected application"} · ${identity.documents.map((d) => d.language_label).join(", ") || "language unknown"}`;
  }
  const failed = a.attempt?.status === "failed";
  if (!failed && (!validDate(completed) || !Array.isArray(findings) || !Array.isArray(a.snapshots))) throw Error("Incomplete assessment");
  const projected = findings.map((f) => ({ measure_id: f.measure_id, result: f.result,
    explanation: f.explanation || f.reason || "The source review did not supply an explanation.",
    evidence: (f.evidence ?? []).map((e) => {
      const s = a.snapshots.find((s) => s.snapshot_id === e.snapshot_id);
      if (!s || !safeUrl(s.url) || !/^[a-f0-9]{64}$/.test(s.sha256) || !validDate(s.retrieved_at) || typeof e.quote !== "string" || typeof e.locator !== "string") throw Error("Invalid citation");
      return { snapshot_id: s.snapshot_id, sha256: s.sha256, url: safeUrl(s.url), retrieved_at: s.retrieved_at,
        publisher_updated_at: validDate(s.publisher_updated_at) ? s.publisher_updated_at : null,
        locator: e.locator, quote: e.quote };
    }) }));
  if (new Set(projected.map((f) => f.measure_id)).size !== projected.length || projected.some((f) =>
    typeof f.measure_id !== "string" || !["yes", "no", "unclear", "n_a"].includes(f.result) ||
    (["yes", "no"].includes(f.result) && !f.evidence.length))) throw Error("Invalid finding");
  if (a.psa?.result === "unclear" && !projected.some((f) => f.measure_id === "posted_materials.primary_service_area_boundaries_compliant")) projected.push({
    measure_id: "posted_materials.primary_service_area_boundaries_compliant", result: "unclear", explanation: a.psa.note || a.psa.unresolved_question, evidence: [] });
  return { hospital_key: a.hospital_key, record_id: hash, artifact_path: path.replaceAll("\\", "/"), kind, scope, scope_label: label || kind,
    guideline_year: a.guideline_year ?? Number((a.review_date || at).slice(0, 4)),
    checked_at: failed ? at : completed, review_date: a.review_date ?? null,
    status: failed ? "failed" : "completed", error: failed ? "The recheck failed. The prior successful finding is retained." : null,
    findings: projected, affected_measures: a.affected_measures ?? projected.map((f) => f.measure_id),
    landing_page: (a.snapshots ?? []).filter((s) => s.document_type === "landing_page").map((s) => ({
      url: safeUrl(s.url), retrieved_at: s.retrieved_at, publisher_updated_at: validDate(s.publisher_updated_at) ? s.publisher_updated_at : null })) };
}

export function localRecords(root) {
  const records = [], unavailable = [];
  const add = (path, kind) => {
    try { const record = projectRecord(readBounded(root, path), path, kind); if (record) records.push(record); }
    catch { unavailable.push(path.replaceAll("\\", "/")); }
  };
  for (const kind of ["application-reviews", "full-reviews"]) for (const dir of files(join(root, kind))) {
    if (!dir.isDirectory() || !/^[a-f0-9]{32}$/.test(dir.name)) continue;
    for (const f of files(join(root, kind, dir.name, "results"))) if (/^[a-f0-9]{32}\.json$/.test(f.name)) add(join(kind, dir.name, "results", f.name), kind);
  }
  for (const dir of files(join(root, "cross-document-reviews"))) {
    if (!dir.isDirectory() || !/^\d{1,8}$/.test(dir.name)) continue;
    for (const f of files(join(root, "cross-document-reviews", dir.name))) if (/^[a-f0-9]{32}\.json$/.test(f.name)) add(join("cross-document-reviews", dir.name, f.name), "cross-document-reviews");
  }
  // Failed rechecks use the same producer envelope and scope as their successful predecessor.
  for (const f of files(join(root, "page-rechecks"))) if (/^[a-zA-Z0-9-]+\.json$/.test(f.name)) {
    try {
      const a = JSON.parse(readBounded(root, join("page-rechecks", f.name)));
      if (!a.synthetic && a.status === "failed" && /^(\d{1,8}|t2p-\d+)$/.test(a.hospital_key) && validDate(a.checked_at) &&
        typeof a.scope === "string" && Number.isInteger(a.guideline_year) && Array.isArray(a.affected_measures) && a.affected_measures.every((m) => typeof m === "string")) {
        records.push({ ...a, findings: [], record_id: sha256(JSON.stringify(a)), error: "The recheck failed. The prior successful finding is retained." });
      } else throw Error("Invalid recheck");
    } catch { unavailable.push(`page-rechecks/${f.name}`); }
  }
  return { records, unavailable };
}

export function latestByScope(records) {
  const groups = new Map();
  for (const r of records) for (const id of r.status === "failed" ? r.affected_measures : r.findings.map((f) => f.measure_id)) {
    // Full review supersedes earlier excerpt review for the same posted-material measure.
    const scope = ["full-reviews", "cross-document-reviews"].includes(r.kind) ? "posted-materials" : r.scope;
    const key = JSON.stringify([r.hospital_key, r.guideline_year, scope, id]);
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key).push({ ...r, scope, finding: r.findings.find((f) => f.measure_id === id), measure_id: id });
  }
  return [...groups.values()].map((versions) => {
    versions.sort((a, b) => Date.parse(b.checked_at) - Date.parse(a.checked_at) || b.record_id.localeCompare(a.record_id));
    const success = versions.find((v) => v.status === "completed");
    return { latest: versions[0], success, failures: versions.filter((v) => v.status === "failed" && (!success || Date.parse(v.checked_at) >= Date.parse(success.checked_at))) };
  });
}
