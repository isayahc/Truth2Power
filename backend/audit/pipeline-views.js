import { publications } from "./pipeline-store.js";

export function reviewEnvelope(bundle) {
  const { input, report } = bundle;
  return { review_id: bundle.id.slice(0, 32), result_id: bundle.id.slice(32), hospital_key: input.hospital_key,
    rubric_version: input.rubric_version, guideline_year: input.guideline_year, reference_version: input.reference_version,
    checked_at: report.last_successful_assessment_at, review_date: input.review_date, publication_job: bundle.job,
    scope_label: `${input.synthetic ? "SYNTHETIC — " : ""}Integrated 17-measure ${bundle.mode || "replay"} assessment · ${bundle.id.slice(0, 12)}`,
    snapshots: input.sources.filter((s) => s.snapshot).map((s) => ({ ...s.snapshot, document_type: s.role })),
    coverage: input.sources.map((s) => ({ source_id: s.source_id, url: s.source_id, language: s.language, status: s.status,
      snapshot_id: s.snapshot?.snapshot_id, notes: "Scope and interpretation remain as recorded in the immutable grading input." })),
    gaps: report.coverage_gaps.map((reason) => ({ reason })),
    findings: report.findings.map((f) => ({ measure_id: f.measure_id, result: f.result, explanation: f.reason,
      expected: f.expected, evidence: f.evidence.map((e) => ({ snapshot_id: e.snapshot_id, locator: e.locator, quote: e.quote })),
      unresolved_questions: f.coverage_gaps })),
  };
}
export function publishedRecords(root) {
  const { bundles, failures } = publications(root), selected = new Map();
  for (const b of bundles) {
    const key = `${b.input.hospital_key}/${b.input.guideline_year}`;
    if (!selected.has(key)) selected.set(key, b);
  }
  const records = [];
  for (const b of selected.values()) {
    const envelope = reviewEnvelope(b);
    records.push({ hospital_key: b.input.hospital_key, record_id: b.id, scope: "integrated-assessment", kind: "pipeline", synthetic: b.input.synthetic,
      scope_label: envelope.scope_label, guideline_year: b.input.guideline_year, review_date: b.input.review_date,
      checked_at: envelope.checked_at, status: "completed", report: b.report, audit_mode: b.mode || "replay",
      monitoring_at: b.input.sources.filter((s) => s.snapshot && !["uniform_reference", "psa_reference"].includes(s.role)).map((s) => s.snapshot.retrieved_at).sort((a, b) => Date.parse(a) - Date.parse(b))[0] ?? null,
      landing_page: b.input.sources.filter((s) => s.role === "landing_page" && s.snapshot).map((s) => s.snapshot),
      findings: envelope.findings.map((f) => ({ ...f, evidence: f.evidence.map((e) => {
        const s = envelope.snapshots.find((s) => s.snapshot_id === e.snapshot_id);
        return { ...e, ...s, saved_url: `/api/pilot/snapshots/${s.sha256}` };
      }) })), affected_measures: envelope.findings.map((f) => f.measure_id) });
    for (const failure of failures.filter((f) => f.hospital === b.input.hospital_key && f.year === b.input.guideline_year && f.id > b.job)) {
      records.push({ hospital_key: failure.hospital, record_id: `failed-${failure.id}-${failure.attempts}`, kind: "pipeline", scope: "integrated-assessment",
        scope_label: envelope.scope_label, guideline_year: failure.year, checked_at: failure.attempted, status: "failed", error: failure.error,
        findings: [], affected_measures: envelope.findings.map((f) => f.measure_id) });
    }
  }
  return records;
}
