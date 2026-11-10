import { AsyncLocalStorage } from "node:async_hooks";
import { readFileSync } from "node:fs";
import { isDeepStrictEqual } from "node:util";
import { runId } from "./run-history.js";

const active = new AsyncLocalStorage();
const localUnits = ["elapsed_ms", "network_bytes", "storage_bytes"];
const tokens = ["input_tokens", "cached_input_tokens", "output_tokens"];
const count = (n) => Number.isSafeInteger(n) && n >= 0;

export function installLedger(db) {
  db.exec(`CREATE TABLE IF NOT EXISTS audit_prices(job INTEGER PRIMARY KEY, card TEXT NOT NULL);
    CREATE TABLE IF NOT EXISTS audit_usage(id TEXT PRIMARY KEY, job INTEGER NOT NULL, attempt TEXT NOT NULL,
      stage TEXT NOT NULL, kind TEXT NOT NULL, payload TEXT NOT NULL, at TEXT NOT NULL);
    CREATE INDEX IF NOT EXISTS usage_by_job ON audit_usage(job,attempt);`);
  for (const table of ["audit_prices", "audit_usage"]) for (const op of ["UPDATE", "DELETE"]) {
    db.exec(`CREATE TRIGGER IF NOT EXISTS immutable_${table}_${op} BEFORE ${op} ON ${table}
      BEGIN SELECT RAISE(ABORT,'immutable accounting record'); END`);
  }
}

export function configuredPrices() {
  const file = process.env.T2P_RATE_CARD;
  const card = file ? JSON.parse(readFileSync(file, "utf8")) :
    { version: "unpriced-v1", effective_date: null, currency: "USD", local: {}, models: {} };
  if (typeof card.version !== "string" || !card.version.trim() || card.currency !== "USD" || (file && !/^\d{4}-\d{2}-\d{2}$/.test(card.effective_date)) ||
      !card.local || typeof card.local !== "object" || Array.isArray(card.local) ||
      !card.models || typeof card.models !== "object" || Array.isArray(card.models)) throw Error("Invalid USD rate card");
  function validate(rates, units) {
    if (!rates || typeof rates !== "object" || Array.isArray(rates)) throw Error("Invalid rates");
    for (const [unit, rate] of Object.entries(rates)) {
      if (!units.includes(unit) || !Number.isFinite(rate) || rate < 0) throw Error("Invalid unit price");
    }
  }
  validate(card.local, localUnits);
  for (const rates of Object.values(card.models)) validate(rates, tokens);
  return card;
}

/** Freeze the operator's USD/unit assumptions once, in the queue transaction. */
export function pinPrices(db, job) {
  db.prepare("INSERT INTO audit_prices VALUES(?,?)").run(job, JSON.stringify(configuredPrices()));
}

function append(db, job, attempt, stage, id, kind, payload) {
  if (!db.prepare("SELECT 1 FROM attempts WHERE job=? AND token=?").get(job, attempt)) throw Error("Unknown audit attempt");
  const row = db.prepare("INSERT INTO audit_usage VALUES(?,?,?,?,?,?,?) ON CONFLICT(id) DO NOTHING")
    .run(id, job, attempt, stage, kind, JSON.stringify(payload), new Date().toISOString());
  if (!row.changes) {
    const old = db.prepare("SELECT * FROM audit_usage WHERE id=?").get(id);
    if (old.job !== job || old.attempt !== attempt || old.stage !== stage || !isDeepStrictEqual(JSON.parse(old.payload), payload))
      throw Error("Conflicting usage identity");
  }
}

/** Ingest an actual provider response or a later billing record for the same request.
 * Token input here excludes cache reads. Preserve missing quantities as missing.
 */
