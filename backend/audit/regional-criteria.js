import {createHash,randomUUID} from 'node:crypto';
import {readFileSync} from 'node:fs';
import {roster} from './roster-inventory.js';
import {transaction,now} from './store.js';
import {criterionStatus,criterionHospital,criterionPlan,expireCriteria,validateStep} from './criterion-service.js';

const reference=JSON.parse(readFileSync(new URL('../../references/ny-rating-regions-v1.json',import.meta.url)));
const current=roster.filter(f=>f.properties.current_directory!==false);
const ids=Array.from({length:17},(_,i)=>`k${i+1}`);
// Bound requests to the known roster, not an arbitrary ten-hospital slice.
export const regionalLimit=current.length;
const fail=(status,message)=>{throw Object.assign(Error(message),{status});};
export function installRegional(db){
 db.exec(`CREATE TABLE IF NOT EXISTS criterion_batches(id TEXT PRIMARY KEY,created TEXT NOT NULL,selection TEXT NOT NULL,plan TEXT NOT NULL,started TEXT,cancelled TEXT);
 CREATE TABLE IF NOT EXISTS criterion_batch_jobs(batch TEXT NOT NULL,job TEXT UNIQUE NOT NULL,hospital TEXT NOT NULL,PRIMARY KEY(batch,hospital));`);
}
function selectionFor(input){
 if(!input || !Array.isArray(input.regions)||input.regions.length!==2||new Set(input.regions).size!==2||input.regions.some(r=>!Object.hasOwn(reference.regions,r))||
 !Array.isArray(input.steps)||!input.steps.length||input.steps.length>17||new Set(input.steps).size!==input.steps.length)fail(400,'Invalid regional selection.');
 const hospitals=input.hospitals===undefined ? current.filter(f=>input.regions.includes(f.properties.region)).map(f=>f.id) : input.hospitals;
 if(!Array.isArray(hospitals)||!hospitals.length||hospitals.length>regionalLimit||new Set(hospitals).size!==hospitals.length)fail(400,'Invalid hospital selection.');
 input.steps.forEach(validateStep);
 const mode=input.mode??'missing';
 if(!['missing','retry','all'].includes(mode))fail(400,'Invalid check mode.');
 for(const key of hospitals)if(!current.some(f=>f.id===key&&input.regions.includes(f.properties.region)))fail(400,'Hospital is outside the selected regions.');
  return {regions:input.regions,steps:ids.filter(id=>input.steps.includes(id)),hospitals:[...hospitals].sort(),scope:input.hospitals===undefined?'all':'custom',mode};
}
const signature=(db,key)=>createHash('sha256').update(JSON.stringify([
 db.prepare('SELECT step,job,completed,output FROM criterion_results WHERE hospital=? ORDER BY step').all(key),
 db.prepare('SELECT id,status,progress,completed FROM criterion_jobs WHERE hospital=? ORDER BY rowid').all(key),
 db.prepare('SELECT id FROM criterion_decisions WHERE hospital=? ORDER BY id').all(key),
])).digest('hex');
function busy(db,key){return db.prepare("SELECT id FROM criterion_jobs WHERE hospital=? AND status IN ('queued','running')").get(key)||db.prepare("SELECT id FROM jobs WHERE hospital=? AND status IN ('queued','running')").get(key);}
async function planSelection(db,root,selection,planner){
 expireCriteria(db);
 const hospitals=[];
 for(const key of selection.hospitals){
  if(busy(db,key))fail(409,'A selected hospital already has an active check.');
  const version=signature(db,key);
   const items=criterionStatus(db,key,{readOnly:true}).items;
   const requested=selection.steps.filter(id=>{
    const item=items.find(i=>i.id===id);
    return selection.mode==='all'||(selection.mode==='retry'?(item.technical_error||item.effective==='unclear'):!item.saved);
   });
  const plan=await planner(root,criterionHospital(key),requested);
  const feature=current.find(f=>f.id===key);
  hospitals.push({hospital_key:key,name:feature.properties.name,region:feature.properties.region,requested,run:plan.run,reuse:plan.reuse,version});
 }
 return {hospitals,checks:hospitals.reduce((n,h)=>n+h.requested.length,0),jobs:hospitals.filter(h=>h.requested.length).length,
  max_model_calls:hospitals.filter(h=>h.requested.length).length*40,max_model_calls_per_hospital:40,timeout_minutes_per_hospital:20,model:'us.amazon.nova-micro-v1:0'};
}
export async function previewRegional(db,root,input,planner=criterionPlan){
 const selection=selectionFor(input),plan=await planSelection(db,root,selection,planner),id=randomUUID();
 db.prepare('INSERT INTO criterion_batches(id,created,selection,plan) VALUES(?,?,?,?)').run(id,now(),JSON.stringify(selection),JSON.stringify(plan));
 return {id,selection,plan};
}
export function regionalBatch(db,id){
 const row=db.prepare('SELECT * FROM criterion_batches WHERE id=?').get(id);if(!row)fail(404,'Batch not found.');
 const jobs=db.prepare('SELECT j.id,j.hospital,j.status,j.started,j.completed,j.requested FROM criterion_batch_jobs b JOIN criterion_jobs j ON j.id=b.job WHERE b.batch=?').all(id);
 return {id,created:row.created,started:row.started,cancelled:row.cancelled,selection:JSON.parse(row.selection),plan:JSON.parse(row.plan),jobs:jobs.map(j=>({...j,requested:JSON.parse(j.requested)}))};
}
export async function startRegional(db,root,id,planner=criterionPlan){
 let batch=regionalBatch(db,id);
 if(batch.started)return batch;
 if(batch.cancelled)fail(409,'Batch was cancelled.');
 if(Date.now()-Date.parse(batch.created)>15*60*1000)fail(409,'Preview expired. Prepare a new preview.');
 let fresh;
 try{fresh=await planSelection(db,root,batch.selection,planner);}
 catch(error){const submitted=regionalBatch(db,id);if(submitted.started)return submitted;throw error;}
 const submitted=regionalBatch(db,id);if(submitted.started)return submitted;
 if(JSON.stringify(fresh)!==JSON.stringify(batch.plan))fail(409,'Saved evidence or preparation changed. Prepare a new preview.');
 return transaction(db,()=>{
  batch=regionalBatch(db,id);if(batch.started)return batch;
  if(batch.cancelled)fail(409,'Batch was cancelled.');
  for(const h of fresh.hospitals)if(busy(db,h.hospital_key)||signature(db,h.hospital_key)!==h.version)fail(409,'Hospital state changed. Prepare a new preview.');
   if(!fresh.jobs)fail(409,'No requirements match this check mode.');
  for(const h of fresh.hospitals.filter(h=>h.requested.length)){
   const job=randomUUID();
   db.prepare("INSERT INTO criterion_jobs(id,request_key,hospital,step,approved,status,created,requested) VALUES(?,?,?,'all',?,'queued',?,?)")
    .run(job,job,h.hospital_key,JSON.stringify(h.run),now(),JSON.stringify(h.requested));
   db.prepare('INSERT INTO criterion_requests VALUES(?,?)').run(job,job);
   db.prepare('INSERT INTO criterion_batch_jobs VALUES(?,?,?)').run(id,job,h.hospital_key);
  }
  db.prepare('UPDATE criterion_batches SET started=? WHERE id=?').run(now(),id);
  return regionalBatch(db,id);
 });
}
export function cancelRegional(db,id){return transaction(db,()=>{
 regionalBatch(db,id);
 db.prepare("UPDATE criterion_jobs SET status='cancelled',completed=? WHERE status='queued' AND id IN (SELECT job FROM criterion_batch_jobs WHERE batch=?)").run(now(),id);
 db.prepare('UPDATE criterion_batches SET cancelled=COALESCE(cancelled,?) WHERE id=?').run(now(),id);
 return regionalBatch(db,id);
});}
export function regionalStats(db){
 expireCriteria(db);
 const hospitals=current.map(f=>{
  const status=criterionStatus(db,f.id,{readOnly:true});
  return {hospital_key:f.id,name:f.properties.name,region:f.properties.region,summary:status.summary,active:status.active,
    items:status.items.map(i=>({id:i.id,title:i.title,effective:i.effective,technical_error:i.technical_error,updated_at:i.updated_at,saved:!!i.saved}))};
 });
 const regions=Object.keys(reference.regions).map(region=>{
  const rows=hospitals.filter(h=>h.region===region);
  return {region,total:rows.length,items:ids.map(id=>{
    const counts={met:0,unmet:0,unclear:0,unrun:0,error:0,updated_at:null};
   for(const h of rows){const item=h.items.find(i=>i.id===id);counts[item.effective]++;if(item.updated_at&&(!counts.updated_at||item.updated_at>counts.updated_at))counts.updated_at=item.updated_at;}
    return {id,...counts,confirmed:counts.met+counts.unmet,checked:rows.length-counts.unrun-counts.error};
  })};
 });
 return {regions,hospitals,max_hospitals_per_batch:regionalLimit,batches:db.prepare('SELECT id FROM criterion_batches WHERE started IS NOT NULL ORDER BY created DESC LIMIT 20').all().map(r=>regionalBatch(db,r.id))};
}
