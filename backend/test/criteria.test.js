import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, writeFile, mkdir } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { randomUUID } from 'node:crypto';
import { fork } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { openStore } from '../audit/store.js';
import { installCriteria, criterionHospital, criterionPlan, enqueueCriterion, claimCriterion,
  criterionStatus, finishCriterion, saveCriterionProgress, missingCriteriaPlan, decideCriterion, criterionOverview } from '../audit/criterion-service.js';
import { runAudit } from '../../agents/runner.ts';
import { steps } from '../../agents/steps.ts';
import { workCriterion } from '../audit/criterion-worker.js';

const hospitalKey = '1002';
const hospital = criterionHospital(hospitalKey);
const request = (approved_steps, rerun = false) => ({ request_key: randomUUID(), approved_steps, rerun });
async function store(t) {
  const root = await mkdtemp(join(process.env.TEMP || tmpdir(), 't2p-criteria-SYN-'));
  const db = openStore(root); installCriteria(db); t.after(() => db.close());
  return { db, root };
}
test('plans contain only the requested criterion and missing dependencies', async () => {
  const missing = async () => undefined;
  assert.deepEqual((await criterionPlan('', hospital, 'k12', missing)).run, ['k1','k12']);
  assert.deepEqual((await criterionPlan('', hospital, 'k16', missing)).run, ['k1','k2','k16']);
  const cached = await criterionPlan('', hospital, 'k16', async (_r, _h, step) => step === steps.k2 ? {} : undefined);
  assert.deepEqual(cached.run, ['k16']); assert.deepEqual(cached.reuse, ['k2']);
  await assert.rejects(criterionPlan('', hospital, 'k18', missing));
});
test('duplicates, cross-tab requests and explicit reruns cannot launch unapproved work', async t => {
  const { db } = await store(t);
  const plan = { run: ['k1','k12'] }, input = request(plan.run);
  assert.throws(() => enqueueCriterion(db, hospitalKey, 'k12', request(['k12']), plan), /Preparation changed/);
  const first = enqueueCriterion(db, hospitalKey, 'k12', input, plan);
  assert.equal(enqueueCriterion(db, hospitalKey, 'k12', input, plan).id, first.id);
  const otherTab = request(plan.run, true);
  assert.equal(enqueueCriterion(db, hospitalKey, 'k12', otherTab, plan).id, first.id);
  assert.throws(() => enqueueCriterion(db, hospitalKey, 'k10', request(['k1','k10']), {run:['k1','k10']}), /already running/);
  const claimed = claimCriterion(db); assert.equal(claimCriterion(db), null);
  finishCriterion(db, claimed);
  assert.equal(enqueueCriterion(db, hospitalKey, 'k12', otherTab, plan).id, first.id);
  assert.equal(enqueueCriterion(db, hospitalKey, 'k12', input, plan).id, first.id);
  db.prepare('INSERT INTO criterion_results VALUES(?,?,?,?,?)').run(hospitalKey,'k12',first.id,new Date().toISOString(),JSON.stringify({ value: null }));
  assert.throws(() => enqueueCriterion(db, hospitalKey, 'k12', request(plan.run), plan), /Run again/);
  assert.notEqual(enqueueCriterion(db, hospitalKey, 'k12', request(plan.run, true), plan).id, first.id);
});
test('an interrupted paid run fails without automatically requeuing', async t => {
  const { db } = await store(t);
  enqueueCriterion(db, hospitalKey, 'k1', request(['k1']), {run:['k1']});
  const job = claimCriterion(db);
  db.prepare('UPDATE criterion_jobs SET lease=0 WHERE id=?').run(job.id);
  assert.equal(claimCriterion(db), null);
  const row = criterionStatus(db, hospitalKey);
  assert.equal(row.active, null); assert.equal(row.items[0].latest.status, 'failed');
  assert.equal(row.items[0].latest.error, 'interrupted');
  assert.equal(row.items[0].saved, null);
});
test('runner checkpoints publish scoped results and keep unresolved findings unresolved', async t => {
  const { db, root } = await store(t);
  enqueueCriterion(db, hospitalKey, 'k12', request(['k1','k12']), {run:['k1','k12']});
  const job = claimCriterion(db), called = [];
  const registry = { ...steps };
  for (const id of ['k1','k12']) registry[id] = { ...steps[id], run: async () => {
    called.push(id);
    const directory = join(root, 'agents', steps[id].key, 'SYN-test'); await mkdir(directory, { recursive: true });
    const path = join(directory, 'result.json');
    const result = { synthetic: true, runId: 'SYN-test', hospital, criterion: steps[id].criterion,
      value: id === 'k1' ? true : null, explanation: 'Synthetic fixture; human review required.',
      evidence: [{ sourceUrl: 'https://example.org/SYN-form.pdf', quote: 'SYNTHETIC SOURCE', locator: 'PDF page 1' }],
      limitations: ['Synthetic test only'] };
    await writeFile(path, JSON.stringify(result));
    return { ...result, path };
  } };
  await runAudit(hospital, { requested:['k12'], approvedSteps:['k1','k12'], auditRoot:root }, {
    registry, find: async () => undefined, log: () => {}, checkpoint: m => saveCriterionProgress(db, job, m, root),
  });
  finishCriterion(db, job);
  const result = criterionStatus(db, hospitalKey);
  assert.deepEqual(called, ['k1','k12']); assert.equal(result.items.length, 17);
  assert.equal(result.items[11].saved.value, null);
  assert.equal(result.items[11].saved.evidence[0].quote, 'SYNTHETIC SOURCE');
  assert.equal(result.items[10].saved, null);
  assert.equal(JSON.stringify(result).includes(root), false);
  assert.equal(result.items[11].latest.status, 'completed');
});
test('disappearing prerequisites stop the runner before unapproved model work', async t => {
  const { root } = await store(t);
  let calls = 0;
  const registry = { ...steps, k1: { ...steps.k1, run: async () => { calls++; throw Error('must not run'); } } };
  await assert.rejects(runAudit(hospital, { requested:['k12'], approvedSteps:['k12'], auditRoot:root }, {
    registry, find:async () => undefined, log:() => {},
  }), /Preparation changed/);
  assert.equal(calls, 0);
});
test('saved evidence cannot cross hospital identities or escape the evidence root', async t => {
  const { db, root } = await store(t);
  enqueueCriterion(db, hospitalKey, 'k1', request(['k1']), {run:['k1']});
  const job = claimCriterion(db);
  const manifest = { hospital, requested:['k1'], steps:{k1:{status:'succeeded',path:join(root,'..','elsewhere.json')}} };
  await assert.rejects(saveCriterionProgress(db, job, manifest, root), /Invalid evidence path/);
  await assert.rejects(saveCriterionProgress(db, job, {...manifest,hospital:{id:'SYN-other'}}, root), /identity mismatch/);
});
test('background subprocess checkpoints are published before completing the job', async t => {
  const { db, root } = await store(t);
  enqueueCriterion(db,hospitalKey,'k12',request(['k1','k12']),{run:['k1','k12']});
  const launch = (_path,args,options) => fork(fileURLToPath(new URL('./fixtures/criterion-child.js',import.meta.url)),args,options);
  assert.equal(await workCriterion(db,root,{launch}),true);
  const status = criterionStatus(db,hospitalKey);
  assert.equal(status.items[11].latest.status,'completed');
  assert.equal(status.items[11].saved.explanation,'SYNTHETIC worker result');
  assert.equal(status.items[0].saved.value,true);
  assert.equal(await workCriterion(db,root,{launch}),false);
});
test('real child validation failure terminates without a model call or automatic retry', async t => {
  const { db, root } = await store(t);
  const queued = enqueueCriterion(db,hospitalKey,'k1',request(['k1']),{run:['k1']});
  db.prepare("UPDATE criterion_jobs SET step='k18',requested='[\"k18\"]' WHERE id=?").run(queued.id);
  assert.equal(await workCriterion(db,root),true);
  const row = db.prepare('SELECT status,error FROM criterion_jobs WHERE id=?').get(queued.id);
  assert.equal(row.status,'failed'); assert.equal(row.error,'execution_failed');
  assert.equal(await workCriterion(db,root),false);
});
test('batch worker completes multiple requested criteria with synthetic checkpoints', async t => {
  const {db,root}=await store(t);
  const plan={requested:['k1','k12'],run:['k1','k12']};
  enqueueCriterion(db,hospitalKey,'all',request(plan.run),plan);
  const launch=(_path,args,options)=>fork(fileURLToPath(new URL('./fixtures/criterion-child.js',import.meta.url)),args,options);
  assert.equal(await workCriterion(db,root,{launch}),true);
  const status=criterionStatus(db,hospitalKey);
  assert.equal(status.active,null);
  assert.equal(status.items[11].latest.status,'completed');
  assert.deepEqual(status.items[11].latest.requested,plan.requested);
  assert.equal(status.summary.met,2);
  assert.equal(status.summary.unrun,15);
});
test('batch scope, partial failure, immutable decisions and reopened notifications', async t => {
  const {db,root}=await store(t);
  const output=JSON.stringify({value:true,run_id:'SYN-saved',evidence:[]});
  db.prepare('INSERT INTO criterion_results VALUES(?,?,?,?,?)').run(hospitalKey,'k17','SYN-prior','2026-01-01T00:00:00.000Z',output);
  const plan=await missingCriteriaPlan(db,root,hospital,hospitalKey);
  assert.equal(plan.requested.length,16);assert.ok(!plan.requested.includes('k17'));
  const input=request(plan.run), queued=enqueueCriterion(db,hospitalKey,'all',input,plan);
  assert.equal(enqueueCriterion(db,hospitalKey,'all',input,plan).id,queued.id);
  const job=claimCriterion(db);
  db.prepare('INSERT INTO criterion_results VALUES(?,?,?,?,?)').run(hospitalKey,'k1',job.id,new Date().toISOString(),output);
  db.prepare('UPDATE criterion_jobs SET progress=? WHERE id=?').run(JSON.stringify({k1:{status:'succeeded'},k2:{status:'failed'}}),job.id);
  finishCriterion(db,job,'execution_failed');
  let status=criterionStatus(db,hospitalKey);
  assert.equal(status.items[0].effective,'met');assert.equal(status.summary.confirmed,2);
  assert.equal(status.summary.unclear,15);
  const item=status.items[1], decision={request_key:randomUUID(),revision:item.revision,decision:'met',reason:'SYN-reviewed',evidence:'https://example.org/SYN page 1'};
  const saved=decideCriterion(db,hospitalKey,'k2',decision);
  assert.ok(Number.isFinite(Date.parse(saved.decided_at)));
  assert.deepEqual(decideCriterion(db,hospitalKey,'k2',decision),saved);
  assert.equal(criterionOverview(db).pending,14);
  assert.equal(criterionStatus(db,hospitalKey).summary.confirmed,3);
  assert.throws(()=>db.prepare('UPDATE criterion_decisions SET reason=?').run('changed'),/immutable/);
  const rerun=enqueueCriterion(db,hospitalKey,'k2',request(['k1','k2'],true),{run:['k1','k2']});
  assert.throws(()=>decideCriterion(db,hospitalKey,'k2',{...decision,request_key:randomUUID()}),/active audit/);
  finishCriterion(db,claimCriterion(db),'execution_failed');
  assert.notEqual(rerun.id,job.id);
  assert.equal(criterionOverview(db).pending,15);
  status=criterionStatus(db,hospitalKey);
  assert.equal(status.items[1].history.length,1);assert.equal(status.items[1].history[0].current,false);
  assert.throws(()=>decideCriterion(db,hospitalKey,'k2',{...decision,request_key:randomUUID()}),/Evidence changed/);
  const unclear={...decision,request_key:randomUUID(),revision:status.items[1].revision,decision:'unclear'};
  decideCriterion(db,hospitalKey,'k2',unclear);
  assert.equal(criterionOverview(db).pending,15);
});
