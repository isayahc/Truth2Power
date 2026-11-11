import { rubric, contextOf, expectedFor, fingerprint, assistancePages } from "../grading/data.js";
import { postingPaths, isPostingPage } from "../grading/posting-paths.js";
import { parseProfile } from "../grading/profiles.js";
import { fplComparison } from "../grading/measures.js";

/** Reconcile located draft observations with the current rubric and verified source identities. */
function addSpecialistEvidence(finding, measure, sources, reviews, attempts) {
  const existing = new Set(finding.evidence.map(e => JSON.stringify([e.source_id, e.locator, e.quote])));
  for (const source of sources) {
    const review = reviews[source.source_id];
    if (review?.campus_applicability === "other_campus_requires_review") continue;
    const observations = review?.observations[measure.measure_id] ?? [];
    if (!observations.length) continue;
    const pageLink = measure.evaluator === "posting" && isPostingPage(source);
    if (!measure.roles.includes(source.role) && !pageLink) {
      finding.unresolved_evidence.push(`Verify the role and applicability of candidate evidence: ${source.source_id}`);
      continue;
    }
    for (const { locator, quote } of observations) {
      if (pageLink && !locator.startsWith("link ")) continue;
      const attempted = locator.startsWith("link ") && attempts.get(locator.slice(5));
      if (attempted && attempted.status !== "saved") {
        finding.unresolved_evidence.push(`Linked file unavailable (${attempted.error_code || attempted.reason || "retrieval failed"}): ${attempted.source_url}`);
      }
      const key = JSON.stringify([source.source_id, locator, quote]);
      if (existing.has(key)) continue;
      existing.add(key);
      finding.evidence.push({ source_id: source.source_id, sha256: review.sha256,
        snapshot_id: source.snapshot.snapshot_id, locator, quote });
    }
  }
}

/** Flag incompatible percentages only when the existing parser identifies the same term and units. */
function conflictingPercentages(measure, reviews) {
  if (!["maximum", "installments"].includes(measure.evaluator)) return [];
  const terms = new Map();
  for (const review of Object.values(reviews)) {
    if (review.campus_applicability === "other_campus_requires_review") continue;
    const languages = ["en", ...Object.keys(review.language_candidates)];
    for (const passage of review.observations[measure.measure_id] ?? []) {
      for (const language of languages) {
        const value = parseProfile(measure.evaluator, passage.quote, language);
        if (value) {
          const sources = terms.get(value.percent) ?? new Set();
          sources.add(review.source_id + " · " + passage.locator);
          terms.set(value.percent, sources);
        }
      }
    }
  }
  return terms.size > 1 ? [...terms].map(([n, sources]) =>
    `Reconcile competing published percentages for ${measure.title}: ${n}% at ${[...sources].join(", ")}.`) : [];
}

