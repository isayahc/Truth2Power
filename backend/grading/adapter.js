import { existsSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { isDeepStrictEqual } from "node:util";
import { sha256, reviewIdentity, languageTag, sourceUrl } from "../review/identity.js";
import { byId, rubric, hhs, referenceHash, confirmedDocuments, postingReference, contextOf, expectedFor, readArtifact, requireValue, validateSchema } from "./data.js";
import { parseProfile } from "./profiles.js";
import { fplComparison } from "./measures.js";
import { evidenceStore } from "./evidence.js";

const blockers = (code, action, measure_id) => ({ code, action, ...(measure_id ? { measure_id } : {}) });
const rubricForFormat = { "application-reviews": "english-uniform-application-profile-v1", "full-reviews": "full-text-three-measures-v1", worker: "demo-v1", posting: "wave-one-posting-v1" };

/** Import only decisions actually tied to this original result, retaining disagreements and their scope. */
function originalReviews(root, artifact, hash, format) {
  if (artifact.attempt) return [];
  requireValue(/^[a-f0-9]{32}$/.test(artifact.review_id) && /^[a-f0-9]{32}$/.test(artifact.result_id), "Invalid Python result identity");
  const records = [];
  for (const directory of ["review-inbox-decisions", join(format, artifact.review_id, "human-decisions")]) {
    if (!existsSync(join(root, directory))) continue;
    for (const file of readdirSync(join(root, directory)).sort()) {
      if (!/^[a-f0-9-]{32,36}\.json$/.test(file)) continue;
      const d = JSON.parse(readArtifact(root, join(directory, file)));
      if (d.result_sha256 !== hash || d.result_id !== artifact.result_id) continue;
      if (directory === "review-inbox-decisions") {
        requireValue(d.hospital_key === artifact.hospital_key && d.item_id === sha256(hash + ":" + d.measure_id) &&
          ["confirm", "correct", "request_information"].includes(d.action) && Number.isInteger(d.sequence), "Malformed exact-item decision");
      } else requireValue(["approve", "reject", "needs_changes"].includes(d.decision), "Malformed draft decision");
      requireValue(typeof d.reviewer_role === "string" && d.reviewer_role.trim() && typeof d.notes === "string" && d.notes.trim() &&
        Number.isFinite(Date.parse(d.recorded_at)), "Incomplete source decision");
      records.push(d);
    }
  }
  return records;
}

function decisionsFor(records, id) {
  const whole = records.filter((d) => !d.item_id).map((d) => d.decision);
  const item = records.filter((d) => d.measure_id === id).sort((a, b) => a.sequence - b.sequence);
  const last = item.at(-1);
  const states = new Set(whole);
  if (last) states.add(last.action === "request_information" ? "needs_changes" : "approve");
  if (new Set(item.map((d) => d.sequence)).size !== item.length || states.size > 1) return { status: "conflict" };
  return { status: [...states][0] ?? "pending", reviewed_result: last?.result ?? null };
}

function inventory(artifact, format) {
  const sources = new Map();
  const add = (s) => {
    const prior = sources.get(s.source_id);
    if (prior && (!isDeepStrictEqual(prior.snapshot, s.snapshot) || prior.role !== s.role || prior.language !== s.language))
      throw Error("Ambiguous versions or roles at one source URL");
    sources.set(s.source_id, s);
  };
  for (const s of artifact.snapshots) {
    // Derived renderings are supporting material only. Preserve all of them in the original provenance.
    if (s.derived_from_snapshot_id || s.render_engine) continue;
    const source_id = sourceUrl(s.url);
    const c = (artifact.coverage ?? []).find((c) => c.url && sourceUrl(c.url) === source_id &&
      (!c.snapshot_sha256 || c.snapshot_sha256 === s.sha256) && !c.source_id.endsWith("_visual_review"));
    const demoWorker = format === "worker" && artifact.rubric_version === "demo-v1";
    const role = c?.source_id === "official_reference" ? "uniform_reference" : s.document_type;
    const known = format === "posting" && confirmedDocuments.find((d) => d.hospital_key === artifact.hospital_key && d.sha256 === s.sha256 && d.role === role);
    const status = format === "posting" ? (role === "landing_page" ? "reviewed" : "available") : c?.status === "reviewed" || demoWorker ? "reviewed" : c?.status === "unrelated" ? "unrelated" :
      c?.status === "extracted" ? "available" : c?.status?.includes("translation") ? "translation_needed" : "not_reviewed";
    add({ source_id, hospital_key: artifact.hospital_key, role, language: languageTag(c?.language || known?.language), status,
      snapshot: { snapshot_id: s.snapshot_id, sha256: s.sha256, url: s.url, artifact_path: s.artifact_path,
        retrieved_at: s.retrieved_at, publisher_updated_at: s.publisher_updated_at ?? null } });
  }
  for (const url of artifact.other_application_versions_not_assessed ?? []) {
    const source_id = sourceUrl(url);
    if (!sources.has(source_id)) add({ source_id, hospital_key: artifact.hospital_key, role: "application", language: "und", status: "not_reviewed", snapshot: null });
  }
  return [...sources.values()];
}

function projectFinding(m, original, input, review, store, blockersOut) {
  const f = { ...contextOf(input), measure_id: m.measure_id, expected: expectedFor(m, input.guideline_year), result: "unclear",
    human_review: "pending", observed: [], evidence: [], unresolved_evidence: [] };
  function block(code, action) {
    f.unresolved_evidence.push(action);
    blockersOut.push(blockers(code, action, m.measure_id));
  }
  if (!original) { block("missing_measure", "Collect " + m.evidence_requirement); return f; }
  for (const citation of original.evidence ?? []) {
    const matches = input.sources.filter((d) => d.snapshot?.snapshot_id === citation.snapshot_id);
    if (matches.length !== 1 || !m.roles.includes(matches[0].role)) {
      block("citation_scope", "Disambiguate the cited snapshot and its designated document role."); continue;
    }
    const d = matches[0];
    f.evidence.push({ source_id: d.source_id, snapshot_id: citation.snapshot_id, sha256: d.snapshot.sha256, locator: citation.locator, quote: citation.quote });
  }
  if (original.result === "unclear" || original.result === "n_a") {
    f.result = original.result;
    block("unresolved_original", (original.unresolved_questions ?? []).join(" ") || original.explanation || "Resolve the original evidence gap.");
  } else if (m.evaluator === "posting" && input.scope_id === "direct-linked-postings-v1") {
    requireValue(original.result === "yes", "Direct-link scope cannot establish absence");
    const index = f.evidence.findIndex((e) => e.locator.startsWith("link "));
    f.observed = [{ evidence_index: index, method: "posted_link", value: { links: original.observed.links, search_complete: false } }];
    f.result = "yes";
  } else {
    const observations = f.evidence.map((e, index) => ({ evidence_index: index, method: "text_profile", value: parseProfile(m.evaluator, e.quote) })).filter((o) => o.value);
    if (observations.length === 1) {
      f.observed = observations;
      const v = observations[0].value;
      const derived = m.evaluator === "fpl" ? fplComparison(v, input.guideline_year).result :
        m.evaluator === "maximum" ? (v.percent >= 400 ? "yes" : "unclear") : (v.percent <= 5 ? "yes" : "no");
      if (derived === original.result) f.result = derived;
      else block("incomplete_or_disputed_observation", "Reconcile the bounded source observation with the full measure criterion.");
    } else block("needs_structured_observation", "Supply verified measure-specific observations and resolve the interpretation.");
  }
  if (["reject", "needs_changes", "conflict"].includes(review.status) || (review.reviewed_result && review.reviewed_result !== f.result)) {
    f.result = "unclear";
    block("review_conflict", "Reconcile the exact-artifact review with the proposed structured observations.");
  }
  // Verify every carried quote, even a quote supplied by an unapproved model.
  const checked = store.evidence(m, f);
  for (const gap of checked.gaps) if (!f.unresolved_evidence.includes(gap)) {
    f.result = "unclear";
    block("source_verification", gap);
  }
  return f;
}

/** Adapt exactly one native artifact. Source decisions never authorize a different normalized representation. */
export function adaptArtifact(raw, { root, reviewDate, previous } = {}) {
  const hash = sha256(raw), issues = [];
  let provenance = { artifact_sha256: hash };
  try {
    const a = JSON.parse(raw);
    const format = a.attempt ? (a.rubric_version === "wave-one-posting-v1" ? "posting" : "worker") : a.review_type === "application" ? "application-reviews" : a.review_id ? "full-reviews" : null;
    requireValue(format && root, "Provide one supported artifact and its evidence root");
    provenance = { ...provenance, format, original: a };
    if (a.attempt) validateSchema(a, "live-audit-v1.schema.json");
    requireValue(rubricForFormat[format] === a.rubric_version, "Unmapped producer rubric version");
    if (format === "posting") requireValue(a.reference_version === postingReference && a.attempt.status === "completed", "Unverified posting inventory or incomplete assessment");
    if (format === "worker" && a.reference_version !== `hhs-${a.guideline_year}-contiguous-us`) throw Error("Unmapped worker reference version");
    if (format === "worker") requireValue(a.hospital_key === "362", "This synthetic worker rubric is bound to hospital 362");
    if (a.attempt?.status === "failed") {
      requireValue(!a.last_successful_assessment_at || Date.parse(a.attempt.attempted_at) >= Date.parse(a.last_successful_assessment_at), "Failed recheck predates the retained assessment");
      if (previous) validateSchema(previous);
      if (previous) requireValue(previous.hospital_key === a.hospital_key && previous.last_successful_assessment_at === a.last_successful_assessment_at &&
        previous.attempt.status === "completed" && previous.origin?.format === format && previous.origin.rubric_version === a.rubric_version &&
        previous.rubric_version === rubric.version && previous.reference_version === hhs.reference_version, "Previous assessment identity or success date differs");
      return { status: "failed_recheck", input: null, provenance, retained_assessment: previous ?? null,
        blockers: [blockers("failed_recheck", "Retain the prior successful assessment and retry the failed retrieval.")] };
    }
    if (a.attempt) requireValue(a.last_successful_assessment_at === a.assessment.completed_at, "Invalid last completed assessment");
    const sourceReview = originalReviews(root, a, hash, format);
    provenance.decisions = sourceReview;
    if (format === "application-reviews") requireValue(a.reference_version === hhs.reference_version && a.reference_sha256 === referenceHash, "Unpinned application reference bytes");
    if (format === "full-reviews" && a.reference_version && a.reference_version !== hhs.reference_version)
      throw Error("Unmapped full-review reference version");
    if (a.review_date && reviewDate && a.review_date !== reviewDate) throw Error("Review date conflicts with original assessment");
    const date = a.review_date ?? reviewDate;
    if (!a.attempt) provenance.identity = reviewIdentity(a, format, hash);
    requireValue(date, "Supply the actual review date with --review-date; checked_at is the execution time");
    provenance.review_date_origin = a.review_date ? "artifact" : "explicit_adapter_input";
    const originals = a.attempt ? a.assessment.findings : a.findings;
    const columns = { worker: ["AH"], posting: ["R","S","T"], "application-reviews": ["AD","AE","AG","AH","AI","AJ"], "full-reviews": ["W","Y","Z"] };
    requireValue(Array.isArray(originals) && originals.every((f) => columns[format].includes(byId.get(f.measure_id)?.css_column) &&
      Object.hasOwn(rubric.results, f.result)) &&
      new Set(originals.map((f) => f.measure_id)).size === originals.length, "Unknown, duplicate or invalid original finding");
    if (format === "posting") requireValue(originals.length === 3, "Expected exactly R, S and T");
    const sources = inventory(a, format);
    const scopeGaps = ["This producer covers a partial assessment. Verify the complete hospital inventory and measure-specific language coverage."];
    if (format === "posting") for (const f of originals) {
      for (const gap of f.observed.coverage_gaps) scopeGaps.push(gap.url + " " + gap.reason);
    }
    for (const g of [...(a.gaps ?? []), ...(a.collection_gaps ?? [])]) scopeGaps.push([g.url, g.locator, g.reason, g.detail].filter(Boolean).join(" "));
    if (provenance.identity?.identity_status === "ambiguous_legacy") scopeGaps.push("Resolve ambiguous original document identity.");
    const input = { schema_version: "grading-input-v1", synthetic: format === "worker" || a.synthetic === true,
      hospital_key: a.hospital_key, assessment_id: a.result_id ?? a.assessment.assessment_id,
      scope_id: format === "posting" ? "direct-linked-postings-v1" : provenance.identity?.group ?? "synthetic-single-campus", rubric_version: rubric.version, reference_version: hhs.reference_version,
      guideline_year: a.guideline_year ?? Number(date.slice(0, 4)), review_date: date,
      attempt: a.attempt ?? { attempt_id: a.result_id, attempted_at: a.checked_at, status: "completed" },
      last_successful_assessment_at: a.last_successful_assessment_at ?? a.checked_at, refresh_status: "unknown",
      scope: { inventory_status: "partial", online_application: "unknown", required_sources: sources.map((d) => d.source_id), gaps: [...new Set(scopeGaps)] },
      sources, findings: [] };
    const store = evidenceStore(input, root);
    provenance.finding_review = {};
    for (const m of rubric.measures) {
      const review = decisionsFor(sourceReview, m.measure_id);
      provenance.finding_review[m.measure_id] = review;
      const projected = projectFinding(m, originals.find((f) => f.measure_id === m.measure_id), input, review, store, issues);
      if (format === "full-reviews" && m.css_column === "V" && a.psa?.result === "unclear" && typeof a.psa.unresolved_question === "string") {
        projected.unresolved_evidence.push(a.psa.unresolved_question);
        issues.push(blockers("unresolved_psa_authority", a.psa.unresolved_question, m.measure_id));
      }
      input.findings.push(projected);
    }
    input.origin = { format, artifact_sha256: hash, original_id: input.assessment_id, rubric_version: a.rubric_version,
      reference_version: a.reference_version ?? null, finding_review: provenance.finding_review, decisions: sourceReview };
    validateSchema(input);
    issues.push(blockers("partial_inventory", scopeGaps[0]), blockers("observation_review", "Review the normalized observations against the exact sources."),
      blockers("subject_matter_pending", "Record the outstanding subject-matter decision in #67."));
    return { status: "partial", input, provenance, blockers: issues };
  } catch (error) {
    return { status: "blocked", input: null, provenance, blockers: [blockers("invalid_or_missing_provenance", error.message)] };
  }
}
