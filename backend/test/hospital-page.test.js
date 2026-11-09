import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync, mkdirSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { hospitalPage } from "../hospital-page/service.js";
import { localRecords, projectRecord } from "../hospital-page/records.js";
import { handler } from "../src/handler.js";

const id = "application.fpl_guidelines";
const record = (overrides = {}) => ({ hospital_key: "362", record_id: "SYN-first", kind: "application-reviews", scope: "SYN-English", scope_label: "SYN English form",
  guideline_year: 2026, checked_at: "2026-11-08T10:00:00Z", status: "completed", findings: [{ measure_id: id, result: "no", explanation: "SYN outdated amounts", evidence: [] }], ...overrides });

test("both hospital pages ship 17 scoped measures, dated evidence and separate publisher dates offline", () => {
  for (const key of ["1002", "362"]) {
    const page = hospitalPage(key, { root: "does-not-exist-SYN" });
    assert.equal(page.measures.length, 17);
    assert.equal(new Set(page.measures.map((m) => m.measure_id)).size, 17);
    assert.equal(page.current_grade, null);
    assert.equal(page.publisher_updated_at, null);
    assert.ok(page.latest_successful_assessment_at);
    for (const m of page.measures) {
      assert.ok(m.reason && m.law.plain_language && m.question);
      for (const v of m.versions) for (const e of v.finding?.evidence || []) {
        assert.ok(e.url.startsWith("https://") && e.retrieved_at && e.locator && e.quote && /^[a-f0-9]{64}$/.test(e.sha256));
      }
    }
  }
  assert.equal(hospitalPage("99999"), null);
});

test("new failure retains successful finding, isolates year/hospital/language and clears after a later success", () => {
  const first = record();
  const failure = record({ record_id: "SYN-failed", status: "failed", checked_at: "2026-11-09T10:00:00Z", findings: [], affected_measures: [id], error: "SYN retrieval failed" });
  const other = record({ record_id: "SYN-other", hospital_key: "1002", checked_at: "2026-11-10T10:00:00Z" });
  const historic = record({ record_id: "SYN-2025", guideline_year: 2025 });
  const spanish = record({ record_id: "SYN-es", scope: "SYN-Spanish", findings: [{ measure_id: id, result: "unclear", explanation: "SYN translation needed", evidence: [] }] });
  const records = [first, failure, other, historic, spanish];
  const get = () => hospitalPage("362", { records }).measures.find((m) => m.measure_id === id);
  assert.equal(get().result, "unclear");
  assert.equal(get().versions.length, 2);
  const en = get().versions.find((v) => v.scope === first.scope);
  assert.equal(en.finding.result, "no");
  assert.equal(en.assessed_at, first.checked_at);
  assert.equal(en.failures.length, 1);
  assert.equal(get().versions.find((v) => v.scope === spanish.scope).failures.length, 0);
  records.push(record({ record_id: "SYN-new", checked_at: "2026-11-10T10:00:00Z", findings: [{ measure_id: id, result: "unclear", explanation: "SYN new unresolved finding", evidence: [] }] }));
  const refreshed = get().versions.find((v) => v.scope === first.scope);
  assert.equal(refreshed.finding.result, "unclear");
  assert.equal(refreshed.failures.length, 0);
});

test("failed first attempt is visible without inventing success or a failed compliance result", () => {
  const r = record({ status: "failed", findings: [], affected_measures: [id] });
  const page = hospitalPage("362", { records: [r] });
  const m = page.measures.find((m) => m.measure_id === id);
  assert.equal(m.result, "unclear");
  assert.equal(m.versions[0].assessed_at, null);
  assert.equal(m.versions[0].failures.length, 1);
  assert.equal(page.failed_measures.length, 0);
});

test("full posted-material review supersedes older excerpt findings without replacing unrelated measures", () => {
  const m = "posted_materials.no_submission_time_limit";
  const earlier = record({ kind: "cross-document-reviews", findings: [{ measure_id: m, result: "unclear", evidence: [], explanation: "SYN excerpt" }] });
  const later = record({ kind: "full-reviews", record_id: "SYN-full", checked_at: "2026-11-09T10:00:00Z", findings: [{ measure_id: m, result: "yes", explanation: "SYN full review", evidence: [] }] });
  const row = hospitalPage("362", { records: [earlier, later] }).measures.find((f) => f.measure_id === m);
  assert.equal(row.versions.length, 1);
  assert.equal(row.result, "yes");
});

test("unreadable local records retain baseline and recheck files remain read-only", () => {
  const root = mkdtempSync(join(tmpdir(), "SYN-page-"));
  try {
    mkdirSync(join(root, "page-rechecks"));
    writeFileSync(join(root, "page-rechecks", "broken.json"), "{");
    const page = hospitalPage("362", { root });
    assert.equal(page.unavailable_records, 1);
    assert.ok(page.measures.some((m) => m.versions.length));
    assert.equal(localRecords(root).records.length, 0);
    const version = page.measures.find((m) => m.measure_id === id).versions[0];
    writeFileSync(join(root, "page-rechecks", "SYN-recheck.json"), JSON.stringify({
      hospital_key: "362", status: "failed", kind: "application-reviews", scope: version.scope,
      guideline_year: 2026, checked_at: "2026-11-10T10:00:00Z", affected_measures: [id],
    }));
    const retained = hospitalPage("362", { root }).measures.find((m) => m.measure_id === id).versions.find((v) => v.scope === version.scope);
    assert.equal(retained.record_id, version.record_id);
    assert.equal(retained.failures.length, 1);
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test("projection rejects malformed citations and synthetic demo findings", () => {
  assert.equal(projectRecord(JSON.stringify({ synthetic: true }), "SYN.json", "posting"), null);
  const original = { hospital_key: "362", checked_at: "2026-11-08T10:00:00Z", snapshots: [], findings: [{ measure_id: id, result: "yes", evidence: [{ snapshot_id: "unknown" }] }] };
  assert.throws(() => projectRecord(JSON.stringify(original), "SYN.json", "full-reviews"), /citation/);
});

test("hospital page route is read-only and unknown hospitals are explicit", async () => {
  const req = (key, method = "GET") => handler({ rawPath: `/api/hospitals/${key}/page`, requestContext: { http: { method } } });
  assert.equal((await req("1002")).statusCode, 200);
  assert.equal((await req("362", "POST")).statusCode, 405);
  assert.equal((await req("99999")).statusCode, 404);
});
