import { readFileSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { resolve, relative, isAbsolute } from "node:path";
import { randomUUID } from "node:crypto";
import { transaction, now } from "./store.js";
import { facilityFor } from "./roster-inventory.js";
import { steps, stepIds } from "../../agents/steps.ts";
import { hospitals } from "../../agents/hospitals.ts";
import { findArtifact } from "../../agents/artifacts.ts";

const rubric = JSON.parse(readFileSync(new URL("../../rubrics/css-17-v1.json", import.meta.url)));
const titles = new Map(rubric.measures.map(m => [m.measure_id, m.title]));
export function installCriteria(db) {
  db.exec(`CREATE TABLE IF NOT EXISTS criterion_jobs (
    id TEXT PRIMARY KEY, request_key TEXT UNIQUE NOT NULL, hospital TEXT NOT NULL,
    step TEXT NOT NULL, approved TEXT NOT NULL, status TEXT NOT NULL,
    created TEXT NOT NULL, started TEXT, completed TEXT, lease INTEGER, token TEXT,
    progress TEXT NOT NULL DEFAULT '{}', error TEXT);
    CREATE UNIQUE INDEX IF NOT EXISTS criterion_one_active_hospital ON criterion_jobs(hospital)
      WHERE status IN ('queued','running');
    CREATE TABLE IF NOT EXISTS criterion_requests (
      request_key TEXT PRIMARY KEY, job TEXT NOT NULL);
    CREATE TABLE IF NOT EXISTS criterion_results (
      hospital TEXT NOT NULL, step TEXT NOT NULL, job TEXT NOT NULL, completed TEXT NOT NULL,
      output TEXT NOT NULL, PRIMARY KEY(hospital,step));`);
}
export function criterionHospital(key) {
  const f = facilityFor(key);
  const known = Object.values(hospitals).find(h => h.name === f.name && h.financialAssistanceUrl === f.landing_url);
  return known ?? { id: `hospital-${key}`, name: f.name, financialAssistanceUrl: f.landing_url };
}
function fail(status, message) { throw Object.assign(Error(message), { status }); }
export function validateStep(step) {
  if (!stepIds.includes(step)) fail(400, "Invalid criterion.");
}
export async function criterionPlan(root, hospital, requested, find = findArtifact) {
  validateStep(requested);
  const run = [], reuse = [], seen = new Set();
  async function visit(id) {
    if (seen.has(id)) return;
    seen.add(id);
    if (id !== requested && await find(root, hospital, steps[id])) { reuse.push(id); return; }
    for (const dependency of steps[id].dependencies) await visit(dependency);
    run.push(id);
  }
  await visit(requested);
  return { requested, run, reuse, model: "us.amazon.nova-micro-v1:0", max_model_calls: 40, timeout_minutes: 20 };
}
export function expireCriteria(db) {
  // Never replay an interrupted paid run automatically: a click must authorize another attempt.
  db.prepare("UPDATE criterion_jobs SET status='failed',completed=?,error='interrupted',lease=NULL WHERE status='running' AND lease<=?")
    .run(now(), Date.now());
}
function publicJob(row) {
  if (!row) return null;
  const progress = JSON.parse(row.progress);
  return { id: row.id, step: row.step, status: row.status, created: row.created,
    started: row.started, completed: row.completed, error: row.error,
    progress: Object.fromEntries(Object.entries(progress).map(([id, entry]) => [id, { status: entry.status }])) };
}
export function criterionStatus(db, hospital) {
  expireCriteria(db);
  const jobs = db.prepare("SELECT * FROM criterion_jobs WHERE hospital=? ORDER BY created DESC, rowid DESC").all(hospital);
  const results = db.prepare("SELECT * FROM criterion_results WHERE hospital=?").all(hospital);
  return { hospital_key: hospital, active: publicJob(jobs.find(j => ['queued','running'].includes(j.status))),
    items: stepIds.map(id => {
      const saved = results.find(r => r.step === id);
      const latest = jobs.find(j => j.step === id);
      return { id, title: titles.get(steps[id].criterion), criterion: steps[id].criterion,
        latest: publicJob(latest), saved: saved ? { job: saved.job, completed: saved.completed, ...JSON.parse(saved.output) } : null };
    }) };
}
export function enqueueCriterion(db, hospital, step, input, plan) {
  validateStep(step);
  if (!input || typeof input.request_key !== 'string' || !/^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/.test(input.request_key) || typeof input.rerun !== 'boolean' ||
      !Array.isArray(input.approved_steps) || input.approved_steps.length > 17 || input.approved_steps.some(s => !stepIds.includes(s)))
    fail(400, "Invalid criterion request.");
  return transaction(db, () => {
    expireCriteria(db);
    const existing = db.prepare("SELECT j.* FROM criterion_jobs j LEFT JOIN criterion_requests r ON r.job=j.id WHERE j.request_key=? OR r.request_key=? LIMIT 1")
      .get(input.request_key, input.request_key);
    if (existing) {
      if (existing.hospital !== hospital || existing.step !== step) fail(409, "Request key already used.");
      return publicJob(existing);
    }
    const active = db.prepare("SELECT * FROM criterion_jobs WHERE hospital=? AND status IN ('queued','running')").get(hospital);
    if (active) {
      if (active.step !== step) fail(409, "Another criterion is already running for this hospital.");
      db.prepare('INSERT INTO criterion_requests VALUES(?,?)').run(input.request_key, active.id);
      return publicJob(active);
    }
    if (db.prepare("SELECT id FROM jobs WHERE hospital=? AND status IN ('queued','running')").get(hospital))
      fail(409, "Another audit is already running for this hospital.");
    if (!input.rerun && db.prepare("SELECT job FROM criterion_results WHERE hospital=? AND step=?").get(hospital, step))
      fail(409, "A saved result exists. Choose Run again explicitly.");
    if (plan.run.some(id => !input.approved_steps.includes(id))) fail(409, "Preparation changed. Review the new run plan.");
    const id = randomUUID();
    db.prepare("INSERT INTO criterion_jobs(id,request_key,hospital,step,approved,status,created) VALUES(?,?,?,?,?,'queued',?)")
      .run(id, input.request_key, hospital, step, JSON.stringify(plan.run), now());
    db.prepare('INSERT INTO criterion_requests VALUES(?,?)').run(input.request_key, id);
    return publicJob(db.prepare("SELECT * FROM criterion_jobs WHERE id=?").get(id));
  });
}
export function claimCriterion(db) {
  return transaction(db, () => {
    expireCriteria(db);
    const row = db.prepare("SELECT * FROM criterion_jobs WHERE status='queued' ORDER BY created,rowid LIMIT 1").get();
    if (!row) return null;
    const token = randomUUID();
    db.prepare("UPDATE criterion_jobs SET status='running',started=?,token=?,lease=? WHERE id=?")
      .run(now(), token, Date.now() + 90000, row.id);
    return { ...row, token };
  });
}
export function finishCriterion(db, job, error = null) {
  db.prepare("UPDATE criterion_jobs SET status=?,completed=?,error=?,lease=NULL WHERE id=? AND token=? AND status='running'")
    .run(error ? 'failed' : 'completed', now(), error, job.id, job.token);
}
export async function saveCriterionProgress(db, job, manifest, root) {
  const hospital = criterionHospital(job.hospital);
  if (manifest.hospital?.id !== hospital.id || manifest.requested?.length !== 1 || manifest.requested[0] !== job.step)
    throw Error("Criterion identity mismatch");
  const outputs = [];
  for (const [id, entry] of Object.entries(manifest.steps)) {
    if (!stepIds.includes(id) || !['succeeded','reused'].includes(entry.status)) continue;
    const path = resolve(entry.path), rel = relative(resolve(root), path);
    if (isAbsolute(rel) || rel === '..' || rel.startsWith('..\\') || rel.startsWith('../')) throw Error("Invalid evidence path");
    const result = JSON.parse(await readFile(path, 'utf8'));
    if (result.hospital?.id !== hospital.id || result.hospital?.financialAssistanceUrl !== hospital.financialAssistanceUrl ||
        result.criterion !== steps[id].criterion || ![true,false,null].includes(result.value)) throw Error("Invalid criterion result");
    const output = { value: result.value, explanation: result.explanation ?? '',
      evidence: (result.evidence ?? []).map(e => ({ sourceUrl: e.sourceUrl, quote: e.quote, locator: e.locator,
        retrievedAt: e.retrievedAt, sha256: e.sha256 ?? e.snapshot_id })),
      limitations: result.limitations ?? result.gaps ?? [], scope: result.scope ?? '', run_id: result.runId };
    outputs.push({ id, output, reused: entry.status === 'reused' });
  }
  transaction(db, () => {
    const update = db.prepare("UPDATE criterion_jobs SET progress=? WHERE id=? AND token=? AND status='running'")
      .run(JSON.stringify(manifest.steps), job.id, job.token);
    if (!update.changes) return;
    for (const { id, output, reused } of outputs) {
      if (reused && db.prepare("SELECT job FROM criterion_results WHERE hospital=? AND step=?").get(job.hospital, id)) continue;
      db.prepare(`INSERT INTO criterion_results VALUES(?,?,?,?,?) ON CONFLICT(hospital,step)
        DO UPDATE SET job=excluded.job,completed=excluded.completed,output=excluded.output`)
        .run(job.hospital, id, job.id, now(), JSON.stringify(output));
    }
  });
}
