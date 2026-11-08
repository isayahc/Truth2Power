import { readdirSync, readFileSync, statSync, mkdirSync, writeFileSync, realpathSync, linkSync, unlinkSync } from "node:fs";
import { join, resolve, sep } from "node:path";
import { randomUUID } from "node:crypto";

import { reviewIdentity, sha256 as digest } from "./identity.js";
const titles = {
  "posted_materials.no_submission_time_limit": "Application deadlines",
  "posted_materials.no_evidence_of_asset_checks": "Asset eligibility checks",
  "posted_materials.no_immigration_status_barrier": "Immigration eligibility",
  "posted_materials.primary_service_area_boundaries_compliant": "Service-area rule",
  "application.uniform_application": "Entire Uniform Application",
  "application.contact_information": "Application contact information",
  "application.income_discount_tables": "Income and discount tables",
  "application.fpl_guidelines": "Application FPL year and amounts",
  "application.maximum_fpl": "Application coverage through 400% FPL",
  "application.installments_cap": "Monthly installment cap",
};
function fail(status, message) { throw Object.assign(new Error(message), { status }); }
function files(path) {
  try { return readdirSync(path); } catch (error) { if (error.code === "ENOENT") return []; throw error; }
}
function bytes(path, root) {
  const actual = realpathSync(path);
  if (!actual.startsWith(realpathSync(root) + sep) || statSync(actual).size > 20 * 1024 * 1024) fail(422, "Source is unavailable.");
  return readFileSync(actual);
}
const safeUrl = (url) => typeof url === "string" && /^https?:\/\//.test(url) ? url : null;

