import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

const root = mkdtempSync(join(tmpdir(), "SYN-full-audit-agents-"));
process.env.AUDIT_DIR = root;
process.env.T2P_REVIEW_DIRECTORY = join(root, "live");
process.env.T2P_OPENCODE_LOCAL_MODEL = "SYN-local-model";
const { reportingRoute } = await import("../audit/reporting-api.js");
const { claim, openStore } = await import("../audit/store.js");
const { runPipeline } = await import("../audit/pipeline.js");
const { publicAgentReview } = await import("../audit/pipeline-views.js");
const { hospitalPage } = await import("../hospital-page/service.js");
const { rubric } = await import("../grading/data.js");

function request(path, body) {
  return reportingRoute({ rawPath: path, requestContext: { http: { method: body ? "POST" : "GET" } },
    headers: { "x-review-request": "1" }, body: JSON.stringify(body) });
}

function collectFixtures(directory, options) {
  return JSON.parse(execFileSync(process.env.T2P_PYTHON || "python", ["backend/test/fixtures/roster-collector.py", directory], {
    encoding: "utf8", input: JSON.stringify({ ...options, scenario: "public-files" }),
  }));
}

test("Full audit publishes a coordinator finding and its original cross-site PDF from the hospital run API", async t => {
  const db = openStore();
  t.after(() => { db.close(); rmSync(root, { recursive: true, force: true }); });
  const path = "/api/pilot/v1/hospitals/739/runs";
  const config = JSON.parse(request(path).body).agent_review;
  assert.equal(config.model, "SYN-local-model");
  const body = { request_key: "SYN-full-review", mode: "full_audit", year: 2026, review_date: "2026-11-10",
    discovery_bounds: { pages: 4, documents: 3, depth: 2 }, review_config: config.config_id };
  const queued = request(path, body);
  assert.equal(queued.statusCode, 202, queued.body);
  process.env.T2P_OPENCODE_LOCAL_MODEL = "SYN-new-model";
  assert.equal(request(path, body).body, queued.body, "retry retains the original run");
  assert.equal(request(path, { ...body, request_key: "SYN-stale-confirmation" }).statusCode, 409);
  const { audit_run_id, url } = JSON.parse(queued.body);
  const job = claim(db, 600000, { id: Number(audit_run_id.slice("audit-run-".length)) });
  const criterion = rubric.measures.find(m => m.evaluator === "summary_process").measure_id;
  const calls = [];
  const documentUrl = "https://files.example/739/download/summary";
  async function invoke({ role, config: selectedConfig, packet }) {
    assert.equal(selectedConfig.model, "SYN-local-model");
    assert.equal(packet.hospital, "A.O. Fox Memorial Hospital");
    assert.equal(packet.criteria.length, 17);
    calls.push(role);
    if (role === "website") return { selections: [] };
    if (role === "documents") {
      const match = packet.passages.find(p => p.source_id === documentUrl && p.quote.includes("submit the application"));
      assert.ok(match);
      return { selections: [{ measure_id: criterion, ids: [match.id] }] };
    }
    return { findings: packet.criteria.map(({ measure_id }) => ({
      measure_id, result: measure_id === criterion ? "yes" : "unclear",
      explanation: measure_id === criterion ? "The summary gives a submission location." : "Insufficient captured evidence.",
      ids: packet.selections[measure_id] ?? [],
    })) };
  }
  const bundle = await runPipeline(db, job, collectFixtures, invoke);
  assert.deepEqual(calls, ["website", "documents", "coordinator"]);
  const revision = request(url + "/revision/" + bundle.id);
  assert.equal(revision.statusCode, 200, revision.body);
  const review = JSON.parse(revision.body).agent_review;
  assert.equal(review.status, "completed");
  assert.equal(review.findings.length, 17);
  const finding = review.findings.find(f => f.measure_id === criterion);
  assert.equal(finding.result, "yes");
  const [citation] = finding.evidence;
  assert.equal(citation.source_id, documentUrl);
  assert.match(citation.quote, /submit the application/);
  assert.match(citation.locator, /1/);
  const download = request(citation.download);
  assert.equal(download.statusCode, 200);
  const bytes = Buffer.from(download.body, "base64");
  assert.equal(createHash("sha256").update(bytes).digest("hex"), citation.sha256);
  assert.equal(bytes.subarray(0, 5).toString(), "%PDF-");
  const page = hospitalPage("739");
  assert.deepEqual(page.measures.find(m => m.measure_id === criterion).agent_finding, finding);
  assert.equal(page.current_grade, null);
});

test("a published identity nomination keeps its proposed role and revision-bound citations", () => {
  const source = { source_id: "https://files.example/document.pdf?private=SYN", sha256: "b".repeat(64),
    locator: "page 1", quote: "SYN hospital and policy title." };
  const bundle = { id: "a".repeat(64), agent_review: { status: "completed", agents: {}, omitted_passages: 0,
    findings: [{ measure_id: "SYN-measure", result: "yes", explanation: "SYN explanation", evidence: [source],
      identity_basis: [{ source_id: source.source_id, proposed_role: "policy_summary", evidence: [source] }] }] } };
  const [finding] = publicAgentReview(bundle, 7).findings;
  const [basis] = finding.identity_basis;
  assert.equal(basis.proposed_role, "policy_summary");
  assert.equal(basis.source_id, "https://files.example/document.pdf");
  assert.deepEqual(basis.evidence, finding.evidence);
  assert.equal(basis.evidence[0].download, finding.revision_url + "/snapshots/" + source.sha256);
});
