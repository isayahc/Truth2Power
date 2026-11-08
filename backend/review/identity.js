import { createHash } from "node:crypto";

export const sha256 = (bytes) => createHash("sha256").update(bytes).digest("hex");
const hashPattern = /^[0-9a-f]{64}$/;
const roles = new Set(["application", "landing_page", "policy_summary", "policy_statement", "supplement", "online_application"]);
const languages = new Map(Object.entries({ english: "en", spanish: "es", polish: "pl", ukrainian: "uk", russian: "ru",
  unknown: "und", unverified: "und", undetermined: "und" }));

/** Preserve path and query identity, normalizing only HTTP URL syntax and fragment. */
export function sourceUrl(value) {
  if (typeof value !== "string" || value.length > 4096 || /[\s\\\x00-\x1f]/u.test(value)) throw Error("Invalid source URL");
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
    const coverage = namespace === "application-reviews"
      ? result.coverage.filter((c) => c.source_id === "application" ||
          (!result.coverage.some((c) => c.source_id === "application") && result.coverage.length === 1))
      : result.coverage;
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
        const d = declared.documents[index];
        if (!d || Object.keys(d).sort().join(",") !== "language,role,snapshot_sha256,url" || d.url !== entry.url ||
            d.role !== source.document_type || d.snapshot_sha256 !== source.sha256 || !d.language || d.language !== entry.language)
          throw Error("Identity differs from saved coverage");
      }
      docs.push({ source_id: url, snapshot_sha256: source.sha256, role: source.document_type, language,
        name: source.display_name || new URL(url).pathname.split("/").pop() || url });
    }
    if (!result.rubric_version || typeof result.rubric_version !== "string") throw Error("Missing rubric version");
    const unique = new Map();
    for (const doc of docs) {
      const key = JSON.stringify([doc.source_id, doc.role, doc.language]);
      if (unique.has(key) && unique.get(key).snapshot_sha256 !== doc.snapshot_sha256) throw Error("Conflicting source versions");
      unique.set(key, doc);
    }
    const keys = [...unique.keys()].sort();
    const group = sha256(JSON.stringify([result.hospital_key, namespace, scope, result.rubric_version,
      result.guideline_year ?? null, result.reference_version ?? null, keys]));
    return { group, scope, identity_status: declared ? "declared" : "derived_legacy", documents: keys.map((key) => unique.get(key)) };
  } catch (error) {
    if (declared !== undefined) throw error;
    return { group: resultHash, scope, identity_status: "ambiguous_legacy", documents: [], identity_warning: error.message };
  }
}
