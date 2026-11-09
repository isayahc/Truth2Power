import { existsSync, readdirSync } from "node:fs";
import { join, extname } from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { isDeepStrictEqual } from "node:util";
import { sourceUrl, sha256, languageTag } from "../review/identity.js";
import { readArtifact, requireValue, fingerprint, confirmedDocuments, assistancePages } from "./data.js";
import { parseProfile } from "./profiles.js";
import { postingPaths } from "./posting-paths.js";

/** Bind testimony to the exact observations, citations, inventory and completed assessment. */
export function reviewSubject(input, finding) {
  const { human_review, ...subject } = finding;
  return fingerprint({ subject, sources: input.sources, scope: input.scope, synthetic: input.synthetic,
    completed_at: input.last_successful_assessment_at });
}

function reviewState(input, finding, directory) {
  const hash = reviewSubject(input, finding);
  const folder = directory && join(directory, hash);
  if (!folder || !existsSync(folder)) return "pending";
  const decisions = readdirSync(folder).filter((f) => /^[a-zA-Z0-9-]+\.json$/.test(f)).map((file) => {
    const d = JSON.parse(readArtifact(directory, join(hash, file)));
    requireValue(d.subject_sha256 === hash && ["approved", "rejected", "needs_changes"].includes(d.decision) &&
      typeof d.reviewer_role === "string" && d.reviewer_role.trim() && typeof d.reason === "string" && d.reason.trim() &&
      Number.isFinite(Date.parse(d.recorded_at)), "Malformed observation-review record");
    return d.decision;
  });
  return new Set(decisions).size > 1 ? "conflict" : decisions[0] ?? "pending";
}