/** Prepare one draft per criterion for the independent deterministic grader. */
export function reconcileFindings({ input, analysis, scoped, normalization, verified, maxDepth, collection }) {
  const extracted = analysis.sources;
  const attempts = new Map((collection?.documents ?? []).map(d => [d.source_url, d]));
  for (const m of rubric.measures) {
    const originals = scoped.filter((s) => s.success?.measure_id === m.measure_id).map((s) => s.success);
    const f = { ...contextOf(input), measure_id: m.measure_id, expected: expectedFor(m, input.guideline_year), result: "unclear", human_review: "pending", evidence: [], observed: [],
      unresolved_evidence: originals.length ? [...new Set(originals.map((r) => `Source draft ${r.record_id}: ${r.finding.explanation}`))] : [`Collect and review ${m.evidence_requirement}`] };
    for (const review of analysis.application_reviews) {
      const draft = review.findings.find((finding) => finding.measure_id === m.measure_id);
      for (const e of draft?.evidence || []) f.evidence.push({ ...e, source_id: review.source_id, sha256: review.snapshot.sha256 });
    }
    for (const r of originals) for (const e of r.finding.evidence) {
      const s = input.sources.find((s) => s.source_id === e.url && s.snapshot?.sha256 === e.sha256 && m.roles.includes(s.role));
      const segment = s && extracted[s.source_id]?.find((p) => p.locator === e.locator && p.text.includes(e.quote));
      if (!segment) { f.unresolved_evidence.push(`Reverify missing, changed or unsupported citation: ${e.url} · ${e.locator}`); continue; }
      if (!f.evidence.some((c) => c.sha256 === e.sha256 && c.locator === e.locator && c.quote === e.quote)) f.evidence.push({ source_id: s.source_id, snapshot_id: e.sha256, sha256: e.sha256, locator: e.locator, quote: e.quote });
    }
    if (m.evaluator === "posting") {
      f.evidence = [];
      const paths = postingPaths(input.sources, extracted, assistancePages.get(input.hospital_key), m.expected.any_accessible_role, verified, input.hospital_key, maxDepth);
      const links = [...new Set(paths.map((p) => p.target))];
      f.evidence = [...new Map(paths.flatMap((p) => p.evidence).map((e) => [JSON.stringify(e), e])).values()];
      if (links.length) {
        f.result = "yes"; f.unresolved_evidence = [];
        f.observed = [{ evidence_index: f.evidence.findIndex((e) => e.locator.startsWith("link ")), method: "posted_link", value: { links: [...new Set(links)], search_complete: false } }];
      }
    } else if (["fpl", "maximum", "installments"].includes(m.evaluator)) {
      const numeric = [];
      for (const s of input.sources.filter((s) => s.role === "application" && s.snapshot && s.status !== "unreadable")) {
        const matches = extracted[s.source_id].map((p) => ({ p, value: parseProfile(m.evaluator, p.text, s.language) })).filter((v) => v.value);
        if (matches.length !== 1) continue;
        const { p, value } = matches[0];
        const index = f.evidence.push({ source_id: s.source_id, snapshot_id: s.snapshot.sha256, sha256: s.snapshot.sha256, locator: p.locator, quote: p.text }) - 1;
        f.observed.push({ evidence_index: index, method: "text_profile", value });
        numeric.push(m.evaluator === "fpl" ? fplComparison(value, input.guideline_year).result : m.evaluator === "maximum" ? value.percent >= 400 ? "yes" : "unclear" : value.percent <= 5 ? "yes" : "no");
      }
      if (numeric.length && new Set(numeric).size === 1 && ["yes", "no"].includes(numeric[0])) {
        f.result = numeric[0]; f.unresolved_evidence = [];
      }
    } else f.unresolved_evidence.push("The saved qualitative draft is not a verified structured observation or human approval. Review its exact evidence under the grading contract.");
    for (const reused of normalization.flatMap((n) => n.accepted).filter((o) => o.measure_id === m.measure_id)) {
      const same = f.observed.find((o) => f.evidence[o.evidence_index].source_id === reused.evidence.source_id);
      if (same && fingerprint(same.value) !== fingerprint(reused.observation.value)) {
        f.unresolved_evidence.push("Conflicting verified historical observation; reconcile the source-specific facts.");
      } else if (!same) {
        const index = f.evidence.push(reused.evidence) - 1;
        f.observed.push({ ...reused.observation, evidence_index: index });
      }
    }
    for (const n of normalization) {
      const decision = n.decisions?.filter((d) => !d.measure_id || d.measure_id === m.measure_id) || [];
      if (decision.some((d) => ["reject", "needs_changes"].includes(d.decision) || ["correct", "request_information"].includes(d.action))) {
        f.unresolved_evidence.push("Reconcile the independent historical review before using these normalized observations.");
      }
    }
    const conflicts = conflictingPercentages(m, analysis.reviews);
    if (conflicts.length) {
      f.result = "unclear";
      f.unresolved_evidence.push(...conflicts);
    }
    if (f.result === "unclear") {
      addSpecialistEvidence(f, m, input.sources, analysis.reviews, attempts);
    }
    f.unresolved_evidence = [...new Set(f.unresolved_evidence)];
    input.findings.push(f);
  }
}
