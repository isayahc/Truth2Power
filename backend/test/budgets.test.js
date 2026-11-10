import assert from "node:assert/strict";
import test from "node:test";
import { execFileSync } from "node:child_process";
import {
  mkdtempSync,
  rmSync,
  writeFileSync,
  existsSync,
  readFileSync,
} from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { openStore, claim } from "../audit/store.js";
import {
  enqueuePipeline,
  cancelRun,
  failPipeline,
} from "../audit/pipeline-store.js";
import { reservePaid } from "../audit/budgets.js";
import { runPipeline } from "../audit/pipeline.js";
import { costReceipt, providerEvent } from "../audit/usage-ledger.js";

test("hard stops retain the collector manifest, never publish a grade, and do not retry", async (t) => {
  const root = mkdtempSync(join(tmpdir(), "SYN-quota-")),
    db = openStore(root);
  t.after(() => {
    db.close();
    rmSync(root, { recursive: true, force: true });
  });
  const queue = (key, budget) =>
    enqueuePipeline(db, {
      root,
      hospital_key: "739",
      mode: "full_audit",
      review_date: "2026-11-09",
      request_key: key,
      budget,
    });
  assert.throws(() => queue("wide", { pages: 101 }), /Invalid audit budget/);
  const id = queue("first", { pages: 0 });
  assert.equal(queue("first", { pages: 0 }), id);
  await assert.rejects(runPipeline(db, claim(db)), /quota_exceeded \(pages\)/);
  const stop = costReceipt(db, id).budget_stop;
  assert.deepEqual({ ...stop }, { code: "quota_exceeded", unit: "pages" });
  const detail = JSON.parse(
    db
      .prepare(
        "SELECT detail FROM audit_run_events WHERE job=? AND json_extract(detail,'$.name')='collection_stopped'",
      )
      .get(id).detail,
  );
  assert.equal(
    JSON.parse(readFileSync(join(root, "collections", "739", detail.manifest)))
      .budget_stop,
    "pages",
  );
  assert.equal(claim(db), null);
  queue("timeout", { seconds: 0 });
  await assert.rejects(
    runPipeline(db, claim(db)),
    /budget_exhausted \(seconds\)/,
  );
  assert.equal(db.prepare("SELECT count(*) n FROM assessments").get().n, 0);
});

test("paid reservation uses pinned prices and does not reset on retry or duplicate callbacks", (t) => {
  const root = mkdtempSync(join(tmpdir(), "SYN-paid-")),
    db = openStore(root);
  const previous = [process.env.T2P_BUDGET_FILE, process.env.T2P_RATE_CARD];
  t.after(() => {
    for (const [i, k] of ["T2P_BUDGET_FILE", "T2P_RATE_CARD"].entries()) {
      if (previous[i] === undefined) delete process.env[k];
      else process.env[k] = previous[i];
    }
    db.close();
    rmSync(root, { recursive: true, force: true });
  });
  process.env.T2P_BUDGET_FILE = join(root, "policy.json");
  process.env.T2P_RATE_CARD = join(root, "rates.json");
  writeFileSync(
    process.env.T2P_BUDGET_FILE,
    JSON.stringify({ paid_requests: 4, paid_tokens: 20, paid_usd_micros: 10 }),
  );
  writeFileSync(
    process.env.T2P_RATE_CARD,
    JSON.stringify({
      version: "SYN",
      currency: "USD",
      effective_date: "2026-01-01",
      local: {},
      models: { "bedrock/test/model": { output_tokens: 0.000001 } },
    }),
  );
  const queue = (key, allow_paid) =>
    enqueuePipeline(db, {
      root,
      request_key: key,
      mode: "replay",
      hospital_key: "739",
      review_date: "2026-11-09",
      allow_paid,
    });
  const tokens = { input_tokens: 0, cached_input_tokens: 0, output_tokens: 5 };
  const id = queue("off", false),
    off = claim(db);
  assert.throws(
    () => reservePaid(db, off, "a", "bedrock/test/model", tokens),
    /quota_exceeded/,
  );
  cancelRun(db, id, root);
  const ratePath = process.env.T2P_RATE_CARD;
  delete process.env.T2P_RATE_CARD;
  assert.throws(() => queue("missing-rates",true),/unknown_price/);
  process.env.T2P_RATE_CARD = ratePath;
  queue("on", true);
  const a = claim(db);
  assert.throws(
    () => reservePaid(db, a, "a", "missing/model", tokens),
    /unknown_price/,
  );
  assert.equal(reservePaid(db, a, "a", "bedrock/test/model", tokens), true);
  failPipeline(db, a);
  db.prepare("UPDATE jobs SET available_at=0 WHERE id=?").run(a.id);
  const b = claim(db);
  assert.equal(reservePaid(db, b, "a", "bedrock/test/model", tokens), false);
  assert.equal(reservePaid(db, b, "b", "bedrock/test/model", tokens), true);
  assert.throws(
    () => reservePaid(db, b, "c", "bedrock/test/model", tokens),
    /budget_exhausted/,
  );
  providerEvent(db, {
    job: b.id,
    attempt: b.token,
    stage: "model",
    provider: "bedrock",
    region: "test",
    model: "model",
    usage_id: "b",
    bill: { amount: 0.02, currency: "USD" },
  });
  assert.throws(
    () =>
      reservePaid(db, b, "more", "bedrock/test/model", {
        ...tokens,
        output_tokens: 0,
      }),
    /budget_exhausted/,
  );
  cancelRun(db, b.id, root);
  assert.throws(
    () => reservePaid(db, b, "d", "bedrock/test/model", tokens),
    /Inactive/,
  );
});

test("monthly preview covers all 212 without creating a store", (t) => {
  const root = mkdtempSync(join(tmpdir(), "SYN-preview-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const plan = JSON.parse(
    execFileSync(
      process.execPath,
      [
        "backend/audit/pipeline-cli.js",
        "schedule-preview",
        "--max-facilities",
        "2",
      ],
      { env: { ...process.env, AUDIT_DIR: root } },
    ),
  );
  assert.equal(plan.due.length, 212);
  assert.equal(plan.selected.length, 2);
  assert.equal(plan.per_run.local_cost_usd, null);
  assert.equal(existsSync(join(root, "audit.sqlite")), false);
});
