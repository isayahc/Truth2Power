import { isDeepStrictEqual } from "node:util";
import { rubric, hhs, referenceHash, byId, expectedFor, contextKeys, contextOf, requireValue, validateSchema } from "./data.js";
import { evidenceStore } from "./evidence.js";
import { evaluateMeasure } from "./measures.js";

const band = (count) => rubric.bands.find((b) => count >= b.min_errors && count <= b.max_errors).grade;

/** Enumerate feasible error counts and overrides, including the disputed policy branch. */
export function calculate(findings) {
  const results = new Map(findings.map((f) => [f.measure_id, f.result]));
  requireValue(findings.length === 17 && results.size === 17 && rubric.measures.every((m) => results.has(m.measure_id)) &&
    [...results.values()].every((v) => Object.hasOwn(rubric.results, v)), "Expected all 17 distinct rubric measures");
  const failed = [], unresolved = [], applicable_overrides = [];
  let states = new Map([["0/false", [0, false]]]);
  for (const m of rubric.measures) {
    const result = results.get(m.measure_id), override = rubric.overrides.find((o) => o.measure_id === m.measure_id);
    if (result === "no") {
      failed.push(m.measure_id);
      if (override?.status === "applicable") applicable_overrides.push(m.measure_id);
    }
    if (["unclear", "n_a"].includes(result)) unresolved.push(m.measure_id);
    const possibilities = ["yes", "no"].includes(result) ? [result] : ["yes", "no"];
    const next = new Map();
    for (const [count, forced] of states.values()) for (const possibility of possibilities) {
      const fails = possibility === "no", n = count + Number(fails);
      const flags = fails && override?.status === "disputed" ? [forced, true] : [forced || (fails && override?.status === "applicable")];
      for (const f of flags) next.set(n + "/" + f, [n, f]);
    }
    states = next;
  }
  const possible = new Set([...states.values()].map(([n, forced]) => forced ? "F" : band(n)));
  const possible_grades = rubric.bands.map((b) => b.grade).filter((g) => possible.has(g));
  const disputed = rubric.overrides.find((o) => o.status === "disputed");
  const policyResult = results.get(disputed.measure_id);
  const errorsIfMissing = failed.length + Number(policyResult !== "no");
  const policy_can_change_grade = policyResult !== "yes" && !applicable_overrides.length && band(errorsIfMissing) !== "F";
  return { failed_measures: failed, verified_errors: failed.length, unresolved_measures: unresolved, applicable_overrides,
    policy_can_change_grade, possible_grades, calculated_grade: !unresolved.length && possible_grades.length === 1 ? possible_grades[0] : null };
}

