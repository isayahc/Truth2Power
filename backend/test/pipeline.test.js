// Fabricated publication fixtures only; all writes are confined to a disposable store.
import test, { after } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const root = mkdtempSync(join(tmpdir(), "SYN-pipeline-"));
process.env.AUDIT_DIR = root;
process.env.T2P_REVIEW_DIRECTORY = join(root, "live");
process.env.T2P_PILOT_DEMO = "1";
const { openStore, claim } = await import("../audit/store.js");
const { enqueuePipeline, publications } = await import("../audit/pipeline-store.js");
const { runPipeline } = await import("../audit/pipeline.js");
const { hospitalPage, pageInputs } = await import("../hospital-page/service.js");
const { overview } = await import("../overview/service.js");
const { grade } = await import("../grading/grade.js");
const { createReviewService } = await import("../review/service.js");
const { pipelineRoute } = await import("../audit/pipeline-routes.js");
const db = openStore();
const base = { hospital_key: "1002", year: 2026, review_date: "2026-11-09", mode: "synthetic" };
const queue = (key, options = {}) => enqueuePipeline(db, { ...base, request_key: key, ...options });
const run = async (key, options) => { queue(key, options); const job = claim(db); assert.ok(job); return runPipeline(db, job); };
let original, corrected;
after(() => { db.close(); rmSync(root, { recursive: true, force: true }); });

test("offline 17-measure audit publishes one revision to pages, grading, overview and review inbox", async () => {
  original = await run("SYN-first");
  assert.equal(original.report.findings.length, 17);
  assert.equal(original.report.calculated_grade, "B");
  assert.equal(original.report.final_grade, null);
  assert.equal(original.report.human_review_status, "pending");
  const page = hospitalPage("1002");
  assert.equal(page.revision, original.id);
  assert.equal(page.measures.length, 17);
  assert.equal(page.synthetic, true);
  const row = overview().hospitals.find((r) => r.hospital_key === "1002");
  assert.equal(row.revision, page.revision);
  assert.equal(row.last_successful_assessment_at, original.report.last_successful_assessment_at);
  const inbox = createReviewService(process.env.T2P_REVIEW_DIRECTORY);
  assert.equal(inbox.list().items.length, 17);
  assert.ok(inbox.list().items.every((i) => i.status === "pending" && i.namespace === "pipeline"));
  assert.deepEqual(grade(original.input, { root: process.env.T2P_REVIEW_DIRECTORY }), original.report);
});

test("idempotency key rejects context changes and unchanged refresh advances clock without material events", async () => {
  const id = queue("SYN-first");
  assert.equal(id, 1);
  assert.throws(() => queue("SYN-first", { variant: "corrected" }), /different context/);
  const unchanged = await run("SYN-unchanged");
  assert.notEqual(unchanged.id, original.id);
  assert.equal(unchanged.content_fingerprint, original.content_fingerprint);
  assert.equal(publications().events.length, 0);
  assert.equal(publications().bundles.length, 2);
});

test("corrected source produces exactly one event and preserves immutable historical evidence", async () => {
  corrected = await run("SYN-corrected", { variant: "corrected" });
  assert.equal(corrected.report.calculated_grade, "A");
  assert.equal(publications().events.length, 1);
  const event = publications().events[0];
  assert.equal(event.revision, corrected.id);
  assert.notEqual(event.before.sha256, event.after.sha256);
  const snapshot = pipelineRoute({ rawPath: `/api/pilot/snapshots/${event.before.sha256}`, requestContext: { http: { method: "GET" } } });
  assert.equal(snapshot.statusCode, 200);
  assert.match(Buffer.from(snapshot.body, "base64").toString(), /62600/);
  await run("SYN-corrected-again", { variant: "corrected" });
  assert.equal(publications().events.length, 1);
});

test("reference-year reevaluation uses identical source bytes and keeps historical assessments separate", async () => {
  const historic = await run("SYN-2025", { year: 2025, review_date: "2025-11-09" });
  assert.equal(historic.report.calculated_grade, "A");
  const source = (b) => b.input.sources.find((s) => s.role === "application").snapshot.sha256;
  assert.equal(source(historic), source(original));
  assert.equal(hospitalPage("1002").guideline_year, 2026);
  assert.notEqual(hospitalPage("1002").revision, historic.id);
});

