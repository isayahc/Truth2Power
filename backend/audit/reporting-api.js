import { DatabaseSync } from "node:sqlite";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { directory, openStore } from "./store.js";
import { enqueuePipeline, pipelineRoot } from "./pipeline-store.js";
import { roster } from "./roster-inventory.js";
import { readReceipt } from "./usage-ledger.js";
import { runId } from "./run-history.js";
import { fingerprint, readArtifact } from "../grading/data.js";
import { sha256 } from "../review/identity.js";

const base = "/api/pilot/v1",
  version = "audit-reporting-v1";
const regions = JSON.parse(
  readFileSync(
    new URL("../../references/ny-economic-regions-v1.json", import.meta.url),
  ),
).regions;
const countyKey = (s) => s.toLowerCase().replaceAll(".", "");
const hospitals = new Map(
  roster.map(({ id, properties: p }) => [
    id,
    {
      hospital_key: id,
      pfi: p.pfi,
      name: p.name,
      region: Object.keys(regions).find((region) =>
        regions[region].some((c) => countyKey(c) === countyKey(p.county)),
      ),
    },
  ]),
);
const modes = ["replay", "full_audit", "live", "discovery_only"];
const statuses = [
  "queued",
  "running",
  "retrying",
  "partial",
  "completed",
  "failed",
  "cancelled",
];
const stages = new Set([
  "load_saved_evidence",
  "collect_sources",
  "collection_saved",
  "extract_documents",
  "restore_checkpoint",
  "grade",
]);
const json = (statusCode, data) => ({
  statusCode,
  headers: { "Content-Type": "application/json", "Cache-Control": "no-store" },
  body: JSON.stringify({ schema_version: version, ...data }),
});
const reject = (status, code) => {
  throw Object.assign(Error(code), { status, code });
};
function integer(value, max) {
  if (
    !/^[1-9]\d*$/.test(value) ||
    !Number.isSafeInteger(Number(value)) ||
    Number(value) > max
  )
    reject(400, "invalid_parameter");
  return Number(value);
}
function params(q, keys) {
  if (Object.keys(q).some((k) => !keys.includes(k)))
    reject(400, "invalid_parameter");
}
function page(rows, limit, key) {
  const more = rows.length > limit;
  const items = rows.slice(0, limit);
  return { items, next_cursor: more ? String(items.at(-1)[key]) : null };
}

// Only committed projections and whitelisted fields reach HTTP. Keep request keys, attempt
// ownership tokens, paths and free-text provider metadata inside the operator's store.
const projection = `SELECT j.id,j.hospital,j.attempted,j.attempts,j.year,json_extract(j.context,'$.mode') mode,
  (SELECT at FROM audit_run_events WHERE job=j.id AND state='queued' ORDER BY seq LIMIT 1) queued_at,
  COALESCE(e.state, CASE WHEN j.status='queued' AND j.error IS NOT NULL THEN 'retrying' ELSE j.status END) status,
  json_extract(a.output,'$.id') assessment_id,json_extract(j.checkpoint,'$.scan_id') scan_id,
  a.completed assessed_at,COALESCE(e.at,a.completed) completed_at,
  json_extract(e.detail,'$.coverage_gaps') gaps,json_extract(e.detail,'$.unresolved_measures') unresolved,
  (SELECT max(julianday(json_extract(c.value,'$.retrieved_at'))) FROM json_each(e.detail,'$.captures') c) fetched_jd
  FROM jobs j LEFT JOIN assessments a ON a.job=j.id LEFT JOIN audit_run_events e ON e.job=j.id AND e.state IN ('partial','completed')
  WHERE j.rule='css-17-v1' AND json_extract(j.context,'$.root')=? AND json_extract(j.context,'$.mode') IN ('live','full_audit','discovery_only','replay')`;
