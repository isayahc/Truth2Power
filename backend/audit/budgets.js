import { configuredPrices } from "./usage-ledger.js";
import { readFileSync } from "node:fs";

export const defaults = Object.freeze({
  network_requests: 600,
  network_bytes: 134217728,
  pages: 100,
  documents: 100,
  seconds: 600,
  retries: 2,
  paid_requests: 0,
  paid_tokens: 0,
  paid_usd_micros: 0,
});
const maxima = {
  ...defaults,
  network_requests: 5000,
  seconds: 3600,
  paid_requests: 100,
  paid_tokens: 1000000,
  paid_usd_micros: 100000000,
};

function validate(values, ceilings) {
  if (
    !values ||
    typeof values !== "object" ||
    Array.isArray(values) ||
    Object.entries(values).some(
      ([k, v]) =>
        !Object.hasOwn(ceilings, k) ||
        !Number.isSafeInteger(v) ||
        v < 0 ||
        v > ceilings[k],
    )
  )
    throw Error("Invalid audit budget");
}
export function budgetPolicy(overrides = {}, paid = false) {
  const configured = process.env.T2P_BUDGET_FILE
    ? JSON.parse(readFileSync(process.env.T2P_BUDGET_FILE, "utf8"))
    : {};
  validate(configured, maxima);
  const caps = { ...defaults, ...configured };
  validate(overrides, caps);
  if (typeof paid !== "boolean") throw Error("Invalid paid opt-in");
  const policy = { ...caps, ...overrides };
  if (
    paid &&
    (!policy.paid_requests || !policy.paid_tokens || !policy.paid_usd_micros)
  )
    throw Error("Invalid paid budget");
  return { ...policy, paid };
}
export function preview(policy, mode) {
  if (
    !["replay", "synthetic", "full_audit", "live", "discovery_only"].includes(
      mode,
    )
  )
    throw Error("Invalid audit mode");
  const live = ["discovery_only", "full_audit", "live"].includes(mode);
  const rates = configuredPrices().local;
  const bytes = live ? policy.network_bytes : 0;
  const network =
    bytes === 0
      ? 0
      : rates.network_bytes == null
        ? null
        : bytes * rates.network_bytes;
  const compute =
    rates.elapsed_ms == null ? null : policy.seconds * 1000 * rates.elapsed_ms;
  return {
    network_usd_range: network == null ? null : [0, network],
    compute_usd_range: compute == null ? null : [0, compute],
    network_requests_max: live ? policy.network_requests : 0,
    network_bytes_max: live ? policy.network_bytes : 0,
    paid_usd_range: [0, policy.paid ? policy.paid_usd_micros / 1e6 : 0],
    local_cost_usd: null,
    seconds_max: policy.seconds,
  };
}
export class BudgetStop extends Error {
  constructor(code, unit) {
    super(code + " (" + unit + ")");
    this.code = code;
    this.unit = unit;
  }
}
export function deadline(db, job) {
  const first = db
    .prepare("SELECT min(started) at FROM attempts WHERE job=?")
    .get(job.id).at;
  const end =
    Date.parse(first) + (job.context.budget ?? defaults).seconds * 1000;
  if (Date.now() >= end) throw new BudgetStop("budget_exhausted", "seconds");
  return end;
}

/** Reconcile reservations with #96's reported charges. Retain the larger exposure
 * until the run ends, and count unmatched external requests against subsequent calls. */
function exposure(db, id, card) {
  const charges = new Map();
  for (const row of db
    .prepare("SELECT * FROM paid_reservations WHERE job=?")
    .all(id)) {
    const model = JSON.parse(row.binding)[0];
    charges.set(JSON.stringify([model, row.request_key]), {
      micros: row.micros,
      tokens: row.tokens,
      reserved: true,
    });
  }
  for (const row of db
    .prepare(
      "SELECT kind,payload FROM audit_usage WHERE job=? AND kind IN ('bill','provider')",
    )
    .all(id)) {
    const p = JSON.parse(row.payload),
      model = [p.provider, p.region, p.model].join("/");
    const key = JSON.stringify([model, p.usage_id]),
      charge = charges.get(key) ?? { micros: 0, tokens: 0 };
    if (p.bill) {
      const fx = p.bill.currency === "USD" ? 1 : p.bill.fx?.usd_per_unit;
      if (!fx) throw new BudgetStop("unknown_price", "paid_usd_micros");
      charge.bill = Math.ceil(p.bill.amount * fx * 1e6);
    } else {
      charge.usage = p.usage;
      charge.rates = card?.models?.[model];
    }
    charges.set(key, charge);
  }
  let tokens = 0,
    micros = 0;
  for (const charge of charges.values()) {
    let estimate = 0;
    for (const unit of [
      "input_tokens",
      "cached_input_tokens",
      "output_tokens",
    ]) {
      const n = charge.usage?.[unit];
      if (n == null && !charge.reserved)
        throw new BudgetStop("quota_exceeded", "paid_tokens");
      if (n && charge.bill == null && charge.rates?.[unit] == null)
        throw new BudgetStop("unknown_price", "paid_usd_micros");
      estimate += (n ?? 0) * (charge.rates?.[unit] ?? 0);
    }
    tokens += Math.max(
      charge.tokens,
      Object.values(charge.usage ?? {}).reduce((a, b) => a + b, 0),
    );
    micros += Math.max(charge.micros, charge.bill ?? Math.ceil(estimate * 1e6));
  }
  return { requests: charges.size, tokens, micros };
}