test("expired lease is reclaimed, stale completion is fenced and duplicate execution cannot republish", async () => {
  const id = queue("SYN-interrupted");
  const abandoned = claim(db, 0), retry = claim(db);
  assert.equal(abandoned.id, id); assert.equal(retry.id, id);
  assert.notEqual(abandoned.token, retry.token);
  assert.equal(await runPipeline(db, abandoned), null);
  const result = await runPipeline(db, retry);
  assert.ok(result);
  assert.equal(await runPipeline(db, retry), null);
  assert.equal(db.prepare("SELECT count(*) n FROM assessments WHERE job=?").get(id).n, 1);
  assert.equal(db.prepare("SELECT status FROM attempts WHERE token=?").get(abandoned.token).status, "interrupted");
});

test("multilingual source replacement retains old decisions and creates independent review subjects", async () => {
  const inbox = createReviewService(process.env.T2P_REVIEW_DIRECTORY);
  const item = inbox.list().items.find((i) => i.guideline_year === 2026);
  const old = inbox.decide(item.id, { action: "request_information", revision: 0, reviewer_role: "SYN test reviewer", notes: "SYN needs more evidence" });
  const multi = await run("SYN-multilingual", { variant: "multilingual" });
  assert.ok(multi.report.unresolved_measures.length > 0);
  assert.equal(multi.report.final_grade, null);
  assert.equal(inbox.detail(old.id).history.length, 1);
  assert.throws(() => inbox.decide(old.id, { action: "confirm", revision: 1, reviewer_role: "SYN", notes: "SYN" }), /no longer current/);
  const current = inbox.list().items.filter((i) => i.guideline_year === 2026);
  assert.equal(current.length, 17);
  assert.ok(current.every((i) => i.revision === 0));
});

test("corrupted evidence fails and retries finitely without changing success clocks, revisions or events", async () => {
  const before = hospitalPage("1002"), events = publications().events.length;
  const s = original.input.sources.find((s) => s.role === "application").snapshot;
  const path = join(process.env.T2P_REVIEW_DIRECTORY, s.artifact_path), bytes = readFileSync(path);
  writeFileSync(path, "SYN corrupted bytes");
  try {
    const id = queue("SYN-corrupt");
    for (let i = 0; i < 3; i++) {
      db.prepare("UPDATE jobs SET available_at=0 WHERE id=?").run(id);
      await assert.rejects(runPipeline(db, claim(db)), /collision|checksum/);
    }
    assert.equal(db.prepare("SELECT status FROM jobs WHERE id=?").get(id).status, "failed");
    const after = hospitalPage("1002");
    assert.equal(after.revision, before.revision);
    assert.equal(after.latest_successful_assessment_at, before.latest_successful_assessment_at);
    assert.ok(after.measures.every((m) => m.versions[0].failures.length === 1));
    assert.equal(publications().events.length, events);
    assert.equal(pipelineRoute({ rawPath: `/api/pilot/snapshots/${s.sha256}`, requestContext: { http: { method: "GET" } } }).statusCode, 422);
  } finally { writeFileSync(path, bytes); }
});

test("synthetic publications are excluded from normal public views and stale clocks age independently", () => {
  assert.equal(publications(undefined, { includeSynthetic: false }).bundles.length, 0);
  const inputs = pageInputs();
  const aged = overview({ inputs, asOf: new Date("2027-01-01T00:00:00Z") });
  assert.equal(aged.hospitals.length, 212);
  assert.equal(aged.hospitals.find((r) => r.hospital_key === "1002").freshness, "overdue");
  assert.ok(aged.statewide.freshness.never >= 210);
});

test("real-evidence replay on a clean checkout produces explicit blockers, never invented sources or approvals", async () => {
  const partial = await run("SYN-empty-evidence-replay", { mode: "replay", hospital_key: "362", evidence_root: join(root, "no-captures") });
  assert.equal(partial.input.synthetic, false);
  assert.equal(partial.report.findings.length, 17);
  assert.equal(partial.report.unresolved_measures.length, 17);
  assert.equal(partial.report.final_grade, null);
  assert.ok(partial.report.coverage_gaps.some((g) => g.includes("Obtain original snapshot")));
  assert.ok(partial.input.sources.every((s) => s.snapshot === null));
});

test("out-of-order completion cannot supersede a newer job in pages, review inbox or events", async () => {
  queue("SYN-slow-old"); const older = claim(db);
  queue("SYN-fast-new", { variant: "corrected" }); const newer = claim(db);
  const current = await runPipeline(db, newer), events = publications().events.length;
  const historic = await runPipeline(db, older);
  assert.ok(historic);
  assert.equal(hospitalPage("1002").revision, current.id);
  assert.equal(publications().events.length, events);
  const items = createReviewService(process.env.T2P_REVIEW_DIRECTORY).list({ hospital_key: "1002" }).items.filter((i) => i.guideline_year === 2026);
  assert.ok(items.every((i) => i.result_id === current.id.slice(32)));
});