function runRow(r) {
  const path = base + "/runs/" + runId(r.id);
  return {
    audit_run_id: runId(r.id),
    job_id: r.id,
    hospital_key: r.hospital,
    year: r.year,
    mode: r.mode,
    status: r.status,
    queued_at: r.queued_at,
    attempted_at: r.attempted,
    completed_at: r.completed_at,
    attempts: r.attempts,
    evidence:
      r.gaps == null
        ? "unknown"
        : r.status === "partial"
          ? "partial"
          : "complete",
    unresolved_measures: r.unresolved,
    coverage_gaps: r.gaps,
    assessment_id: r.assessment_id,
    scan_id: r.scan_id,
    timeline: path + "/timeline",
    receipt: path + "/receipt",
    revision:
      r.assessment_id || r.scan_id
        ? path + "/revision/" + (r.assessment_id || r.scan_id)
        : null,
  };
}
function clocks(db, key) {
  const row = db
    ?.prepare(
      `WITH runs AS (${projection}) SELECT max(attempted) last_attempted,
    max(completed_at) last_completed_execution,strftime('%Y-%m-%dT%H:%M:%fZ',max(fetched_jd)) last_successful_source_retrieval,
    strftime('%Y-%m-%dT%H:%M:%fZ',max(fetched_jd)+30) next_due_at,
    (SELECT assessed_at FROM runs WHERE hospital=? AND mode IN ('live','full_audit') AND assessment_id IS NOT NULL ORDER BY id DESC LIMIT 1) last_eligible_assessment
    FROM runs WHERE hospital=?`,
    )
    .get(pipelineRoot(), key, key);
  return (
    row ?? {
      last_attempted: null,
      last_completed_execution: null,
      last_successful_source_retrieval: null,
      last_eligible_assessment: null,
      next_due_at: null,
    }
  );
}

function publicReceipt(db, r) {
  const c = readReceipt(db, r.id);
  const units = { ...c.units };
  delete units.meter_finished;
  delete units.telemetry_missing;
  const stage_usage = {};
  const stage_costs = {};
  for (const [name, stage] of Object.entries(c.stages)) {
    const label = [
      "prepare",
      "collect_sources",
      "load_saved_evidence",
      "extract_documents",
      "grade",
      "publish",
    ].includes(name)
      ? name
      : "external";
    const cost = stage_costs[label] ??= { billed_by_currency: {}, estimated_local_usd: null, calculated_provider_usd: null };
    for (const [currency, amount] of Object.entries(stage.billed_by_currency))
      cost.billed_by_currency[currency] = (cost.billed_by_currency[currency] ?? 0) + amount;
    if (Object.keys(c.rate_card?.local ?? {}).some(unit => stage.units[unit] > 0))
      cost.estimated_local_usd = (cost.estimated_local_usd ?? 0) + stage.estimated_local_usd;
    if (stage.calculated_usd > 0 || c.rows.some(row => row.stage === name && row.kind === "provider" &&
      Object.entries(row.payload.usage).some(([unit, n]) => n > 0 && c.rate_card?.models?.[
        [row.payload.provider,row.payload.region,row.payload.model].join("/")
      ]?.[unit] != null)))
      cost.calculated_provider_usd = (cost.calculated_provider_usd ?? 0) + stage.calculated_usd;
    const target = (stage_usage[label] ??= {});
    for (const [unit, quantity] of Object.entries(stage.units)) {
      if (unit !== "meter_finished" && unit !== "telemetry_missing")
        target[unit] = (target[unit] ?? 0) + quantity;
    }
  }
  const localPriced = ["storage_bytes", "elapsed_ms", "network_bytes"].some(
    (k) => units[k] > 0 && c.rate_card?.local?.[k] != null,
  );
  const calculatedPriced = c.rows.some(
    (row) =>
      row.kind === "provider" &&
      Object.entries(row.payload.usage).some(
        ([unit, n]) =>
          n > 0 &&
          c.rate_card?.models?.[
            [row.payload.provider, row.payload.region, row.payload.model].join(
              "/",
            )
          ]?.[unit] != null,
      ),
  );
  return {
    audit_run_id: runId(r.id),
    hospital_key: r.hospital,
    mode: r.mode,
    status: r.status,
    units,
    stage_usage,
    stage_costs,
    cost_status: c.complete
      ? "complete"
      : c.known_billed_usd != null ||
          localPriced ||
          calculatedPriced ||
          Object.keys(c.actual_billed).length
        ? "partial"
        : "unknown",
    complete: c.complete,
    known_billed_usd: c.known_billed_usd,
    billed_by_currency: c.actual_billed,
    estimated_local_usd: localPriced
      ? c.estimated_local_compute_storage_network
      : null,
    calculated_provider_usd: calculatedPriced
      ? c.calculated_from_usage_and_pinned_rate
      : null,
    zero_incremental_api: c.zero_incremental_api,
    unpriced_units: [...new Set(c.unknown_unpriced.map((x) => x.unit))],
    warning_count: c.warnings.length,
    price_card_sha256: c.rate_card ? fingerprint(c.rate_card) : null,
    price_effective_date: /^\d{4}-\d{2}-\d{2}$/.test(
      c.rate_card?.effective_date,
    )
      ? c.rate_card.effective_date
      : null,
  };
}
function csv(receipt) {
  const fields = Object.keys(receipt);
  const cell = (v) =>
    '"' +
    (v == null
      ? ""
      : typeof v === "object"
        ? JSON.stringify(v)
        : String(v)
    ).replaceAll('"', '""') +
    '"';
  return {
    statusCode: 200,
    headers: {
      "Content-Type": "text/csv; charset=utf-8",
      "Content-Disposition": 'attachment; filename="audit-receipt-v1.csv"',
      "Cache-Control": "no-store",
    },
    body:
      fields.join(",") +
      "\r\n" +
      fields.map((k) => cell(receipt[k])).join(",") +
      "\r\n",
  };
}
function summary(db, q) {
  params(q, ["pfi", "region", "mode", "status", "evidence", "from", "to"]);
  if (
    (q.region && !Object.hasOwn(regions, q.region)) ||
    (q.pfi && !hospitals.has(q.pfi)) ||
    (q.mode && !modes.includes(q.mode)) ||
    (q.status && !statuses.includes(q.status)) ||
    (q.evidence && !["partial", "complete", "unknown"].includes(q.evidence))
  )
    reject(400, "invalid_filter");
  for (const d of [q.from, q.to].filter((v) => v !== undefined))
    if (
      !/^\d{4}-\d{2}-\d{2}$/.test(d) ||
      !Number.isFinite(Date.parse(d)) ||
      new Date(d).toISOString().slice(0, 10) !== d
    )
      reject(400, "invalid_date");
  if (q.from && q.to && q.from > q.to) reject(400, "invalid_date");
  const facilities = [...hospitals.values()].filter(
    (h) =>
      (!q.region || h.region === q.region) &&
      (!q.pfi || h.hospital_key === q.pfi),
  );
  const selected = new Set(facilities.map((h) => h.hospital_key)),
    covered = new Set();
  const result = {
    roster_total: hospitals.size,
    eligible_facilities: selected.size,
    facilities_with_runs: 0,
    runs: 0,
    by_status: {},
    incomplete_receipts: 0,
    known_billed_usd: null,
    estimated_local_usd: null,
    calculated_provider_usd: null,
    billed_by_currency: {},
    units: {},
  };
  for (const r of db?.prepare(projection).iterate(pipelineRoot()) ?? []) {
    const day = r.queued_at?.slice(0, 10);
    if (
      !selected.has(r.hospital) ||
      (q.mode && r.mode !== q.mode) ||
      (q.status && r.status !== q.status) ||
      (q.evidence && runRow(r).evidence !== q.evidence) ||
      (q.from && (!day || day < q.from)) ||
      (q.to && (!day || day > q.to))
    )
      continue;
    const c = publicReceipt(db, r);
    covered.add(r.hospital);
    result.runs++;
    result.by_status[r.status] = (result.by_status[r.status] ?? 0) + 1;
    if (!c.complete) result.incomplete_receipts++;
    for (const k of [
      "known_billed_usd",
      "estimated_local_usd",
      "calculated_provider_usd",
    ])
      if (c[k] != null) result[k] = (result[k] ?? 0) + c[k];
    for (const k of ["units", "billed_by_currency"])
      for (const [unit, n] of Object.entries(c[k]))
        result[k][unit] = (result[k][unit] ?? 0) + n;
  }
  result.facilities_with_runs = covered.size;
  return result;
}

