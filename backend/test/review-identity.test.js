import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, writeFileSync, rmSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { createReviewService } from "../review/service.js";
import { languageFixture } from "./review-fixture.js";

function setup(t) {
  const root = mkdtempSync(join(tmpdir(), "SYN-identity-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  return { root, service: createReviewService(root) };
}
test("five application languages coexist; Spanish revisions retain exact history and independent decisions", (t) => {
  const { root, service } = setup(t);
  ["English", "Spanish", "Polish", "Ukrainian", "Russian"].forEach((lang, n) => languageFixture(root, lang, n));
  const english = service.list({ language: "en" }).items[0];
  const old = service.list({ language: "es" }).items[0];
  const confirm = { action: "confirm", reviewer_role: "SYN tester", notes: "SYN uncertain", revision: 0 };
  service.decide(old.id, confirm);
  languageFixture(root, "Spanish", 7, { version: 2, checked: "2026-11-09T14:00:00Z" });
  assert.equal(service.list().items.length, 5);
  const current = service.list({ language: "es", role: "application" }).items[0];
  assert.equal(current.logical_review_id, old.logical_review_id);
  assert.notEqual(current.documents[0].snapshot_sha256, old.documents[0].snapshot_sha256);
  assert.equal(current.status, "pending");
  assert.equal(service.detail(old.id).history.length, 1);
  assert.equal(service.detail(old.id).is_current, false);
  assert.equal(service.detail(current.id).document_versions[1].item_id, old.id);
  assert.equal(service.detail(english.id).is_current, true);
  assert.throws(() => service.decide(old.id, confirm), (e) => e.status === 404);
});
test("source, role, hospital, scope and year separate reviews, duplicate links deduplicate", (t) => {
  const { root, service } = setup(t);
  const same = "https://example.org/a/SYN-form.html";
  languageFixture(root, "unknown", 1, { url: same });
  languageFixture(root, "unknown", 2, { url: same + "#page=2" });
  languageFixture(root, "unknown", 3, { url: same.replace("/a/", "/b/") });
  languageFixture(root, "English", 4, { url: same });
  languageFixture(root, "English", 5, { url: same, hospital: "362" });
  const replay = languageFixture(root, "English", 6, { url: same });
  replay.result.guideline_year = 2025;
  writeFileSync(replay.path, JSON.stringify(replay.result));
  assert.equal(service.list().items.length, 5);
  assert.equal(service.list({ language: "und" }).items.length, 2);
  assert.equal(service.list({ hospital_key: "362", source_id: same }).items.length, 1);
});
test("ambiguous legacy records stay individually addressable; conflicting declarations are flagged", (t) => {
  const { root, service } = setup(t);
  for (let n = 1; n <= 3; n++) {
    const fixture = languageFixture(root, "unknown", n);
    if (n < 3) { delete fixture.result.review_identity; fixture.result.coverage = []; }
    else fixture.result.review_identity.documents[0].language = "Spanish";
    writeFileSync(fixture.path, JSON.stringify(fixture.result));
    const bytes = readFileSync(fixture.path);
    service.list();
    assert.deepEqual(readFileSync(fixture.path), bytes);
  }
  assert.equal(service.list().unavailable, 1);
  assert.deepEqual(service.list().items.map((i) => i.identity_status), ["ambiguous_legacy", "ambiguous_legacy"]);
});

test("role and rubric distinguish same-language materials at the same URL in posted-material scopes", (t) => {
  const { root, service } = setup(t);
  for (const [n, role, rubric] of [[1,"policy_summary","one"],[2,"policy_statement","one"],[3,"policy_summary","two"]]) {
    const {result:r} = languageFixture(root,"English",n);
    r.rubric_version = rubric;
    r.snapshots[0].document_type = role;
    r.review_identity = {version:1, scope:"posted_materials", documents:[{url:r.snapshots[0].url,role,language:"English",snapshot_sha256:r.snapshots[0].sha256}]};
    const dir = join(root,"full-reviews",r.review_id,"results");
    mkdirSync(dir,{recursive:true});
    writeFileSync(join(dir,r.result_id+".json"),JSON.stringify(r));
  }
  assert.equal(service.list({namespace:"full-reviews"}).items.length,3);
  assert.equal(service.list({role:"policy_summary",language:"en"}).items.length,2);
});

test("a pre-rubric single-document run retains revisions without conflating unknown rubrics across runs", (t) => {
  const { root, service } = setup(t);
  for (const n of [1,2,3]) {
    const {result:r} = languageFixture(root,"English",n);
    delete r.review_identity;
    delete r.rubric_version;
    if (n === 3) r.review_id = "d".repeat(32);
    const dir = join(root,"application-reviews",r.review_id,"results");
    mkdirSync(dir,{recursive:true});
    writeFileSync(join(dir,r.result_id+".json"),JSON.stringify(r));
    if (n === 3) rmSync(join(root,"application-reviews","b".repeat(32),"results",r.result_id+".json"));
  }
  const rows = service.list().items;
  assert.equal(rows.length,2);
  assert.ok(rows.every((r) => r.identity_status === "legacy_unversioned_run"));
  assert.deepEqual(rows.map((r) => r.version_count).sort(), [1,2]);
});
