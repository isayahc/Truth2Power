import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import test, { after } from "node:test";
import { facilityFor, roster, sourceInventory } from "../audit/roster-inventory.js";
import { grade } from "../grading/grade.js";

const root = mkdtempSync(join(tmpdir(), "SYN-roster-audit-"));
process.env.AUDIT_DIR = root;
process.env.T2P_REVIEW_DIRECTORY = join(root, "live");
const { openStore, claim } = await import("../audit/store.js");
const { runPipeline } = await import("../audit/pipeline.js");
const { enqueuePipeline, publications } = await import("../audit/pipeline-store.js");
const { pipelineRoute } = await import("../audit/pipeline-routes.js");
const { hospitalPage } = await import("../hospital-page/service.js");
const { createReviewService } = await import("../review/service.js");
const db = openStore();
after(() => { db.close(); rmSync(root, { recursive: true, force: true }); });

function route(path, options) {
  return pipelineRoute({ rawPath: "/api/pilot/" + path, requestContext: { http: { method: options ? "POST" : "GET" } },
    headers: { "x-review-request": "1" }, body: JSON.stringify(options) });
}
function offlineCollection(root, request) {
  const result = spawnSync(process.env.T2P_PYTHON || "python", ["backend/test/fixtures/roster-collector.py", root],
    { encoding: "utf8", input: JSON.stringify(request) });
  assert.equal(result.status, 0, result.stderr);
  return JSON.parse(result.stdout);
}
const options = (mode, request_key) => ({ mode, request_key, year: 2026, review_date: "2026-11-09",
  discovery_bounds: { pages: 4, documents: 3, depth: 2 } });

test("all 212 roster keys queue bounded scans and arbitrary PFI/URL/limits cannot enter the worker", () => {
  for (const h of roster) {
    const job = options("discovery_only", "SYN-validate-" + h.id);
    assert.equal(route("hospitals/" + h.id, job).statusCode, 202);
    assert.equal(facilityFor(h.id).pfi, h.properties.pfi);
  }
  const job = options("full_audit", "SYN-invalid");
  assert.equal(route("hospitals/99999999", job).statusCode, 400);
  assert.equal(route("hospitals/739", { ...job, landing_url: "https://example.invalid" }).statusCode, 400);
  assert.equal(route("hospitals/739", { ...job, discovery_bounds: { pages: 101 } }).statusCode, 400);
});

test("a failed-resource scan and full audit work for the roster facility without a PFI", async () => {
  const key = "t2p-0001", path = "hospitals/" + key;
  const job = options("discovery_only", "SYN-local-scan");
  const { id } = JSON.parse(route(path, job).body);
  assert.equal(JSON.parse(route(path, job).body).id, id);
  const scan = await runPipeline(db, claim(db, 600000, { id }), offlineCollection);
  assert.equal(scan.inventory.pfi, null);
  assert.equal(scan.inventory.schema_version, "hospital-source-inventory-v1");
  assert.match(scan.inventory.gaps.join(" "), /Scripts not executed/);
  assert.match(scan.inventory.gaps.join(" "), /outside the roster/);
  assert.match(scan.inventory.gaps.join(" "), /404/);
  assert.equal(scan.inventory.sources.find((s) => s.source_id.endsWith("/missing.pdf")).capture_status, "failed");
  assert.equal(scan.report, undefined);
  assert.equal(JSON.parse(route(path).body).latest, null);
  assert.deepEqual(JSON.parse(route("scans/" + scan.id).body), scan);

  const { id: full } = JSON.parse(route(path, options("full_audit", "SYN-local-full")).body);
  const b = await runPipeline(db, claim(db, 600000, { id: full }), offlineCollection);
  assert.equal(new Set(b.report.findings.map((f) => f.measure_id)).size, 17);
  assert.ok(b.report.findings.every((f) => f.result === "unclear"));
  assert.equal(b.report.final_grade, null);
  const next = enqueuePipeline(db, { ...options("discovery_only", "SYN-later-scan"), hospital_key: key });
  await runPipeline(db, claim(db, 600000, { id: next }), offlineCollection);
  assert.equal(JSON.parse(route(path).body).latest, b.id);
  assert.equal(publications().events.length, 0);
});

test("reviewing exact campus and role citations resolves only the supported posting on offline replay", async () => {
  const key = "739";
  const queue = (mode, request, classifications) => claim(db, 600000, { id: enqueuePipeline(db, {
    ...options(mode, request), hospital_key: key, classifications }) });
  const scan = await runPipeline(db, queue("discovery_only", "SYN-shared-host"), offlineCollection);
  const captured = scan.inventory.sources.find((s) => s.source_id.endsWith("/unknown.docx"));
  assert.equal(captured.role, "unclassified");
  assert.equal(captured.language, "und");
  const other = scan.inventory.sources.find((s) => s.source_id.endsWith("/application.docx"));
  assert.equal(other.role, "unclassified");
  assert.equal(other.campus_applicability, "other_campus_requires_review");
  const run = (request, classifications) => runPipeline(db, queue("replay", request, classifications),
    () => { throw Error("Replay attempted network collection"); });
  const before = await run("SYN-before-classifying");
  assert.equal(before.report.unresolved_measures.length, 17);
  const locator = "DOCX body (paragraphs and tables; pagination unverified)";
  const doc = { source_id: captured.source_id, sha256: captured.digest, role: "policy_summary", language: "en",
    locator, quote: "financial assistance policy summary", applicability: { locator, quote: "Applies to A.O. Fox Memorial Hospital." } };
  const record = (documents) => Buffer.from(JSON.stringify({ schema_version: "hospital-classifications-v1", hospital_key: key,
    reviewed_at: "2026-11-09T19:00:00Z", reviewer_role: "SYN operator", documents }));
  const b = await run("SYN-after-classifying", record([doc, { ...doc, source_id: other.source_id, sha256: other.digest }]));
  const source = b.input.sources.find((s) => s.source_id === doc.source_id);
  assert.equal(source.role, doc.role);
  assert.deepEqual(source.snapshot, before.input.sources.find((s) => s.source_id === doc.source_id).snapshot);
  assert.equal(b.report.unresolved_measures.length, 16);
  const posting = b.report.findings.find((f) => f.css_column === "S");
  assert.equal(posting.result, "yes");
  assert.equal(posting.evidence.filter((e) => e.locator.startsWith("link ")).length, 2);
  assert.equal(posting.human_review, "pending");
  assert.equal(hospitalPage(key).revision, b.id);
  const items = createReviewService(b.root).list({ hospital_key: key }).items;
  assert.equal(items.length, 17);
  assert.ok(items.every((item) => item.status === "pending"));
  assert.equal(b.report.final_grade, null);
  assert.deepEqual(grade(b.input, { root: b.root }), b.report);
  assert.equal(publications().events.length, 0, "Classifying unchanged bytes cannot create a material change");
  assert.throws(() => sourceInventory(facilityFor(key), { ...scan.discovery, landing_url: "https://other.invalid" }), /roster landing/);
  await assert.rejects(run("SYN-wrong-quote", record([{ ...doc, applicability: { locator, quote: "Another facility" } }])), /citation/);
  assert.equal(JSON.parse(route("hospitals/" + key).body).latest, b.id);
});