export function reportingRoute(event) {
  const path = event.rawPath.slice(base.length),
    method = event.requestContext?.http?.method,
    q = event.queryStringParameters ?? {};
  const facility = /^\/hospitals\/([\w-]+)\/runs$/.exec(path);
  const run =
    /^\/runs\/audit-run-([1-9]\d*)(?:\/(timeline|receipt(?:\.csv)?|revision\/([a-f0-9]{64})(?:\/snapshots\/([a-f0-9]{64}))?))?$/.exec(
      path,
    );
  let db;
  try {
    if (facility && !hospitals.has(facility[1]))
      reject(404, "unknown_hospital");
    if (facility && method === "POST") {
      params(q, []);
      if (event.headers?.["x-review-request"] !== "1") reject(403, "forbidden");
      if (typeof event.body !== "string") reject(400, "invalid_request");
      if (Buffer.byteLength(event.body) > 8192) reject(413, "body_too_large");
      let o;
      try {
        o = JSON.parse(event.body);
      } catch {
        reject(400, "invalid_request");
      }
      if (
        !o ||
        !modes.includes(o.mode) ||
        typeof o.request_key !== "string" ||
        !/^[A-Za-z0-9-]{1,100}$/.test(o.request_key) ||
        !Number.isInteger(o.year) ||
        typeof o.review_date !== "string" ||
        Object.keys(o).some(
          (k) =>
            ![
              "year",
              "review_date",
              "mode",
              "request_key",
              "discovery_bounds",
            ].includes(k),
        )
      )
        reject(400, "invalid_request");
      db = openStore();
      try {
        const id = enqueuePipeline(db, { ...o, hospital_key: facility[1] });
        return json(202, {
          audit_run_id: runId(id),
          url: base + "/runs/" + runId(id),
        });
      } catch (err) {
        if (/Idempotency key/.test(err.message))
          reject(409, "request_conflict");
        if (/Invalid/.test(err.message)) reject(400, "invalid_request");
        throw err;
      }
    }
    if (method !== "GET") reject(405, "method_not_allowed");
    if (!facility && !run && path !== "/summary" && path !== "/operations")
      reject(404, "unknown_endpoint");
    const file = join(directory, "audit.sqlite");
    if (existsSync(file)) {
      db = new DatabaseSync(file, { readOnly: true });
      db.exec("BEGIN");
      // Read-only reporting cannot migrate a historical database.
      if (
        !db
          .prepare("SELECT 1 FROM sqlite_master WHERE name='audit_run_events'")
          .get()
      )
        reject(503, "migration_required");
      if (
        !db
          .prepare("SELECT 1 FROM sqlite_master WHERE name='audit_usage'")
          .get()
      )
        db.exec(
          "CREATE TEMP TABLE audit_usage(id,job,attempt,stage,kind,payload,at); CREATE TEMP TABLE audit_prices(job,card)",
        );
    }
    if (path === "/operations") {
      params(q, []);
      const latest = new Map();
      if (db) for (const row of db.prepare(`SELECT * FROM (SELECT p.*, row_number() OVER (PARTITION BY hospital ORDER BY id DESC) AS rank FROM (${projection}) p) WHERE rank=1`).iterate(pipelineRoot())) latest.set(row.hospital,row);
      return json(200,{items:[...hospitals.values()].map(h => {
        const r = latest.get(h.hospital_key);
        return {...h,clocks:clocks(r ? db : null,h.hospital_key),latest:r ? runRow(r) : null,
          cost_status:r ? publicReceipt(db,r).cost_status : "unknown"};
      })});
    }
    if (path === "/summary") return json(200, summary(db, q));
    if (facility) {
      params(q, ["limit", "cursor"]);
      const limit = integer(q.limit ?? "25", 100),
        cursor = integer(
          q.cursor ?? String(Number.MAX_SAFE_INTEGER),
          Number.MAX_SAFE_INTEGER,
        );
      const rows =
        db
          ?.prepare(
            `SELECT * FROM (${projection}) WHERE hospital=? AND id<? ORDER BY id DESC LIMIT ?`,
          )
          .all(pipelineRoot(), facility[1], cursor, limit + 1) ?? [];
      return json(200, {
        hospital: hospitals.get(facility[1]),
        clocks: clocks(db, facility[1]),
        ...page(rows.map(runRow), limit, "job_id"),
      });
    }
    const id = integer(run[1], Number.MAX_SAFE_INTEGER);
    const r = db
      ?.prepare(`SELECT * FROM (${projection}) WHERE id=?`)
      .get(pipelineRoot(), id);
    if (!r) reject(404, "unknown_run");
    if (run[2] === "timeline") {
      params(q, ["limit", "cursor"]);
      const limit = integer(q.limit ?? "25", 100),
        cursor =
          q.cursor === undefined
            ? 0
            : integer(q.cursor, Number.MAX_SAFE_INTEGER);
      const rows = db
        .prepare(
          `SELECT seq,attempt,state,at,json_extract(detail,'$.name') stage FROM audit_run_events
        WHERE job=? AND seq>? ORDER BY seq LIMIT ?`,
        )
        .all(id, cursor, limit + 1);
      return json(
        200,
        page(
          rows.map((e) => ({
            seq: e.seq,
            state: e.state,
            at: e.at,
            attempt_id: e.attempt ? sha256(e.attempt) : null,
            stage: stages.has(e.stage) ? e.stage : null,
            reason:
              {
                failed: "audit_failed",
                interrupted: "lease_expired",
                retrying: "retry_scheduled",
                cancelled: "operator_cancelled",
              }[e.state] ?? null,
          })),
          limit,
          "seq",
        ),
      );
    }
    if (run[4]) {
      params(q, []);
      return revision(db, r, run[3], run[4]);
    }
    if (run[3]) {
      params(q, ["limit", "cursor"]);
      const limit = integer(q.limit ?? "25", 100);
      const offset =
        q.cursor === undefined ? 0 : integer(q.cursor, Number.MAX_SAFE_INTEGER);
      const result = revision(db, r, run[3]);
      return json(200, {
        ...result,
        sources: result.sources.slice(offset, offset + limit),
        next_cursor:
          result.sources.length > offset + limit
            ? String(offset + limit)
            : null,
      });
    }
    params(q, []);
    if (run[2]?.startsWith("receipt")) {
      const receipt = publicReceipt(db, r);
      return run[2] === "receipt.csv" ? csv({schema_version: version, ...receipt}) : json(200, receipt);
    }
    const attempts = db
      .prepare(
        "SELECT token,started,status FROM attempts WHERE job=? ORDER BY started,rowid LIMIT 100",
      )
      .all(id);
    return json(200, {
      ...runRow(r),
      attempt_history: attempts.map((a) => ({
        attempt_id: sha256(a.token),
        started_at: a.started,
        status: a.status,
      })),
    });
  } catch (e) {
    return json(e.status ?? 500, {
      error: e.status ? e.code : "report_unavailable",
    });
  } finally {
    db?.close();
  }
}

