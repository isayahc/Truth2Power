import assert from "node:assert/strict";
import test from "node:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

test("reclaim an interrupted job, fence the old worker and retain the last success on failure", async () => {
  process.env.AUDIT_DIR = mkdtempSync(join(tmpdir(), "audit-test-"));
  const { openStore, claim, enqueue, finish, history } =
    await import("../audit/store.js");
  const db = openStore();
  try {
    const id = enqueue(db, 2025);
    assert.equal(enqueue(db, 2025), id);
    const old = claim(db, -1),
      resumed = claim(db);
    assert.equal(old.id, resumed.id);
    assert.equal(finish(db, old, null, "stale owner"), false);
    const envelope = {
      assessment: {
        assessment_id: "example",
        completed_at: "2026-11-06T15:00:00Z",
        findings: [],
      },
    };
    assert.ok(finish(db, resumed, envelope));
    assert.equal(finish(db, resumed, envelope), false);
    enqueue(db, 2026);
    const failed = claim(db);
    assert.equal(failed.context.previous_assessment, "example");
    finish(db, failed, null, "timeout");
    assert.deepEqual(history(db, "362"), envelope);
    assert.equal(db.prepare("SELECT count(*) n FROM assessments").get().n, 1);
  } finally {
    db.close();
    rmSync(process.env.AUDIT_DIR, { recursive: true, force: true });
  }
});
