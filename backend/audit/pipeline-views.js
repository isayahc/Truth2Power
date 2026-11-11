import { publicSourceUrl } from "./failure-diagnostic.js";
import { publications } from "./pipeline-store.js";

/** Publish cited original snapshots using revision-scoped download links. */
export function publicAgentReview(bundle, jobId) {
  const review = bundle.agent_review;
  if (!review) return null;
  const revisionUrl = `/api/pilot/v1/runs/audit-run-${jobId}/revision/${bundle.id}`;
  const cite = ({source_id, sha256, locator, quote}) => ({
    source_id: publicSourceUrl(source_id), sha256, quote,
    locator: locator.startsWith("link ") ? "link " + (publicSourceUrl(locator.slice(5)) ?? "on saved page") : locator,
    download: `${revisionUrl}/snapshots/${sha256}`,
  });
  const findings = review.findings.map(({measure_id, result, explanation, evidence, identity_basis}) => ({
    measure_id, result, explanation, revision_url: revisionUrl, evidence: evidence.map(cite),
    ...(identity_basis?.length && { identity_basis: identity_basis.map(i => ({
      source_id: publicSourceUrl(i.source_id), proposed_role: i.proposed_role, evidence: i.evidence.map(cite),
    })) }),
  }));
  return { status: review.status, agents: review.agents, omitted_passages: review.omitted_passages, findings };
}

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
    const sourceReviews = b.inventory?.sources.filter(s => s.review) ?? [];
    const envelope = reviewEnvelope(b);
    const agentReview = publicAgentReview(b, b.job);
    records.push({ hospital_key: b.input.hospital_key, record_id: b.id, scope: "integrated-assessment", kind: "pipeline", synthetic: b.input.synthetic,
      scope_label: envelope.scope_label, guideline_year: b.input.guideline_year, review_date: b.input.review_date,
      checked_at: envelope.checked_at, status: "completed", report: b.report, audit_mode: b.mode || "replay",
      monitoring_at: b.input.sources.filter((s) => s.snapshot && !["uniform_reference", "psa_reference"].includes(s.role)).map((s) => s.snapshot.retrieved_at).sort((a, b) => Date.parse(a) - Date.parse(b))[0] ?? null,
      landing_page: b.input.sources.filter((s) => s.role === "landing_page" && s.snapshot).map((s) => s.snapshot),
      ...(agentReview?.findings.length && { agent_findings: agentReview.findings }),
      findings: envelope.findings.map((f, index) => ({ ...f,
        candidate_passages: sourceReviews.flatMap(s => {
          const passages = s.review.observations[f.measure_id] ?? [];
          return passages.filter(p => !b.report.findings[index].evidence.some(e =>
            e.source_id === s.source_id && e.locator === p.locator && e.quote === p.quote)).map(p => ({
            ...p, source_url: s.source_id, sha256: s.digest, saved_url: `/api/pilot/snapshots/${s.digest}`,
            worker: s.review.worker, role: s.role, language: s.language, campus: s.campus_applicability,
          }));
        }),
        evidence: f.evidence.map((e, i) => {
        const s = envelope.snapshots.find(s => s.url === b.report.findings[index].evidence[i].source_id && s.snapshot_id === e.snapshot_id);
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
