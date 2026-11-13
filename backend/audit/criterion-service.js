import { readFileSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { resolve, relative, isAbsolute } from "node:path";
import { randomUUID, createHash } from "node:crypto";
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
      output TEXT NOT NULL, PRIMARY KEY(hospital,step));
    CREATE TABLE IF NOT EXISTS criterion_decisions (
      id INTEGER PRIMARY KEY, request_key TEXT UNIQUE NOT NULL, hospital TEXT NOT NULL, step TEXT NOT NULL,
      revision TEXT NOT NULL, decision TEXT NOT NULL, reason TEXT NOT NULL, evidence TEXT NOT NULL,
      decided_at TEXT NOT NULL, snapshot TEXT NOT NULL);
    CREATE INDEX IF NOT EXISTS criterion_decision_history ON criterion_decisions(hospital,step,id);
    CREATE TRIGGER IF NOT EXISTS criterion_decisions_no_update BEFORE UPDATE ON criterion_decisions
      BEGIN SELECT RAISE(ABORT,'immutable decision'); END;
    CREATE TRIGGER IF NOT EXISTS criterion_decisions_no_delete BEFORE DELETE ON criterion_decisions
      BEGIN SELECT RAISE(ABORT,'immutable decision'); END;`);
  if (!db.prepare('PRAGMA table_info(criterion_jobs)').all().some(c => c.name === 'requested'))
    db.exec('ALTER TABLE criterion_jobs ADD COLUMN requested TEXT');
}
export const requestedSteps = job => job.requested ? JSON.parse(job.requested) : [job.step];
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
  const selected = Array.isArray(requested) ? requested : [requested];
  selected.forEach(validateStep);
  const run = [], reuse = [], seen = new Set();
  async function visit(id) {
    if (seen.has(id)) return;
    seen.add(id);
    if (!selected.includes(id) && await find(root, hospital, steps[id])) { reuse.push(id); return; }
    for (const dependency of steps[id].dependencies) await visit(dependency);
    run.push(id);
  }
  for (const id of selected) await visit(id);
  return { requested, run, reuse, model: "us.amazon.nova-micro-v1:0", max_model_calls: 40, timeout_minutes: 20 };
}
export async function missingCriteriaPlan(db, root, hospital, key) {
  const saved = new Set(db.prepare('SELECT step FROM criterion_results WHERE hospital=?').all(key).map(r => r.step));
  return criterionPlan(root, hospital, stepIds.filter(id => !saved.has(id)));
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
    started: row.started, completed: row.completed, error: row.error, requested: requestedSteps(row),
    progress: Object.fromEntries(Object.entries(progress).map(([id, entry]) => [id, { status: entry.status }])) };
}
export function criterionStatus(db, hospital, {readOnly = false} = {}) {
  if (!readOnly) expireCriteria(db);
  const jobs = db.prepare("SELECT * FROM criterion_jobs WHERE hospital=? ORDER BY created DESC, rowid DESC").all(hospital)
    .map(job => readOnly && job.status==='running' && job.lease != null && job.lease<=Date.now()
      ? {...job,status:'failed',completed:new Date(job.lease).toISOString(),error:'interrupted'} : job);
  const results = db.prepare("SELECT * FROM criterion_results WHERE hospital=?").all(hospital);
  const decisions = db.prepare("SELECT 1 FROM sqlite_master WHERE name='criterion_decisions'").get()
    ? db.prepare('SELECT * FROM criterion_decisions WHERE hospital=? ORDER BY id DESC').all(hospital) : [];
  const items = stepIds.map(id => {
      const saved = results.find(r => r.step === id);
       const latest = jobs.find(j => j.status!=='cancelled' && (requestedSteps(j).includes(id) || ['running','failed','succeeded'].includes(JSON.parse(j.progress)[id]?.status)));
      const result = saved ? { job: saved.job, completed: saved.completed, ...JSON.parse(saved.output) } : null;
       const progressStatus = latest && JSON.parse(latest.progress)[id]?.status;
       const failed = (progressStatus === 'failed' || latest?.status === 'failed' && !['succeeded','reused'].includes(progressStatus)) &&
        (!saved || latest.created >= saved.completed || latest.id === saved.job);
       const revision = saved || failed ? createHash('sha256').update(JSON.stringify([saved?.job, saved?.output, failed && !saved ? latest.id : null])).digest('hex') : null;
      const currentId = decisions.find(d => d.step === id && d.revision === revision)?.id;
      const history = decisions.filter(d => d.step === id).map(d => ({ id:d.id, decision:d.decision, reason:d.reason, evidence:d.evidence,
        decided_at:d.decided_at, current:d.id === currentId, reviewed_result:JSON.parse(d.snapshot) }));
      const decision = history.find(d => d.current) ?? null;
       const effective = decision?.decision ?? (result ? (result.value === true ? 'met' : result.value === false ? 'unmet' : 'unclear') : failed ? 'error' : 'unrun');
      const updated_at = decision?.decided_at ?? (failed ? latest.completed : saved?.completed) ?? null;
      return { id, title: titles.get(steps[id].criterion), criterion: steps[id].criterion,
         latest: publicJob(latest), saved:result, revision, effective, technical_error:!!failed, updated_at, decision, history };
    });
   const summary = { met:0, unmet:0, unclear:0, unrun:0, error:0, confirmed:0, total:17, updated_at:null };
  for (const item of items) {
    summary[item.effective]++;
    if (item.updated_at && (!summary.updated_at || item.updated_at > summary.updated_at)) summary.updated_at = item.updated_at;
  }
  summary.confirmed = summary.met + summary.unmet;
  return { hospital_key:hospital, active:publicJob(jobs.find(j => ['queued','running'].includes(j.status))), items, summary };
}
export function enqueueCriterion(db, hospital, step, input, plan) {
  if (step !== 'all') validateStep(step);
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
    if (step === 'all' && !plan.requested.length) fail(409, 'No missing criteria remain.');
    if (!input.rerun && db.prepare("SELECT job FROM criterion_results WHERE hospital=? AND step=?").get(hospital, step))
      fail(409, "A saved result exists. Choose Run again explicitly.");
    if (plan.run.some(id => !input.approved_steps.includes(id))) fail(409, "Preparation changed. Review the new run plan.");
    const id = randomUUID();
    db.prepare("INSERT INTO criterion_jobs(id,request_key,hospital,step,approved,status,created,requested) VALUES(?,?,?,?,?,'queued',?,?)")
      .run(id, input.request_key, hospital, step, JSON.stringify(plan.run), now(), JSON.stringify(step === 'all' ? plan.requested : [step]));
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
  if (manifest.hospital?.id !== hospital.id || JSON.stringify(manifest.requested) !== JSON.stringify(requestedSteps(job)))
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
      const previous = db.prepare("SELECT job,output FROM criterion_results WHERE hospital=? AND step=?").get(job.hospital, id);
      if (previous && (reused || (previous.job === job.id && previous.output === JSON.stringify(output)))) continue;
      db.prepare(`INSERT INTO criterion_results VALUES(?,?,?,?,?) ON CONFLICT(hospital,step)
        DO UPDATE SET job=excluded.job,completed=excluded.completed,output=excluded.output`)
        .run(job.hospital, id, job.id, now(), JSON.stringify(output));
    }
  });
}

export function decideCriterion(db, hospital, step, input) {
  validateStep(step);
  if (!input || !/^[a-f0-9-]{36}$/.test(input.request_key ?? '') || !/^[a-f0-9]{64}$/.test(input.revision ?? '') ||
      !['met','unmet','unclear'].includes(input.decision) || typeof input.reason !== 'string' || !input.reason.trim() || input.reason.length > 2000 ||
      typeof input.evidence !== 'string' || input.evidence.length > 4000 || (input.decision !== 'unclear' && !input.evidence.trim()))
    fail(400, 'A decision, reason and supporting evidence are required.');
  return transaction(db, () => {
    const existing = db.prepare('SELECT * FROM criterion_decisions WHERE request_key=?').get(input.request_key);
    if (existing) {
      if (existing.hospital !== hospital || existing.step !== step || existing.revision !== input.revision || existing.decision !== input.decision || existing.reason !== input.reason.trim() || existing.evidence !== input.evidence.trim())
        fail(409,'Decision request key already used.');
      return {id:existing.id, decided_at:existing.decided_at};
    }
    const status = criterionStatus(db, hospital), item = status.items.find(i => i.id === step);
    if (status.active) fail(409,'Wait for the active audit before deciding.');
    if (!item.revision || item.revision !== input.revision) fail(409,'Evidence changed. Refresh and review it again.');
    const decided_at = now();
    const row = db.prepare('INSERT INTO criterion_decisions(request_key,hospital,step,revision,decision,reason,evidence,decided_at,snapshot) VALUES(?,?,?,?,?,?,?,?,?)')
      .run(input.request_key,hospital,step,item.revision,input.decision,input.reason.trim(),input.evidence.trim(),decided_at,
        JSON.stringify({saved:item.saved, failure:item.latest?.error ?? null}));
    return {id:Number(row.lastInsertRowid), decided_at};
  });
}

export function criterionOverview(db) {
  expireCriteria(db);
  const keys = db.prepare('SELECT hospital FROM criterion_jobs UNION SELECT hospital FROM criterion_results').all();
  const hospitals = {}, reviews = [], activity = {};
  for (const {hospital} of keys) {
    const status = criterionStatus(db,hospital);
    hospitals[hospital] = status.summary;
    const latest=db.prepare('SELECT status,completed FROM criterion_jobs WHERE hospital=? ORDER BY created DESC,rowid DESC LIMIT 1').get(hospital);
    activity[hospital]={status:status.active?.status ?? (status.items.some(i=>i.technical_error) ? 'error' : status.summary.unclear ? 'attention' : latest?.status==='completed' ? 'completed' : latest?.status ?? 'idle'),updated_at:latest?.completed??null};
    for (const item of status.items.filter(i => i.effective === 'unclear' || i.technical_error && !i.decision)) reviews.push({
      hospital_key:hospital, hospital_name:criterionHospital(hospital).name, step:item.id, title:item.title,
      updated_at:item.updated_at, revision:item.revision, technical_error:item.technical_error, effective:item.effective,
    });
  }
  return {hospitals, reviews, pending:reviews.length, activity};
}
