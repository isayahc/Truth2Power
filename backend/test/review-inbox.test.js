import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createReviewService } from "../review/service.js";
import { reviewFixture, applicationFixture } from "./review-fixture.js";

function setup(t) {
  const root = mkdtempSync(join(tmpdir(), "t2p-review-test-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const fixture = reviewFixture(root);
  const service = createReviewService(root, [{ id: "1002", properties: { name: "SYN Hospital" } }]);
  return { root, fixture, service, id: service.list().items[0].id };
}
const decision = { action: "correct", result: "yes", notes: "SYN: reviewed the cited wording.", reviewer_role: "Synthetic test reviewer", revision: 0 };

test("hospital context, source links and exact draft remain after a decision", (t) => {
  const { fixture, service, id } = setup(t);
  const before = readFileSync(fixture.path);
  assert.equal(service.detail(id).hospital_name, "SYN Hospital");
  assert.match(service.detail(id).evidence[0].saved_url, /\/sources\//);
  const reviewed = service.decide(id, decision);
  assert.equal(reviewed.draft_result, "unclear");
  assert.equal(reviewed.reviewed_result, "yes");
  assert.equal(service.list().pending, 0);
  assert.deepEqual(readFileSync(fixture.path), before);
  assert.equal(reviewed.history[0].result_sha256, reviewed.result_sha256);
});

test("requesting information stays open; confirming unclear does not turn it into yes", (t) => {
  const { service, id } = setup(t);
  assert.equal(service.decide(id, { ...decision, action: "request_information" }).status, "needs_information");
  assert.equal(service.list().pending, 1);
  const reviewed = service.decide(id, { ...decision, revision: 1, action: "confirm" });
  assert.equal(reviewed.reviewed_result, "unclear");
  assert.equal(reviewed.history.length, 2);
  assert.throws(() => service.decide(id, decision), (e) => e.status === 409);
});

test("new draft does not inherit approval and superseded items cannot be changed", (t) => {
  const { service, root, id } = setup(t);
  service.decide(id, decision);
  reviewFixture(root, "c".repeat(32), "2026-11-09T12:00:00Z");
  const current = service.list();
  assert.equal(current.items.length, 1);
  assert.equal(current.pending, 1);
  assert.equal(current.items[0].revision, 0);
  assert.throws(() => service.decide(id, { ...decision, revision: 1 }), (e) => e.status === 404);
});

test("saved sources are hash verified and HTML is inert; arbitrary paths rejected", (t) => {
  const { service, root, fixture, id } = setup(t);
  const source = service.source(id, fixture.hash);
  assert.equal(source.headers["Content-Type"], "text/plain; charset=utf-8");
  assert.equal(Buffer.from(source.body, "base64").toString(), fixture.raw);
  assert.throws(() => service.source(id, "../state.json"), (e) => e.status === 404);
  writeFileSync(join(root, "snapshots", `${fixture.hash}.html`), "SYN tampered");
  assert.throws(() => service.source(id, fixture.hash), (e) => e.status === 422);
});

test("invalid or unsupported decisions cannot resolve an item", (t) => {
  const { service, id } = setup(t);
  for (const invalid of [{ notes: " " }, { reviewer_role: "" }, { result: "pass" }, { action: "dismiss" }, { notes: "x".repeat(2001) }]) {
    assert.throws(() => service.decide(id, { ...decision, ...invalid }), (e) => e.status === 400);
  }
  assert.equal(service.list().pending, 1);
});

test("DOCX saved sources download with integrity verification", (t) => {
  const { service, root, fixture } = setup(t);
  fixture.result.snapshots[0].artifact_path = `snapshots/${fixture.hash}.docx`;
  writeFileSync(join(root, fixture.result.snapshots[0].artifact_path), fixture.raw);
  writeFileSync(fixture.path, JSON.stringify(fixture.result));
  const id = service.list().items[0].id;
  const source = service.source(id, fixture.hash);
  assert.equal(source.headers["Content-Type"], "application/vnd.openxmlformats-officedocument.wordprocessingml.document");
  assert.match(source.headers["Content-Disposition"], /^attachment;/);
  writeFileSync(join(root, fixture.result.snapshots[0].artifact_path), "SYN tampered DOCX");
  assert.throws(() => service.source(id, fixture.hash), (e) => e.status === 422);
});

test("service-area question is visible but cannot be promoted without evidence", (t) => {
  const { service, fixture } = setup(t);
  fixture.result.psa = { result: "unclear", unresolved_question: "SYN: Which approved boundary rule applies?",
    authority: "https://example.org/synthetic-rule", note: "SYN: rule approval pending." };
  writeFileSync(fixture.path, JSON.stringify(fixture.result));
  const row = service.list().items.find((i) => i.title === "Service-area rule");
  assert.ok(row);
  assert.equal(service.detail(row.id).authority_url, "https://example.org/synthetic-rule");
  assert.throws(() => service.decide(row.id, decision), (e) => e.status === 400);
  assert.equal(service.decide(row.id, { ...decision, action: "request_information" }).status, "needs_information");
});

test("unreadable draft is reported as a coverage warning, not silently complete", (t) => {
  const { service, root } = setup(t);
  writeFileSync(join(root, "full-reviews", "b".repeat(32), "results", "d".repeat(32) + ".json"), "broken json");
  assert.equal(service.list().unavailable, 1);
  assert.equal(service.list().pending, 1);
});

test("application checks coexist with posted-material findings and retain their scope", (t) => {
  const { service, root, id } = setup(t);
  applicationFixture(root);
  assert.equal(service.list().pending, 7);
  const item = service.list().items.find((r) => r.measure_id === "application.fpl_guidelines");
  const detail = service.detail(item.id);
  assert.equal(detail.draft_result, "no");
  assert.equal(detail.guideline_year, 2026);
  assert.equal(detail.observed.cells[0].expected, 63840);
  assert.match(detail.scope_label, /Selected application/);
  assert.equal(detail.other_application_versions_not_assessed.length, 1);
  service.decide(item.id, { ...decision, action: "confirm" });
  applicationFixture(root, "d".repeat(32), "2026-11-09T13:00:00Z");
  assert.equal(service.list().pending, 7);
  assert.equal(service.detail(id).draft_result, "unclear");
});