function attachment(sources, digest) {
  const source = sources.find(
    (s) =>
      s?.sha256 === digest &&
      ["pdf", "docx", "html", "json"].some(
        (ext) => s.artifact_path === `snapshots/${digest}.${ext}`,
      ),
  );
  if (!source) reject(404, "unknown_snapshot");
  let bytes;
  try {
    bytes = readArtifact(pipelineRoot(), source.artifact_path);
  } catch {
    reject(404, "snapshot_unavailable");
  }
  if (sha256(bytes) !== digest) reject(422, "snapshot_integrity");
  return {
    statusCode: 200,
    isBase64Encoded: true,
    body: bytes.toString("base64"),
    headers: {
      "Content-Type": "application/octet-stream",
      "Content-Disposition": `attachment; filename="${source.artifact_path.split("/").at(-1)}"`,
      "Content-Security-Policy": "sandbox",
      "X-Content-Type-Options": "nosniff",
      "Cache-Control": "no-store",
    },
  };
}

function gapTypes(gaps) {
  return [...new Set((gaps ?? []).map(g => {
    if (/campus|classif/i.test(g)) return "campus";
    if (/language|translation/i.test(g)) return "language";
    if (/template/i.test(g)) return "template";
    if (/governing|reference/i.test(g)) return "reference";
    if (/unavailable|not captured|404|410|snapshot/i.test(g)) return "missing";
    return "scope";
  }))];
}
function revision(db, r, id, digest) {
  const snapshotPath =
    base + "/runs/" + runId(r.id) + "/revision/" + id + "/snapshots/";
  if (id !== r.assessment_id && id !== r.scan_id)
    reject(404, "unknown_revision");
  if (id === r.assessment_id) {
    const b = JSON.parse(
      db.prepare("SELECT output FROM assessments WHERE job=?").get(r.id).output,
    );
    if (fingerprint({ input: b.input, report: b.report }) !== id)
      reject(422, "revision_integrity");
    if (digest)
      return attachment(
        b.input.sources.map((s) => s.snapshot),
        digest,
      );
    return {
      revision: id,
      source_count:b.input.sources.filter(s=>s.snapshot).length, gap_types:gapTypes(b.report.coverage_gaps),
      findings: b.report.findings.map(({ measure_id, result }) => ({
        measure_id,
        result,
      })),
      sources: b.input.sources.map((s) => ({
        role: s.role,
        language: s.language,
        sha256: s.snapshot?.sha256 ?? null,
        download: s.snapshot ? snapshotPath + s.snapshot.sha256 : null,
      })),
    };
  }
  const { id: saved, ...scan } = JSON.parse(
    readArtifact(pipelineRoot(), `pipeline-scans/${id}.json`),
  );
  if (saved !== id || scan.job !== r.id || fingerprint(scan) !== id)
    reject(422, "revision_integrity");
  if (digest)
    return attachment(
      scan.inventory.sources
        .filter((s) => s.capture_status === "saved")
        .map((s) => ({ sha256: s.digest, artifact_path: s.artifact_path })),
      digest,
    );
  return {
    revision: id,
    source_count:scan.inventory.sources.filter(s=>s.capture_status==="saved").length, gap_types:gapTypes(scan.inventory.gaps),
    sources: scan.inventory.sources.map((s) => ({
      role: s.role,
      language: s.language,
      sha256: s.digest,
      availability: s.capture_status,
      download: s.capture_status === "saved" ? snapshotPath + s.digest : null,
    })),
  };
}
