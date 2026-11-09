import { isDeepStrictEqual } from "node:util";
import { evidenceStore } from "../grading/evidence.js";
import { contextOf, expectedFor, rubric, referenceHash } from "../grading/data.js";

/** Reuse source facts, never producer outcome labels or approval of a different assessment. */
export function normalizeObservations(candidate, input, root) {
  const accepted = [], rejected = [];
  if (!candidate || candidate.hospital_key !== input.hospital_key || candidate.synthetic !== input.synthetic ||
      candidate.guideline_year !== input.guideline_year || candidate.rubric_version !== input.rubric_version ||
      candidate.reference_version !== input.reference_version || candidate.attempt.status !== "completed") {
    return { accepted, rejected: ["Historical observation context differs from this hospital, year or rubric."] };
  }
  const store = evidenceStore(candidate, root);
  for (const f of candidate.findings) {
    const m = rubric.measures.find((m) => m.measure_id === f.measure_id);
    if (!m || !["contact", "tables", "fpl", "maximum", "installments", "summary_area", "summary_process", "summary_income"].includes(m.evaluator)) continue;
    if (!f.observed.length) {
      rejected.push(`${f.measure_id}: no independently verifiable structured observation in this producer.`);
      continue;
    }
    const review = candidate.origin?.finding_review?.[f.measure_id];
    if (f.unresolved_evidence.length || ["reject", "needs_changes", "conflict"].includes(review?.status) ||
        f.observed.some((o) => !["text_profile", "source_field"].includes(o.method))) {
      rejected.push(`${f.measure_id}: unresolved coverage, conflicting review or qualitative interpretation requires independent review.`); continue;
    }
    try {
      const staged = [];
      const checked = store.evidence(m, f);
      if (checked.gaps.length) throw Error(checked.gaps.join(" "));
      for (const o of f.observed) {
        const e = f.evidence[o.evidence_index];
        const old = candidate.sources.find((s) => s.source_id === e.source_id);
        const current = input.sources.find((s) => s.source_id === e.source_id);
        if (!current?.snapshot || current.snapshot.sha256 !== e.sha256 || current.role !== old.role || current.language !== old.language ||
            current.hospital_key !== old.hospital_key || !isDeepStrictEqual(checked.facts.get(e.source_id), o.value)) throw Error("Source identity, role, language or verified value changed");
        staged.push({ measure_id: f.measure_id, evidence: { ...e, snapshot_id: current.snapshot.snapshot_id }, observation: o,
          source_assessment: candidate.assessment_id, reference_sha256: referenceHash,
          context: contextOf(input), expected: expectedFor(m, input.guideline_year) });
      }
      accepted.push(...staged);
    } catch (error) { rejected.push(`${f.measure_id}: ${error.message}`); }
  }
  return { accepted, rejected };
}