/** Local public-document inbox. Decisions are append-only and tied to exact result bytes. */
export function createReviewService(root, hospitals = []) {
  root = resolve(root);
  const names = new Map(hospitals.map((h) => [String(h.id), h.properties.name]));
  const decisionDirectory = join(root, "review-inbox-decisions");

  function drafts() {
    const groups = new Map();
    let unavailable = 0;
    for (const namespace of ["full-reviews", "application-reviews"]) for (const review of files(join(root, namespace))) {
      if (!/^[a-f0-9]{32}$/.test(review)) continue;
      for (const filename of files(join(root, namespace, review, "results"))) {
        if (!/^[a-f0-9]{32}\.json$/.test(filename)) continue;
        try {
          const raw = bytes(join(root, namespace, review, "results", filename), root);
          const result = JSON.parse(raw);
          if (result.review_id !== review || result.result_id !== filename.slice(0, -5) ||
              !/^(?:\d{1,8}|t2p-\d+)$/.test(result.hospital_key) || !Number.isFinite(Date.parse(result.checked_at)) ||
              !Array.isArray(result.findings) || !Array.isArray(result.snapshots) || !Array.isArray(result.coverage)) throw new Error("Invalid result");
          const hash = digest(raw);
          const identity = reviewIdentity(result, namespace, hash);
          if (!groups.has(identity.group)) groups.set(identity.group, []);
          groups.get(identity.group).push({ result, hash, identity, namespace });
        } catch { unavailable++; }
      }
    }
    for (const versions of groups.values()) versions.sort((a, b) =>
      Date.parse(b.result.checked_at) - Date.parse(a.result.checked_at) || b.result.result_id.localeCompare(a.result.result_id) ||
      b.hash.localeCompare(a.hash));
    return { groups, unavailable };
  }

  function decisions() {
    return files(decisionDirectory).filter((name) => /^[a-f0-9-]{36}\.json$/.test(name))
      .map((name) => JSON.parse(bytes(join(decisionDirectory, name), root)))
      .sort((a, b) => a.sequence - b.sequence);
  }

  function items(includeHistory = false) {
    const { groups, unavailable } = drafts();
    const saved = decisions();
    const rows = [];
    for (const versions of groups.values()) for (const record of includeHistory ? versions : versions.slice(0, 1)) {
      const { result, hash, identity, namespace } = record;
      // Include favorable drafts too: model output is not automatically human-approved.
      const findings = [...result.findings];
      if (result.psa?.result === "unclear" && !findings.some((f) => f.measure_id === "posted_materials.primary_service_area_boundaries_compliant")) {
        findings.push({ measure_id: "posted_materials.primary_service_area_boundaries_compliant", result: "unclear",
          explanation: result.psa.note || "The applicable service-area rule needs review.",
          expected: "An approved, cited service-area boundary rule and applicable hospital boundaries.",
          unresolved_questions: [result.psa.unresolved_question || "Which approved service-area rule applies?"],
          authority_url: safeUrl(result.psa.authority), evidence: [] });
      }
      for (const finding of findings) {
        if (!titles[finding.measure_id] || !["yes", "no", "unclear", "n_a"].includes(finding.result)) continue;
        const id = digest(`${hash}:${finding.measure_id}`);
        const history = saved.filter((d) => d.item_id === id && d.result_id === result.result_id &&
          d.result_sha256 === hash && d.hospital_key === result.hospital_key && d.measure_id === finding.measure_id);
        const last = history.at(-1);
        const status = last?.action === "confirm" || last?.action === "correct" ? "resolved" : last ? "needs_information" : "pending";
        rows.push({ id, hospital_key: result.hospital_key, hospital_name: names.get(result.hospital_key) ?? `Hospital ${result.hospital_key}`,
          measure_id: finding.measure_id, title: titles[finding.measure_id], flagged_at: result.checked_at,
          scope_label: result.scope_label ?? "Posted-material review", guideline_year: result.guideline_year ?? null,
          result_id: result.result_id, result_sha256: hash, status, draft_result: finding.result,
          reviewed_result: status === "resolved" ? last.result : null, revision: history.length,
          question: finding.unresolved_questions?.length ? finding.unresolved_questions.join(" ") :
            finding.result === "unclear" ? "What evidence is needed to resolve this finding?" : "Does the cited evidence support this draft finding?",
          namespace, logical_review_id: identity.group, identity_status: identity.identity_status, identity_warning: identity.identity_warning,
          documents: identity.documents, is_current: record === versions[0], version_count: versions.length,
          versions, finding, result, history });
      }
    }
    return { rows, unavailable };
  }
  function get(id, currentOnly = false) {
    if (!/^[a-f0-9]{64}$/.test(id)) fail(404, "Review item not found.");
    const row = items(!currentOnly).rows.find((r) => r.id === id);
    if (!row) fail(404, "Review item no longer current. Refresh the inbox.");
    return row;
  }
  function summary(row) {
    const { finding, result, history, versions, ...rest } = row;
    return rest;
  }
  function sourceMetadata(row, citation) {
    const source = row.result.snapshots.find((s) => s.snapshot_id === citation.snapshot_id);
    if (!source) return { ...citation, unavailable: true };
    const page = /^page (\d+)$/.exec(citation.locator)?.[1];
    return { ...citation, document: source.display_name || source.url?.split("/").at(-1) || source.document_type,
      url: safeUrl(source.url), retrieved_at: source.retrieved_at,
      saved_url: `/api/reviews/${row.id}/sources/${source.snapshot_id}${page ? `#page=${page}` : ""}` };
  }
  function verifiedSource(row, snapshotId) {
    const source = row.result.snapshots.find((s) => s.snapshot_id === snapshotId);
    if (!source || !/^[a-f0-9]{64}$/.test(snapshotId) || !/^[a-f0-9]{64}$/.test(source.sha256) ||
        !new RegExp(`^snapshots/${source.sha256}\\.(pdf|html|docx)$`).test(source.artifact_path)) fail(404, "Saved source not found.");
    let raw;
    try { raw = bytes(join(root, source.artifact_path), root); } catch { fail(404, "Saved source unavailable."); }
    if (digest(raw) !== source.sha256) fail(422, "Saved source failed integrity verification.");
    return { source, raw };
  }
  return {
    list(filters = {}) {
      const { rows: all, unavailable } = items();
      const rows = all.filter((r) => (!filters.hospital_key || r.hospital_key === filters.hospital_key) &&
        (!filters.namespace || r.namespace === filters.namespace) &&
        (!filters.source_id && !filters.role && !filters.language || r.documents.some((d) =>
          (!filters.source_id || d.source_id === filters.source_id) && (!filters.role || d.role === filters.role) &&
          (!filters.language || d.language === filters.language))));
      return { items: rows.map(summary), pending: rows.filter((r) => r.status !== "resolved").length, unavailable };
    },
    detail(id) {
      const row = get(id);
      return { ...summary(row), document_versions: row.versions.map(({ result, hash, identity }) => ({
          result_id: result.result_id, checked_at: result.checked_at, result_sha256: hash, documents: identity.documents,
          item_id: result.findings.some((f) => f.measure_id === row.measure_id) ||
            (result.psa?.result === "unclear" && row.measure_id === "posted_materials.primary_service_area_boundaries_compliant")
            ? digest(`${hash}:${row.measure_id}`) : null,
        })), explanation: row.finding.explanation, expected: row.finding.expected, observed: row.finding.observed,
        authority_url: row.finding.authority_url ?? safeUrl(row.finding.expected?.authority_url),
        other_application_versions_not_assessed: (row.result.other_application_versions_not_assessed ?? []).map(safeUrl).filter(Boolean),
        extraction_details: row.result.extraction_details ?? null,
        template_comparison: row.measure_id === "application.uniform_application" && row.result.template_comparison ? {
          ...row.result.template_comparison,
          reference_url: safeUrl(row.result.template_comparison.reference_url),
          numeric_authority_url: safeUrl(row.result.reference?.authority_url),
          numeric_reference_version: row.result.reference_version,
          whole_form_review: row.result.template_comparison.whole_form_review ? {
            ...row.result.template_comparison.whole_form_review,
            authority: { ...row.result.template_comparison.whole_form_review.authority,
              url: safeUrl(row.result.template_comparison.whole_form_review.authority.url) },
            renders: Object.fromEntries(Object.entries(row.result.template_comparison.whole_form_review.renders).map(([role, render]) =>
              [role, { ...render, saved_url: sourceMetadata(row, render).saved_url }])),
          } : null,
          observations: row.result.template_comparison.observations.map((o) => ({ ...o,
            evidence: o.evidence.map((c) => sourceMetadata(row, c)) })),
        } : null,
        evidence: (row.finding.evidence ?? []).map((c) => sourceMetadata(row, c)),
        gaps: (row.result.gaps ?? []).map((g) => ({ reason: g.reason, detail: g.detail, url: safeUrl(g.url) })),
        coverage: row.result.coverage.map((c) => ({ source_id: c.source_id, language: c.language, status: c.status,
          total_pages: c.total_pages, reviewed_pages: c.reviewed_pages?.length ?? 0,
          locator_unit: c.locator_unit ?? (row.result.snapshots.some((s) => s.url === c.url && s.artifact_path.endsWith(".docx")) ? "DOCX parts (pagination unverified)" : "pages"),
          url: safeUrl(c.url), notes: c.notes,
          saved_url: c.snapshot_id ? sourceMetadata(row, c).saved_url : row.result.snapshots.some((s) => s.url === c.url) ? `/api/reviews/${row.id}/sources/${row.result.snapshots.find((s) => s.url === c.url).snapshot_id}` : null })),
        history: row.history, observations: (row.result.source_reviews ?? []).flatMap((s) =>
          (s.review?.observations ?? []).filter((o) => o.measure_id === row.measure_id).map((o) =>
            ({ source_id: s.source_id, position: o.position, context: o.context, explanation: o.explanation,
              evidence: o.evidence.map((c) => sourceMetadata(row, c)) }))) };
    },
    decide(id, input) {
      // Synchronous read/check/append avoids two decisions accepting the same revision in this local process.
      const row = get(id, true);
      if (!input || !["confirm", "correct", "request_information"].includes(input.action) ||
          !Number.isInteger(input.revision) || typeof input.notes !== "string" || !input.notes.trim() || input.notes.length > 2000 ||
          typeof input.reviewer_role !== "string" || !input.reviewer_role.trim() || input.reviewer_role.length > 100) fail(400, "Provide an action, reviewer role and reason.");
      if (input.revision !== row.revision) fail(409, "This item changed. Reload before recording a decision.");
      const result = input.action === "confirm" ? row.draft_result : input.action === "correct" ? input.result : null;
      if (input.action === "correct" && !["yes", "no", "unclear", "n_a"].includes(result)) fail(400, "Choose a valid corrected result.");
      if (["yes", "no"].includes(result) && !row.finding.evidence?.length) fail(400, "Evidence must be added to a new draft before recording yes or no.");
      if (["yes", "no"].includes(result)) {
        for (const snapshotId of new Set(row.finding.evidence.map((c) => c.snapshot_id))) verifiedSource(row, snapshotId);
      }
      const hash = digest(id + ":" + (row.revision + 1));
      const slot = `${hash.slice(0, 8)}-${hash.slice(8, 12)}-8${hash.slice(13, 16)}-a${hash.slice(17, 20)}-${hash.slice(20, 32)}`;
      const decision = { decision_id: slot, item_id: id, result_id: row.result_id,
        result_sha256: row.result_sha256, hospital_key: row.hospital_key, measure_id: row.measure_id,
        action: input.action, result, notes: input.notes.trim(), reviewer_role: input.reviewer_role.trim(),
        recorded_at: new Date().toISOString(), sequence: row.revision + 1, identity: "self_attested_local_reviewer" };
      mkdirSync(decisionDirectory, { recursive: true });
      const temporary = join(decisionDirectory, randomUUID() + ".tmp");
      writeFileSync(temporary, JSON.stringify(decision, null, 2), { flag: "wx" });
      try { linkSync(temporary, join(decisionDirectory, slot + ".json")); }
      catch (error) {
        if (error.code === "EEXIST") fail(409, "This item changed. Reload before recording a decision.");
        throw error;
      } finally { unlinkSync(temporary); }
      return this.detail(id);
    },
    source(id, snapshotId) {
      const row = get(id);
      const { source, raw } = verifiedSource(row, snapshotId);
      // Never execute saved website HTML under the application's origin.
      return { body: raw.toString("base64"), isBase64Encoded: true, headers: {
        "Content-Type": source.artifact_path.endsWith(".docx") ? "application/vnd.openxmlformats-officedocument.wordprocessingml.document" : source.artifact_path.endsWith(".pdf") ? "application/pdf" : "text/plain; charset=utf-8",
        ...(source.artifact_path.endsWith(".docx") ? { "Content-Disposition": 'attachment; filename="application.docx"' } : {}),
        "Content-Security-Policy": "sandbox", "X-Content-Type-Options": "nosniff" } };
    },
  };
}