/** Reserve a worst-case paid request before dispatch. Duplicate keys always suppress dispatch.
 * No provider transport is enabled by this module. A crash keeps the reservation charged.
 */
export function reservePaid(db, job, key, modelKey, tokens) {
  if (
    typeof key !== "string" ||
    !key.trim() ||
    key.length > 128 ||
    !tokens ||
    Object.keys(tokens).sort().join(",") !==
      "cached_input_tokens,input_tokens,output_tokens" ||
    Object.values(tokens).some((n) => !Number.isSafeInteger(n) || n < 0)
  )
    throw Error("Invalid paid reservation");
  db.exec("BEGIN IMMEDIATE");
  try {
    const claim = db
      .prepare(
        "SELECT context FROM jobs WHERE id=? AND rule='css-17-v1' AND token=? AND status='running'",
      )
      .get(job.id, job.token);
    if (!claim) throw Error("Inactive attempt");
    const context = JSON.parse(claim.context);
    deadline(db, { id: job.id, context });
    const policy = context.budget ?? defaults;
    if (!policy.paid) throw new BudgetStop("quota_exceeded", "paid_requests");
    const card = JSON.parse(
      db.prepare("SELECT card FROM audit_prices WHERE job=?").get(job.id)
        ?.card ?? "null",
    );
    const rates = card?.models?.[modelKey];
    if (
      !rates ||
      Object.entries(tokens).some(
        ([u, n]) => n > 0 && !Number.isFinite(rates[u]),
      )
    )
      throw new BudgetStop("unknown_price", "paid_usd_micros");
    const amount = Math.ceil(
      Object.entries(tokens).reduce(
        (sum, [u, n]) => sum + n * (rates[u] ?? 0),
        0,
      ) * 1e6,
    );
    const quantity = Object.values(tokens).reduce((a, b) => a + b, 0);
    const binding = JSON.stringify([
      modelKey,
      tokens.input_tokens,
      tokens.cached_input_tokens,
      tokens.output_tokens,
    ]);
    const old = db
      .prepare(
        "SELECT binding FROM paid_reservations WHERE job=? AND request_key=?",
      )
      .get(job.id, key);
    if (old) {
      if (old.binding !== binding) throw Error("Conflicting paid reservation");
      db.exec("COMMIT");
      return false;
    }
    const alreadyReported = db
      .prepare(
        `SELECT 1 FROM audit_usage WHERE job=? AND kind IN ('provider','bill') AND
      json_extract(payload,'$.usage_id')=? AND json_extract(payload,'$.provider')||'/'||json_extract(payload,'$.region')||'/'||json_extract(payload,'$.model')=?`,
      )
      .get(job.id, key, modelKey);
    if (alreadyReported) {
      db.exec("COMMIT");
      return false;
    }
    const used = exposure(db, job.id, card);
    if (used.requests + 1 > policy.paid_requests)
      throw new BudgetStop("quota_exceeded", "paid_requests");
    if (used.tokens + quantity > policy.paid_tokens)
      throw new BudgetStop("quota_exceeded", "paid_tokens");
    if (used.micros + amount > policy.paid_usd_micros)
      throw new BudgetStop("budget_exhausted", "paid_usd_micros");
    db.prepare("INSERT INTO paid_reservations VALUES(?,?,?,?,?)").run(
      job.id,
      key,
      binding,
      quantity,
      amount,
    );
    db.exec("COMMIT");
    return true;
  } catch (error) {
    db.exec("ROLLBACK");
    throw error;
  }
}
