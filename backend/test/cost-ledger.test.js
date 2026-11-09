import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { openStore, claim } from "../audit/store.js";
import { enqueuePipeline, immutable, failPipeline } from "../audit/pipeline-store.js";
import { runPipeline } from "../audit/pipeline.js";
import { costReceipt, providerEvent, meterAttempt } from "../audit/usage-ledger.js";

test("receipt aggregates retries, reconciles bills and preserves pinned prices across restart", async (t) => {
  const root = mkdtempSync(join(tmpdir(), "SYN-meter-"));
  const db = openStore(root);
  const old = process.env.T2P_RATE_CARD;
  t.after(() => { db.close(); rmSync(root, { recursive: true, force: true });
    if (old === undefined) delete process.env.T2P_RATE_CARD; else process.env.T2P_RATE_CARD = old; });
  process.env.T2P_RATE_CARD = join(root, "prices.json");
  const rates = { version: "test-v1", effective_date: "2026-11-01", currency: "USD", local: {},
    models: { "bedrock/test/model": { input_tokens: 0.01, cached_input_tokens: 0.001, output_tokens: 0.1 } } };
  writeFileSync(process.env.T2P_RATE_CARD, JSON.stringify(rates));
  const queue = (key) => enqueuePipeline(db, { root, request_key: key, mode: "replay", hospital_key: "739", review_date: "2026-11-09" });
  const job = queue("SYN-retry"), first = claim(db);
  await meterAttempt(db, first, async () => {
    immutable(root, "snapshots/sample", "sample"); failPipeline(db, first);
  });
  db.prepare("UPDATE jobs SET available_at=0 WHERE id=?").run(job);
  const second = claim(db);
  await runPipeline(db, second);
  let r = costReceipt(db, job);
  assert.equal(r.zero_incremental_api, true);
  assert.equal(r.known_billed_usd, 0);
  assert.ok(r.units.elapsed_ms > 0 && r.units.artifacts_written > 0 && r.units.storage_bytes > 0);
  assert.ok(r.unknown_unpriced.length);
  assert.equal(r.attempts.length, 2);
  const args = { job, attempt: first.token, stage: "model", provider: "bedrock", region: "test", model: "model", usage_id: "SYN-usage" };
  const usage = { input_tokens: 10, cached_input_tokens: 20, output_tokens: 3 };
  providerEvent(db, { ...args, usage }); providerEvent(db, { ...args, usage });
  assert.throws(() => providerEvent(db, { ...args, usage: {} }), /Conflicting/);
  writeFileSync(process.env.T2P_RATE_CARD, JSON.stringify({ ...rates, version: "test-v2", models: {} }));
  assert.equal(queue("SYN-retry"), job);
  assert.equal(costReceipt(db, queue("SYN-new")).rate_card.version, "test-v2");
  r = costReceipt(db, job);
  assert.equal(r.rate_card.version, "test-v1");
  assert.equal(r.known_billed_usd, null);
  assert.ok(Math.abs(r.calculated_from_usage_and_pinned_rate - 0.42) < 1e-9);
  assert.equal(r.units.paid_model_calls, 1);
  providerEvent(db, { ...args, bill: { currency: "EUR", amount: 1.25 } });
  r = costReceipt(db, job);
  assert.equal(r.calculated_from_usage_and_pinned_rate, 0);
  assert.deepEqual(r.actual_billed, { EUR: 1.25 });
  assert.equal(r.known_billed_usd, null);
  assert.ok(r.warnings.some((s) => s.includes("conversion")));
  const reopened = openStore(root);
  try { assert.deepEqual(costReceipt(reopened, job), r); } finally { reopened.close(); }
});
