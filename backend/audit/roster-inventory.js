import { existsSync, readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { isIP } from "node:net";
import { readArtifact, confirmedDocuments, fingerprint } from "../grading/data.js";
import { sourceUrl, languageTag } from "../review/identity.js";

export const roster = JSON.parse(readFileSync(new URL("../../data/maps/hospitals.geojson", import.meta.url))).features;

/** Only the repository's roster can supply a network starting point. */
export function facilityFor(key) {
  const feature = roster.find((h) => h.id === key);
  if (!feature || !/^(?:\d{1,8}|t2p-\d+)$/.test(key)) throw Error("Unknown hospital key");
  const { name, pfi, assistance_url } = feature.properties;
  const url = new URL(sourceUrl(assistance_url));
  if ((pfi ?? key) !== key || (!pfi && !key.startsWith("t2p-")) || !name ||
      url.protocol !== "https:" || url.port || isIP(url.hostname) || !/^[a-z0-9.-]+\.[a-z]+$/i.test(url.hostname) ||
      /\.(internal|local|localhost)$/.test(url.hostname) || url.hostname === "metadata.google.internal") throw Error("Invalid roster facility or assistance URL");
  return { hospital_key: key, pfi, name, landing_url: url.href };
}

export function savedCollection(root, key) {
  const dir = join(root, "collections", key);
  if (!existsSync(dir)) return null;
  return readdirSync(dir).sort().filter((f) => /^[a-f0-9]{32}\.json$/.test(f))
    .map((f) => JSON.parse(readArtifact(root, `collections/${key}/${f}`)))
    .filter((c) => c.hospital_key === key && c.landing_page)
    .sort((a, b) => Date.parse(b.attempted_at) - Date.parse(a.attempted_at))[0] ?? null;
}

/** Build grading candidates and a separately inspectable inventory from the same capture. */
export function sourceInventory(facility, collection, seeds = []) {
  const { hospital_key, landing_url } = facility;
  const expectedHost = new URL(landing_url).hostname.replace(/^www\./, "");
  const trusted = (url) => {
    const u = new URL(sourceUrl(url));
    return u.protocol === "https:" && !u.port && u.hostname.replace(/^www\./, "") === expectedHost;
  };
  const rows = new Map(), gaps = new Set();
  const put = (source_id, values) => rows.set(source_id, { source_id, role: "unclassified", language: "und",
    campus_applicability: "unknown", provenance: "roster", digest: null, retrieved_at: null, capture_status: "not_captured", ...values });
  put(landing_url, { role: "landing_page" });
  for (const s of seeds) put(s.source_id, { ...s, role: s.digest ? s.role : "unclassified", provenance: "curated_inventory",
    campus_applicability: s.digest && s.role !== "landing_page" ? "applicable" : "unknown" });
  if (!collection) {
    if (!seeds.length) gaps.add("No saved collection for the roster landing page.");
  } else {
    if (collection.hospital_key !== hospital_key || sourceUrl(collection.landing_url) !== landing_url ||
        !collection.landing_page || sourceUrl(collection.landing_page.source_url || collection.landing_url) !== landing_url)
      throw Error("Collection does not match roster landing page");
    // Never carry a historical classification across a changed or missing capture.
    for (const id of rows.keys()) put(id, { role: id === landing_url ? "landing_page" : "unclassified", provenance: "not_captured" });
    for (const limit of collection.limitations || []) gaps.add(limit);
    const resources = [{ ...collection.landing_page, source_url: landing_url, status: "saved" }, ...(collection.pages || []), ...collection.documents];
    for (const s of resources) {
      const id = s.source_url || s.url;
      if (s.discovery_gap) gaps.add(`${id}: ${s.discovery_gap}`);
      if (s.status !== "saved") {
        gaps.add(`${id}: ${s.reason || s.http_status || s.error_type || "resource unavailable"}`);
        // Out-of-bound anchors stay in the raw manifest and gaps, never the grader's source registry.
        let attempted;
        try { if (trusted(id)) attempted = sourceUrl(id); } catch { /* malformed anchor */ }
        if (attempted && !rows.get(attempted)?.digest) put(attempted, { capture_status: "failed", provenance: "collection" });
        continue;
      }
      const final = s.final_url || s.url || id;
      if (!trusted(id) || !trusted(final) || (s.redirects || []).some((r) => !trusted(r.source_url) || !trusted(r.final_url)))
        throw Error("Untrusted saved collection URL");
      if (!/^[a-f0-9]{64}$/.test(s.sha256) || !["html", "pdf", "docx"].some((ext) =>
        s.artifact_path === `snapshots/${s.sha256}.${ext}`) || !Number.isFinite(Date.parse(s.retrieved_at))) throw Error("Invalid saved resource");
      const known = confirmedDocuments.find((d) => d.hospital_key === hospital_key && d.sha256 === s.sha256);
      const page = s.artifact_path.endsWith(".html");
      const other = !known && (s.classification === "other_campus_requires_review" || confirmedDocuments.some((d) => d.sha256 === s.sha256));
      put(sourceUrl(id), { role: known?.role ?? (page && id === landing_url ? "landing_page" : "unclassified"),
        language: known ? languageTag(known.language) : "und", digest: s.sha256, retrieved_at: s.retrieved_at,
        artifact_path: s.artifact_path, final_url: final, provenance: known ? "pinned_campus_inventory" : "collection",
        capture_status: "saved", campus_applicability: known ? "applicable" : other ? "other_campus_requires_review" : "unknown" });
    }
  }
  return { schema_version: "hospital-source-inventory-v1", ...facility, collection_sha256: collection ? fingerprint(collection) : null,
    sources: [...rows.values()], gaps: [...gaps] };
}
