import { createHash } from "node:crypto";

export const sha256 = (bytes) => createHash("sha256").update(bytes).digest("hex");
const hashPattern = /^[0-9a-f]{64}$/;
const roles = new Set(["application", "landing_page", "policy_summary", "policy_statement", "supplement", "online_application"]);
const languages = new Map(Object.entries({ english: "en", spanish: "es", polish: "pl", ukrainian: "uk", russian: "ru",
  unknown: "und", unverified: "und", undetermined: "und" }));

/** Preserve path and query identity, normalizing only HTTP URL syntax and fragment. */
export function sourceUrl(value) {
  if (typeof value !== "string" || !/^https?:\/\//i.test(value) || value.length > 4096 || /[\s\\\x00-\x1f]/u.test(value)) throw Error("Invalid source URL");
  const url = new URL(value);
  if (!["https:", "http:"].includes(url.protocol) || url.username || url.password) throw Error("Invalid source URL");
  url.hash = "";
  return url.href;
}

export function languageTag(value) {
  if (typeof value !== "string" || !value.trim()) return "und";
  const label = value.toLowerCase().trim();
  if (languages.has(label)) return languages.get(label);
  if (!/^[a-z]{2,3}(-[a-z0-9]{2,8})*$/.test(label)) return "und";
  try { return Intl.getCanonicalLocales(label)[0]; } catch { return "und"; }
}

const scopes = { "application-reviews": "selected_application", "full-reviews": "posted_materials" };

/** Resolve hospital documents from collection metadata, excluding reference forms and derived renders. */
export function reviewIdentity(result, namespace, resultHash) {
  const declared = result.review_identity;
  const scope = scopes[namespace];
  const docs = [];
  try {
    let coverage = result.coverage;
    if (namespace === "application-reviews" && coverage.length !== 1) {
      const selected = coverage.filter((c) => c.source_id === "application");
      coverage = selected.length || declared !== undefined ? selected : coverage.filter((c) =>
        !["official_reference", "reference_visual_review", "application_visual_review"].includes(c.source_id) &&
        result.snapshots.some((s) => s.document_type === "application" && sourceUrl(s.url) === sourceUrl(c.url)));
    }
    if (!scope || !coverage.length || (namespace === "application-reviews" && coverage.length !== 1)) throw Error("Ambiguous source coverage");
    if (declared !== undefined && (declared?.version !== 1 || declared.scope !== scope || !Array.isArray(declared.documents) ||
        Object.keys(declared).sort().join(",") !== "documents,scope,version" || declared.documents.length !== coverage.length)) throw Error("Invalid review identity");
    for (const [index, entry] of coverage.entries()) {
      const url = sourceUrl(entry.url);
      const candidates = result.snapshots.filter((s) => sourceUrl(s.url) === url && !s.derived_from_snapshot_id &&
        (!entry.snapshot_sha256 || s.sha256 === entry.snapshot_sha256) && (!entry.snapshot_id || s.snapshot_id === entry.snapshot_id) &&
        (scope !== "selected_application" || s.document_type === "application"));
      const source = candidates[0];
      if (!source || !hashPattern.test(source.sha256) || !roles.has(source.document_type) ||
          candidates.some((s) => s.sha256 !== source.sha256 || s.document_type !== source.document_type)) throw Error("Ambiguous snapshot");
      const language = languageTag(entry.language);
      if (declared !== undefined) {
        if (source.snapshot_id !== source.sha256 || !["pdf", "html", "docx"].some((ext) =>
          source.artifact_path === `snapshots/${source.sha256}.${ext}`)) throw Error("Invalid declared snapshot reference");
        const d = declared.documents[index];
        if (!d || Object.keys(d).sort().join(",") !== "language,role,snapshot_sha256,url" || d.url !== entry.url ||
            d.role !== source.document_type || d.snapshot_sha256 !== source.sha256 || typeof d.language !== "string" || !d.language.trim() || d.language.length > 100 || d.language !== entry.language)
          throw Error("Identity differs from saved coverage");
      }
      docs.push({ source_id: url, snapshot_sha256: source.sha256, role: source.document_type, language,
        language_label: entry.language || "unknown", name: source.display_name || new URL(url).pathname.split("/").pop() || url });
    }
    if (scope === "posted_materials" && result.snapshots.some((s) => !docs.some((d) =>
      d.source_id === sourceUrl(s.url) && d.role === s.document_type && d.snapshot_sha256 === s.sha256))) throw Error("Uncovered snapshot in source identity");
    const unversionedRun = declared === undefined && result.rubric_version == null;
    if (!unversionedRun && (typeof result.rubric_version !== "string" || !result.rubric_version.trim())) throw Error("Missing rubric version");
    if (result.guideline_year != null && (!Number.isInteger(result.guideline_year) || result.guideline_year < 2000)) throw Error("Invalid guideline year");
    if (result.reference_version != null && (typeof result.reference_version !== "string" || !result.reference_version.trim())) throw Error("Invalid reference version");
    const unique = new Map();
    for (const doc of docs) {
      const parts = [doc.source_id, doc.role, doc.language];
      // Preserve unrecognized language descriptions without asserting that two descriptions name the same language.
      if (doc.language === "und" && !["und", "unknown", "unverified", "undetermined"].includes(doc.language_label.trim().toLowerCase()))
        parts.push(doc.language_label.trim());
      const key = JSON.stringify(parts);
      if (unique.has(key) && unique.get(key).snapshot_sha256 !== doc.snapshot_sha256) throw Error("Conflicting source versions");
      unique.set(key, doc);
    }
    const keys = [...unique.keys()].sort();
    const group = sha256(JSON.stringify([result.hospital_key, namespace, scope, unversionedRun ? ["legacy_run", result.review_id] : result.rubric_version,
      result.guideline_year ?? null, result.reference_version ?? null, keys]));
    return { group, scope, identity_status: unversionedRun ? "legacy_unversioned_run" : declared ? "declared" : "derived_legacy",
      ...(unversionedRun ? { identity_warning: "Rubric unknown. Revisions are grouped only within the original review run." } : {}),
      documents: keys.map((key) => unique.get(key)) };
  } catch (error) {
    if (declared !== undefined) throw error;
    return { group: resultHash, scope, identity_status: "ambiguous_legacy", documents: [], identity_warning: error.message };
  }
}