export function providerEvent(db, { job, attempt, stage, provider, region, model, usage_id, usage, bill }) {
  if (![stage, provider, region, model, usage_id].every((v) => typeof v === "string" && v.trim()) ||
      !Number.isSafeInteger(job) || job < 1 || Boolean(usage) === Boolean(bill)) throw Error("Invalid provider event");
  if (usage && (typeof usage !== "object" || Array.isArray(usage) || Object.entries(usage).some(([u,n]) => !tokens.includes(u) || !count(n)))) throw Error("Invalid token usage");
  if (bill && (Object.keys(bill).some((k) => !["amount","currency","fx"].includes(k)) || !Number.isFinite(bill.amount) || bill.amount < 0 || !/^[A-Z]{3}$/.test(bill.currency))) throw Error("Invalid bill");
  if (bill?.fx && (!(bill.fx.usd_per_unit > 0) || !Number.isFinite(bill.fx.usd_per_unit) || typeof bill.fx.source !== "string" || !bill.fx.source.trim() || !Number.isFinite(Date.parse(bill.fx.as_of))))
    throw Error("Invalid exchange rate provenance");
  const kind = bill ? "bill" : "provider";
  db.exec("BEGIN IMMEDIATE");
  try {
    const peerKey = JSON.stringify([bill ? "provider" : "bill", provider, region, usage_id]);
    const peer = db.prepare("SELECT job,attempt,stage,payload FROM audit_usage WHERE id=?").get(peerKey);
    if (peer && (peer.job !== job || peer.attempt !== attempt || peer.stage !== stage || JSON.parse(peer.payload).model !== model))
      throw Error("Conflicting provider request binding");
    append(db, job, attempt, stage, JSON.stringify([kind, provider, region, usage_id]), kind,
      { provider, region, model, usage_id, ...(bill ? { bill } : { usage }) });
    db.exec("COMMIT");
  } catch (error) { db.exec("ROLLBACK"); throw error; }
}

export function measure(units) {
  const m = active.getStore();
  if (!m) return;
  for (const [unit,n] of Object.entries(units)) {
    if (!count(n)) throw Error("Invalid measured quantity");
    m.units[unit] = (m.units[unit] ?? 0) + n;
  }
}
function flush(m) {
  measure({ elapsed_ms: Math.max(0, Math.round(performance.now() - m.started)) });
  append(m.db, m.job.id, m.job.token, m.stage, JSON.stringify([m.job.token, m.seq++]), "worker", m.units);
}
export function meterStage(stage) {
  const m = active.getStore();
  if (!m) return;
  flush(m);
  Object.assign(m, { stage, started: performance.now(), units: {} });
}
export async function meterAttempt(db, job, work) {
  const m = { db, job, stage: "prepare", seq: 0, started: performance.now(), units: { paid_model_calls: 0, network_requests: 0, network_bytes: 0, pdf_parsed: 0, docx_parsed: 0, html_parsed: 0, pdf_pages: 0 } };
  return active.run(m, async () => {
    try { return await work(); }
    finally { measure({ meter_finished: 1 }); flush(m); }
  });
}

/** Recompute from immutable facts and the original card. A bill replaces its request estimate. */
export function costReceipt(db, job) {
  db.exec("BEGIN");
  try { return readReceipt(db, job); } finally { db.exec("END"); }
}

