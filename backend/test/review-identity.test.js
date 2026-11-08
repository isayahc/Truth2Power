import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, writeFileSync, rmSync } from "node:fs";
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