export function evidenceStore(input, root, decisionDirectory) {
  const registry = new Map();
  const byteCache = new Map();
  const textCache = new Map();
  const publishedFields = new Map();
  for (const doc of input.sources) {
    const url = sourceUrl(doc.source_id);
    requireValue(doc.hospital_key === input.hospital_key && url === doc.source_id && !registry.has(url), "Cross-hospital, duplicate or noncanonical source identity");
    requireValue(languageTag(doc.language) === doc.language, "Use a canonical language tag or und");
    if (doc.snapshot) {
      const s = doc.snapshot;
      requireValue(sourceUrl(s.url) === url, "Snapshot URL does not match logical source");
      if (s.final_url) {
        const final = new URL(s.final_url), original = new URL(url);
        requireValue(final.protocol === "https:" && !final.username && !final.password && (!final.port || final.port === "443") &&
          final.hostname.replace(/^www\./, "") === original.hostname.replace(/^www\./, ""), "Untrusted snapshot redirect destination");
      }
      const raw = readArtifact(root, s.artifact_path);
      requireValue(sha256(raw) === s.sha256, "Snapshot failed SHA-256 verification");
      byteCache.set(url, raw);
      if (extname(s.artifact_path) === ".json") {
        const source = JSON.parse(raw);
        requireValue(source.format === "published-fields-v1" && source.hospital_key === doc.hospital_key &&
          source.url === url && source.role === doc.role && source.language === doc.language &&
          source.fields && typeof source.fields === "object" && !Array.isArray(source.fields), "Published source identity mismatch");
        requireValue(input.synthetic || source.synthetic !== true, "Synthetic source cannot be relabeled as a live assessment");
        publishedFields.set(url, source.fields);
      }
    } else requireValue(!["available", "reviewed"].includes(doc.status), "Reviewed source lacks snapshot bytes");
    registry.set(url, doc);
  }
  requireValue(input.scope.required_sources.length === registry.size &&
    input.scope.required_sources.every((id) => registry.has(id)), "Required inventory and sources differ");
  requireValue(input.scope.inventory_status !== "partial" || input.scope.gaps.length, "Describe the incomplete inventory");
  const online = input.sources.filter((s) => s.role === "online_application");
  requireValue(input.scope.online_application !== "absent_after_search" || !online.length, "Online application present in purportedly absent inventory");
  requireValue(input.scope.online_application !== "present" || online.length, "Posted online application missing from inventory");

  function segment(doc, locator) {
    const measureLinks = locator.startsWith("link ");
    const cacheKey = measureLinks ? "links:" + doc.source_id : doc.source_id;
    if (!textCache.has(cacheKey)) {
      const raw = byteCache.get(doc.source_id), suffix = extname(doc.snapshot.artifact_path).toLowerCase();
      let segments;
      if (suffix === ".txt") segments = Object.fromEntries(raw.toString("utf8").split(/\r?\n/).map((s, i) => ["line " + (i + 1), s]));
      else if ([".html", ".pdf", ".docx"].includes(suffix)) {
        const proc = spawnSync(process.env.T2P_PYTHON || "python", [fileURLToPath(new URL("extract.py", import.meta.url)), suffix, ...(doc.role === "landing_page" && measureLinks ? [doc.snapshot.final_url || doc.source_id] : [])],
          { input: raw, encoding: "utf8", timeout: 30000, maxBuffer: 16 * 1024 * 1024 });
        requireValue(proc.status === 0, "Offline source extraction unavailable");
        segments = JSON.parse(proc.stdout);
      } else throw Error("Unsupported text evidence format");
      textCache.set(cacheKey, segments);
    }
    return textCache.get(cacheKey)[locator];
  }

  function evidence(measure, finding) {
    const review = reviewState(input, finding, decisionDirectory);
    const gaps = [...finding.unresolved_evidence];
    if (finding.human_review !== "pending" && finding.human_review !== review) gaps.push("Claimed human review does not match independent decisions for these exact observations.");
    if (["rejected", "needs_changes", "conflict"].includes(review)) gaps.push("Human review: " + review);
    const cited = finding.evidence.map((e) => {
      const doc = registry.get(e.source_id);
      requireValue(doc?.snapshot && doc.snapshot.sha256 === e.sha256 && doc.snapshot.snapshot_id === e.snapshot_id, "Unbound evidence snapshot");
      requireValue(measure.roles.includes(doc.role), "Wrong-document evidence for " + measure.measure_id);
      if (publishedFields.has(doc.source_id)) {
        const fields = publishedFields.get(doc.source_id);
        // The field name is fixed by the rubric, never chosen to fit an answer.
        requireValue(e.locator === "/fields/" + measure.evaluator && Object.hasOwn(fields, measure.evaluator), "Wrong source field locator");
        const value = fields[measure.evaluator];
        requireValue(e.quote === JSON.stringify(value), "Source field excerpt mismatch");
        return { doc, value };
      }
      const content = segment(doc, e.locator);
      requireValue(typeof content === "string" && content.includes(e.quote), "Evidence excerpt not found at saved locator");
      return { doc, content };
    });
    const facts = new Map();
    for (const o of finding.observed) {
      const c = cited[o.evidence_index];
      requireValue(c, "Observation lacks a verified citation");
      let value;
      if (o.method === "source_field") {
        requireValue(Object.hasOwn(c, "value"), "Observation must come from a published structured field");
        value = c.value;
      } else if (o.method === "posted_link") {
        requireValue(measure.evaluator === "posting" && c.doc.role === "landing_page" &&
          c.doc.source_id === assistancePages.get(input.hospital_key), "Expected the hospital roster landing page");
        const extracted = {};
        for (const [index, e] of finding.evidence.entries()) {
          if (e.locator.startsWith("link ")) requireValue(e.quote === cited[index].content, "Expected the exact saved anchor label");
          (extracted[e.source_id] ??= []).push({ locator: e.locator, text: e.quote, status: "extracted" });
        }
        const paths = postingPaths(input.sources, extracted, c.doc.source_id, measure.expected.any_accessible_role, confirmedDocuments, input.hospital_key);
        const links = [...new Set(paths.map((p) => p.target))];
        requireValue(links.length > 0, "Missing posting links");
        value = { links, search_complete: false };
      } else if (o.method === "text_profile") {
        requireValue(typeof c.content === "string", "Text profile needs located text");
        const confirmed = confirmedDocuments.some((d) => d.hospital_key === c.doc.hospital_key && d.role === c.doc.role && d.sha256 === c.doc.snapshot.sha256 && languageTag(d.language) === c.doc.language);
        if (!input.synthetic && !confirmed && review !== "approved") {
          gaps.push("Verify the hospital and document role for the exact snapshot before using extracted numbers.");
          continue;
        }
        const quote = finding.evidence[o.evidence_index].quote;
        value = parseProfile(measure.evaluator, quote, c.doc.language);
        const segments = Object.values(textCache.get(c.doc.source_id));
        const workerRow = /^One-person household\s*\|/.test(quote);
        const units = workerRow ? segments.flatMap((s) => s?.split("\n") ?? [null]) : segments;
        const located = c.content === quote || c.content.split("\n").includes(quote);
        const matches = units.filter((s) => typeof s === "string").map((s) => parseProfile(measure.evaluator, s, c.doc.language)).filter(Boolean);
        if (!value || !located || segments.includes(null) || matches.length !== 1 || !isDeepStrictEqual(matches[0], value)) {
          gaps.push("Verify the full source and reconcile competing or incomplete " + measure.evaluator + " observations.");
          continue;
        }
      } else {
        if (review !== "approved") { gaps.push("Obtain exact human review of the structured interpretation."); continue; }
        value = o.value;
      }
      requireValue(isDeepStrictEqual(value, o.value), "Observed values differ from saved source facts");
      requireValue(!facts.has(c.doc.source_id), "Multiple observations for the same measure and source; reconcile explicitly");
      facts.set(c.doc.source_id, value);
    }
    return { facts, review, gaps };
  }
  return { registry, evidence };
}