export function readReceipt(db, job) {
  const run = db.prepare("SELECT status,hospital,json_extract(context,'$.budget') AS budget,json_extract(context,'$.mode') AS mode FROM jobs WHERE id=? AND rule='css-17-v1'").get(job);
  if (!run) throw Error("Unknown audit run");
  const card = JSON.parse(db.prepare("SELECT card FROM audit_prices WHERE job=?").get(job)?.card ?? "null");
  const rows = db.prepare("SELECT * FROM audit_usage WHERE job=? ORDER BY rowid").all(job)
    .map((r) => ({ ...r, payload: JSON.parse(r.payload) }));
  const requestKey = (p) => JSON.stringify([p.provider, p.region, p.usage_id]);
  const keysOf = (kind) => new Set(rows.filter((r) => r.kind === kind).map((r) => requestKey(r.payload)));
  const bills = keysOf("bill"), usageRecords = keysOf("provider");
  const units = {}, stages = Object.create(null), nativeBilled = {}, unpriced = [], warnings = [];
  let calculated = 0, local = 0, billedUsd = null;
  const requests = new Set();
  for (const row of rows) {
    const p = row.payload;
    const stage = stages[row.stage] ??= { units: {}, calculated_usd: 0, estimated_local_usd: 0, billed_by_currency: {} };
    function add(unit,n) {
      units[unit] = (units[unit] ?? 0) + n;
      stage.units[unit] = (stage.units[unit] ?? 0) + n;
    }
    if (row.kind === "worker") {
      for (const [unit,n] of Object.entries(p)) {
        add(unit,n);
        if (!n || !localUnits.includes(unit)) continue;
        const rate = card?.local[unit];
        if (rate == null) unpriced.push({ id: row.id, unit, quantity: n });
        else { local += rate*n; stage.estimated_local_usd += rate*n; }
      }
      continue;
    }
    const key = requestKey(p);
    if (!requests.has(key)) { requests.add(key); add("paid_model_calls",1); }
    if (row.kind === "bill") {
      const { currency, amount } = p.bill;
      if (!usageRecords.has(key)) warnings.push(`Provider quantities missing for ${p.usage_id}`);
      nativeBilled[currency] = (nativeBilled[currency] ?? 0) + amount;
      stage.billed_by_currency[currency] = (stage.billed_by_currency[currency] ?? 0) + amount;
      const fx = currency === "USD" ? 1 : p.bill.fx?.usd_per_unit;
      if (fx) billedUsd = (billedUsd ?? 0) + amount * fx;
      else warnings.push(`No USD conversion for ${currency} bill ${p.usage_id}`);
      continue;
    }
    for (const unit of tokens) {
      const n = p.usage[unit];
      if (n != null) add(unit,n);
      if (bills.has(key) || n === 0) continue;
      const rate = card?.models[`${p.provider}/${p.region}/${p.model}`]?.[unit];
      if (rate == null || n == null) unpriced.push({ id: row.id, unit, quantity: n ?? null });
      else { calculated += n*rate; stage.calculated_usd += n*rate; }
    }
    if (!bills.has(key)) warnings.push(`Provider bill pending for ${p.usage_id}`);
  }
  const attempts = db.prepare("SELECT token,status FROM attempts WHERE job=? ORDER BY started,rowid").all(job);
  const measured = attempts.length > 0 && attempts.every((a) => ["completed","failed"].includes(a.status) &&
    rows.some((r) => r.attempt === a.token && r.kind === "worker" && r.payload.meter_finished === 1));
  if (!measured || run.status !== "completed" && run.status !== "failed") warnings.push("Execution or attempt metering incomplete");
  if (units.telemetry_missing) warnings.push("Subprocess usage unavailable");
  const zero = measured && requests.size === 0;
  const stopped = db.prepare("SELECT json_extract(detail,'$.stop_code') code,json_extract(detail,'$.unit') unit FROM audit_run_events WHERE job=? AND state='failed' ORDER BY seq DESC LIMIT 1").get(job);
  return { budget:JSON.parse(run.budget??"null"),budget_stop:stopped?.code ? stopped : null, schema_version: "audit-cost-receipt-v1", audit_run_id: runId(job), job, hospital_key: run.hospital, mode: run.mode, status: run.status, rate_card: card, attempts, stages, units, rows,
    actual_billed: nativeBilled, known_billed_usd: billedUsd ?? (zero ? 0 : null),
    calculated_from_usage_and_pinned_rate: calculated, estimated_local_compute_storage_network: local,
    estimated_subtotal_usd: local + calculated, zero_incremental_api: zero, unknown_unpriced: unpriced,
    complete: warnings.length === 0 && unpriced.length === 0, warnings };
}