/** Replay a single saved assessment. This entry point has no network, database or publication writes. */
export function grade(input, { root, decisions, previous } = {}) {
  validateSchema(input);
  requireValue(input.reference_version === hhs.reference_version, "Unsupported reference version");
  const completed = Date.parse(input.last_successful_assessment_at), attempted = Date.parse(input.attempt.attempted_at);
  requireValue(input.attempt.status === "failed" ? attempted >= completed : attempted <= completed, "Inconsistent attempt and completion dates");
  if (input.attempt.status === "failed") {
    requireValue(previous?.attempt?.status === "completed", "Supply the retained completed assessment with --previous for a failed recheck");
    const retained = { ...input, attempt: previous.attempt, refresh_status: previous.refresh_status };
    requireValue(isDeepStrictEqual(retained, previous), "Failed recheck cannot replace the retained assessment");
    requireValue(Date.parse(previous.attempt.attempted_at) <= completed, "Invalid retained completion date");
  }
  requireValue(input.synthetic || input.origin?.format !== "worker", "The demo worker produces synthetic evidence");
  const byMeasure = new Map(input.findings.map((f) => [f.measure_id, f]));
  requireValue(byMeasure.size === byId.size && [...byId.keys()].every((id) => byMeasure.has(id)), "Duplicate or missing measure ID");
  const store = evidenceStore(input, root, decisions);
  const gaps = [...input.scope.gaps, ...input.sources.filter((d) => !["reviewed", "unrelated"].includes(d.status))
    .map((d) => `${d.role} [${d.language}] ${d.source_id}: ${d.status}.`)];
  const stale = !hhs.years[input.guideline_year] || Number(input.review_date.slice(0, 4)) !== input.guideline_year;
  const findings = rubric.measures.map((m) => {
    const f = byMeasure.get(m.measure_id);
    requireValue(contextKeys.every((key) => f[key] === input[key]), "Mixed assessment context: " + m.measure_id);
    requireValue(isDeepStrictEqual(f.expected, expectedFor(m, input.guideline_year)), "Mismatched expected criterion: " + m.measure_id);
    requireValue(!["yes", "no"].includes(f.result) || (f.evidence.length && f.observed.length), "Missing evidence or observations: " + m.measure_id);
    requireValue(!["unclear", "n_a"].includes(f.result) || f.unresolved_evidence.length, "Describe unresolved evidence: " + m.measure_id);
    const checked = store.evidence(m, f);
    const evaluated = evaluateMeasure(m, input, checked.facts);
    const blockers = [...checked.gaps, ...evaluated.gaps];
    if (m.evaluator === "fpl" && stale) blockers.push("No applicable HHS guideline year for this review date.");
    if (f.result === "n_a") blockers.push("No approved exemption or denominator adjustment in this rubric.");
    if (["yes", "no"].includes(evaluated.result) && ["yes", "no"].includes(f.result))
      requireValue(evaluated.result === f.result, "Declared outcome contradicts verified observations: " + m.measure_id);
    const result = f.result === "n_a" ? "n_a" : f.result === "unclear" || blockers.length ? "unclear" : evaluated.result;
    return { measure_id: m.measure_id, css_column: m.css_column, result, submitted_result: f.result, human_review: checked.review,
      reason: [...new Set(blockers)].join(" ") || `Verified ${m.css_column} observations evaluate to ${result} under ${m.evaluator}.`,
      coverage_gaps: [...new Set(blockers)], expected: f.expected, evidence: f.evidence, document_results: evaluated.document_results, comparisons: evaluated.comparisons };
  });
  const score = calculate(findings);
  const approved = findings.filter((f) => f.human_review === "approved").length;
  const reasons = [];
  if (score.unresolved_measures.length) reasons.push(`${score.unresolved_measures.length} measures require evidence, scope or exemption review.`);
  if (score.applicable_overrides.length) reasons.push("Automatic F from " + score.applicable_overrides.join(", ") + ".");
  if (score.policy_can_change_grade) reasons.push("The disputed missing-statement override can affect the result (#10).");
  if (gaps.length) reasons.push("Declared assessment scope has outstanding coverage gaps.");
  if (approved !== 17) reasons.push(`Exact observation review recorded for ${approved}/17 measures.`);
  if (score.calculated_grade) reasons.push(`${score.verified_errors} verified errors across 17 resolved measures; calculated grade ${score.calculated_grade}.`);
  reasons.push("Subject-matter agreement on the output contract (#67) and institutional grade authorization are pending.");
  return { schema_version: "grading-report-v1", synthetic: input.synthetic, ...contextOf(input), reference_sha256: referenceHash,
    assessment_status: "completed", last_attempt: input.attempt, last_successful_assessment_at: input.last_successful_assessment_at,
    refresh_status: input.refresh_status, guideline_status: stale ? "inapplicable_year" : "applicable",
    human_review_status: approved === 17 ? "complete" : approved ? "partial" : "pending",
    ...(input.origin ? { origin: input.origin } : {}), source_coverage: input.sources, coverage_gaps: gaps, findings, ...score,
    grade_status: "pending", final_grade: null, reasons, authority: rubric.authority_status };
}
