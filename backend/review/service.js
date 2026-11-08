import { readdirSync, readFileSync, statSync, mkdirSync, writeFileSync, realpathSync } from "node:fs";
import { join, resolve, sep } from "node:path";
import { createHash, randomUUID } from "node:crypto";

const digest = (bytes) => createHash("sha256").update(bytes).digest("hex");
const titles = {
  "posted_materials.no_submission_time_limit": "Application deadlines",
  "posted_materials.no_evidence_of_asset_checks": "Asset eligibility checks",
  "posted_materials.no_immigration_status_barrier": "Immigration eligibility",
  "posted_materials.primary_service_area_boundaries_compliant": "Service-area rule",
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
    const latest = new Map();
    let unavailable = 0;
    for (const review of files(join(root, "full-reviews"))) {
      if (!/^[a-f0-9]{32}$/.test(review)) continue;
      for (const filename of files(join(root, "full-reviews", review, "results"))) {
        if (!/^[a-f0-9]{32}\.json$/.test(filename)) continue;
        try {
          const raw = bytes(join(root, "full-reviews", review, "results", filename), root);
          const result = JSON.parse(raw);
          if (result.review_id !== review || result.result_id !== filename.slice(0, -5) ||
              !/^(?:\d{1,8}|t2p-\d+)$/.test(result.hospital_key) || !Number.isFinite(Date.parse(result.checked_at)) ||
              !Array.isArray(result.findings) || !Array.isArray(result.snapshots) || !Array.isArray(result.coverage)) throw new Error("Invalid result");
          const prior = latest.get(result.hospital_key);
          if (!prior || Date.parse(result.checked_at) > Date.parse(prior.result.checked_at) ||
              (Date.parse(result.checked_at) === Date.parse(prior.result.checked_at) && result.result_id > prior.result.result_id)) {
            latest.set(result.hospital_key, { result, hash: digest(raw) });
          }
        } catch { unavailable++; }
      }
    }
    return { records: [...latest.values()], unavailable };
  }

  function decisions(id) {
    return files(decisionDirectory).filter((name) => /^[a-f0-9-]{36}\.json$/.test(name))
      .map((name) => JSON.parse(bytes(join(decisionDirectory, name), root)))
      .filter((d) => d.item_id === id).sort((a, b) => a.sequence - b.sequence);
  }

  function items() {
    const { records, unavailable } = drafts();
    const rows = [];
    for (const { result, hash } of records) {
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
        const history = decisions(id);
        const last = history.at(-1);
        const status = last?.action === "confirm" || last?.action === "correct" ? "resolved" : last ? "needs_information" : "pending";
        rows.push({ id, hospital_key: result.hospital_key, hospital_name: names.get(result.hospital_key) ?? `Hospital ${result.hospital_key}`,
          measure_id: finding.measure_id, title: titles[finding.measure_id], flagged_at: result.checked_at,
          result_id: result.result_id, result_sha256: hash, status, draft_result: finding.result,
          reviewed_result: status === "resolved" ? last.result : null, revision: history.length,
          question: finding.unresolved_questions?.length ? finding.unresolved_questions.join(" ") :
            finding.result === "unclear" ? "What evidence is needed to resolve this finding?" : "Does the cited evidence support this draft finding?",
          finding, result, history });
      }
    }
    return { rows, unavailable };
  }
  function get(id) {
    if (!/^[a-f0-9]{64}$/.test(id)) fail(404, "Review item not found.");
    const row = items().rows.find((r) => r.id === id);
    if (!row) fail(404, "Review item no longer current. Refresh the inbox.");
    return row;
  }
  function summary(row) {
    const { finding, result, history, ...rest } = row;
    return rest;
  }
  function sourceMetadata(row, citation) {
    const source = row.result.snapshots.find((s) => s.snapshot_id === citation.snapshot_id);
    if (!source) return { ...citation, unavailable: true };
    const page = /^page (\d+)$/.exec(citation.locator)?.[1];
    return { ...citation, document: source.url?.split("/").at(-1) || source.document_type,
      url: safeUrl(source.url), retrieved_at: source.retrieved_at,
      saved_url: `/api/reviews/${row.id}/sources/${source.snapshot_id}${page ? `#page=${page}` : ""}` };
  }
  return {
    list() {
      const { rows, unavailable } = items();
      return { items: rows.map(summary), pending: rows.filter((r) => r.status !== "resolved").length, unavailable };
    },
    detail(id) {
      const row = get(id);
      return { ...summary(row), explanation: row.finding.explanation, expected: row.finding.expected, authority_url: row.finding.authority_url,
        evidence: (row.finding.evidence ?? []).map((c) => sourceMetadata(row, c)),
        gaps: (row.result.gaps ?? []).map((g) => ({ reason: g.reason, detail: g.detail, url: safeUrl(g.url) })),
        coverage: row.result.coverage.map((c) => ({ source_id: c.source_id, language: c.language, status: c.status,
          total_pages: c.total_pages, reviewed_pages: c.reviewed_pages?.length ?? 0, url: safeUrl(c.url), notes: c.notes,
          saved_url: row.result.snapshots.some((s) => s.url === c.url) ? `/api/reviews/${row.id}/sources/${row.result.snapshots.find((s) => s.url === c.url).snapshot_id}` : null })),
        history: row.history, observations: (row.result.source_reviews ?? []).flatMap((s) =>
          (s.review?.observations ?? []).filter((o) => o.measure_id === row.measure_id).map((o) =>
            ({ source_id: s.source_id, position: o.position, context: o.context, explanation: o.explanation,
              evidence: o.evidence.map((c) => sourceMetadata(row, c)) }))) };
    },
    decide(id, input) {
      // Synchronous read/check/append avoids two decisions accepting the same revision in this local process.
      const row = get(id);
      if (!input || !["confirm", "correct", "request_information"].includes(input.action) ||
          !Number.isInteger(input.revision) || typeof input.notes !== "string" || !input.notes.trim() || input.notes.length > 2000 ||
          typeof input.reviewer_role !== "string" || !input.reviewer_role.trim() || input.reviewer_role.length > 100) fail(400, "Provide an action, reviewer role and reason.");
      if (input.revision !== row.revision) fail(409, "This item changed. Reload before recording a decision.");
      const result = input.action === "confirm" ? row.draft_result : input.action === "correct" ? input.result : null;
      if (input.action === "correct" && !["yes", "no", "unclear", "n_a"].includes(result)) fail(400, "Choose a valid corrected result.");
      if (["yes", "no"].includes(result) && !row.finding.evidence?.length) fail(400, "Evidence must be added to a new draft before recording yes or no.");
      const decision = { decision_id: randomUUID(), item_id: id, result_id: row.result_id,
        result_sha256: row.result_sha256, hospital_key: row.hospital_key, measure_id: row.measure_id,
        action: input.action, result, notes: input.notes.trim(), reviewer_role: input.reviewer_role.trim(),
        recorded_at: new Date().toISOString(), sequence: row.revision + 1, identity: "self_attested_local_reviewer" };
      mkdirSync(decisionDirectory, { recursive: true });
      writeFileSync(join(decisionDirectory, `${decision.decision_id}.json`), JSON.stringify(decision, null, 2), { flag: "wx" });
      return this.detail(id);
    },
    source(id, snapshotId) {
      const row = get(id);
      const source = row.result.snapshots.find((s) => s.snapshot_id === snapshotId);
      if (!source || !/^[a-f0-9]{64}$/.test(snapshotId) || !/^[a-f0-9]{64}$/.test(source.sha256) ||
          !new RegExp(`^snapshots/${source.sha256}\\.(pdf|html)$`).test(source.artifact_path)) fail(404, "Saved source not found.");
      let raw;
      try { raw = bytes(join(root, source.artifact_path), root); } catch { fail(404, "Saved source unavailable."); }
      if (digest(raw) !== source.sha256) fail(422, "Saved source failed integrity verification.");
      // Never execute saved website HTML under the application's origin.
      return { body: raw.toString("base64"), isBase64Encoded: true, headers: {
        "Content-Type": source.artifact_path.endsWith(".pdf") ? "application/pdf" : "text/plain; charset=utf-8",
        "Content-Security-Policy": "sandbox", "X-Content-Type-Options": "nosniff" } };
    },
  };
}
