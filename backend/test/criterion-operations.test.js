import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {randomUUID} from 'node:crypto';

test('operations reads requirement checks and decisions from the same database without writes',async t=>{
  const root=mkdtempSync(join(tmpdir(),'SYN-criterion-operations-'));
  process.env.AUDIT_DIR=root;
  const {openStore}=await import('../audit/store.js');
  const {installCriteria,enqueueCriterion,claimCriterion,finishCriterion,criterionStatus,decideCriterion}=await import('../audit/criterion-service.js');
  const {handler}=await import('../src/handler.js');
  const db=openStore();installCriteria(db);t.after(()=>db.close());
  const get=async()=>{
    const result=await handler({rawPath:'/api/pilot/v1/operations',requestContext:{http:{method:'GET'}}});
    assert.equal(result.statusCode,200,result.body);return JSON.parse(result.body);
  };
  const input={request_key:randomUUID(),approved_steps:['k1','k12'],rerun:false};
  enqueueCriterion(db,'1002','all',input,{requested:['k1','k12'],run:['k1','k12']});
  let response=await get(),row=response.items.find(h=>h.hospital_key==='1002');
  assert.equal(response.criterion_runs,1);assert.equal(row.latest.status,'queued');
  assert.equal(row.clocks.last_attempted,null);assert.equal(row.cost_status,'not_recorded');
  const job=claimCriterion(db);
  for(const [step,value] of [['k1',true],['k12',null]])db.prepare('INSERT INTO criterion_results VALUES(?,?,?,?,?)')
    .run('1002',step,job.id,'2026-11-12T12:00:00.000Z',JSON.stringify({value,evidence:[{sourceUrl:'https://example.org/SYN.pdf',retrievedAt:'2026-11-01T12:00:00.000Z'}],limitations:[]}));
  finishCriterion(db,job);
  row=(await get()).items.find(h=>h.hospital_key==='1002');
  assert.equal(row.latest.status,'completed');assert.ok(row.clocks.last_attempted);
  assert.ok(row.clocks.last_completed_execution);assert.equal(row.clocks.next_due_at,null);
  assert.equal(row.clocks.last_successful_source_retrieval,'2026-11-01T12:00:00.000Z');
  assert.deepEqual(row.criterion.summary,criterionStatus(db,'1002').summary);
  assert.equal(row.criterion.summary.confirmed,1);assert.equal(row.criterion.summary.unclear,1);
  const item=criterionStatus(db,'1002').items.find(i=>i.id==='k12');
  decideCriterion(db,'1002','k12',{request_key:randomUUID(),revision:item.revision,decision:'unmet',reason:'SYN reviewed',evidence:'SYN page 1'});
  row=(await get()).items.find(h=>h.hospital_key==='1002');
  assert.equal(row.criterion.summary.confirmed,2);assert.equal(row.criterion.summary.unclear,0);
  enqueueCriterion(db,'1002','k12',{...input,request_key:randomUUID(),rerun:true},{run:['k1','k12']});
  const interrupted=claimCriterion(db);
  db.prepare('UPDATE criterion_jobs SET lease=1 WHERE id=?').run(interrupted.id);
  const before=db.prepare('SELECT * FROM criterion_jobs WHERE id=?').get(interrupted.id);
  row=(await get()).items.find(h=>h.hospital_key==='1002');
  assert.equal(row.latest.status,'failed');assert.equal(row.criterion.summary.unclear,0);assert.equal(row.criterion.summary.confirmed,2);
  assert.deepEqual(db.prepare('SELECT * FROM criterion_jobs WHERE id=?').get(interrupted.id),before);
  assert.equal(JSON.stringify(row).includes(root),false);
  assert.equal((await get()).items.find(h=>h.hospital_key==='739').criterion,null);
});

test('older history is retained and a newer check never inherits an old receipt',async()=>{
  const {combineOperations}=await import('../audit/criterion-operations.js');
  const legacy={latest:{queued_at:'2026-01-01T00:00:00Z',status:'completed'},cost_status:'complete',clocks:{last_attempted:'2026-01-01T00:00:00Z',next_due_at:'2026-02-01T00:00:00Z'}};
  const current={latest:{queued_at:'2026-03-01T00:00:00Z',status:'failed'},clocks:{},summary:{confirmed:0}};
  const row=combineOperations(legacy,current);
  assert.equal(row.latest,current.latest);assert.equal(row.cost_status,'not_recorded');
  assert.equal(row.clocks.next_due_at,null);assert.deepEqual(row.legacy.latest,legacy.latest);
  assert.equal(combineOperations({...legacy,latest:{...legacy.latest,queued_at:'2026-04-01T00:00:00Z'}},current).cost_status,'complete');
});
