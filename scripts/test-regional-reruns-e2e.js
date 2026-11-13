// SYNTHETIC saved results and queue only. No audit worker or model calls.
import assert from 'node:assert/strict';
import {spawn} from 'node:child_process';
import {mkdirSync,mkdtempSync} from 'node:fs';
import {resolve} from 'node:path';
import {chromium} from 'playwright';
const root=mkdtempSync(resolve('.audit/SYN-regional-reruns-'));
process.env.AUDIT_DIR=root;process.env.T2P_REVIEW_DIRECTORY=root;
const {openStore}=await import('../backend/audit/store.js');
const {installCriteria}=await import('../backend/audit/criterion-service.js');
const {installRegional,regionalStats}=await import('../backend/audit/regional-criteria.js');
const db=openStore();installCriteria(db);installRegional(db);
const rows=regionalStats(db).hospitals.filter(h=>['NYC Metro','Central'].includes(h.region));
for(const [index,h] of rows.entries())db.prepare('INSERT INTO criterion_results VALUES(?,?,?,?,?)').run(h.hospital_key,'k1','SYN-prior','2026-01-01T00:00:00Z',JSON.stringify({synthetic:true,value:index<8?null:index%2===0,evidence:[],limitations:[]}));
const savedBefore=db.prepare('SELECT * FROM criterion_results ORDER BY hospital,step').all();
const origin='http://127.0.0.1:8196',output='.audit/ui/regional-reruns';mkdirSync(output,{recursive:true});
const server=spawn(process.execPath,['backend/src/local-server.js'],{env:{...process.env,PORT:'8196'},stdio:['ignore','pipe','inherit']});
let browser;
try{
 await new Promise((resolve,reject)=>{server.stdout.once('data',resolve);server.once('error',reject);});
 browser=await chromium.launch();
 for(const language of ['en','es'])for(const width of [1440,390]){
  const context=await browser.newContext({viewport:{width,height:1000}}),page=await context.newPage(),errors=[];
  page.on('pageerror',e=>errors.push(e.message));
  await page.goto(`${origin}/?view=regional&lang=${language}`);
  await page.locator('.regional-checklist input').nth(16).waitFor();
  assert.equal(await page.locator('.regional-run-mode select').inputValue(),'missing');
  const jobCount=db.prepare('SELECT count(*) n FROM criterion_jobs').get().n;
  async function preview(click){
   const response=page.waitForResponse(r=>r.url().endsWith('/regions/preview')&&r.request().method()==='POST');
   await click();const r=await response;assert.equal(r.status(),200);return r.json();
  }
  const empty=await preview(()=>page.locator('button.regional-primary').click());
  assert.equal(empty.plan.jobs,0);
  assert.equal(await page.locator('.regional-preview .regional-primary').isDisabled(),true);
  await page.locator('.regional-preview').screenshot({path:`${output}/saved-rerun-options-${language}-${width}.png`});
  const retry=await preview(()=>page.getByRole('button',{name:language==='en'?'Preview retry of errors and unclear results':'Ver plan para reintentar errores y resultados sin resolver',exact:true}).click());
  assert.equal(retry.selection.mode,'retry');assert.equal(retry.plan.jobs,8);
  assert.equal(db.prepare('SELECT count(*) n FROM criterion_jobs').get().n,jobCount);
  await page.reload();await page.locator('.regional-preview').waitFor();
  assert.equal(await page.locator('.regional-run-mode select').inputValue(),'retry');
  async function approveAndCancel(expected){
   const start=page.waitForResponse(r=>r.url().endsWith('/start')&&r.request().method()==='POST');
   await page.locator('.regional-preview .regional-primary').click();const response=await start;assert.equal(response.status(),202);
   const batch=await response.json();assert.equal(batch.jobs.length,expected);
   const cancel=page.waitForResponse(r=>r.url().endsWith('/cancel')&&r.request().method()==='POST');
   await page.locator('.regional-batch button').click();assert.equal((await cancel).status(),200);
   await page.locator('.regional-batch button').waitFor({state:'detached'});
   assert.equal(db.prepare("SELECT count(*) n FROM criterion_jobs WHERE status='queued'").get().n,0);
  }
  await approveAndCancel(8);
  await page.locator('.regional-run-mode select').selectOption('all');
  const all=await preview(()=>page.locator('button.regional-primary').click());
  assert.equal(all.plan.jobs,82);assert.equal(all.selection.mode,'all');
  assert.ok(all.plan.hospitals.every(h=>JSON.stringify(h.requested)==='["k1"]'));
  await page.locator('.regional-preview').screenshot({path:`${output}/all-rerun-preview-${language}-${width}.png`});
  assert.equal(await page.evaluate(()=>document.documentElement.scrollWidth>innerWidth),false);
  await approveAndCancel(82);
  assert.deepEqual(db.prepare('SELECT * FROM criterion_results ORDER BY hospital,step').all(),savedBefore);
  assert.deepEqual(errors,[]);await context.close();
 }
 console.log('Regional reruns passed four bilingual desktop/mobile scenarios: fully saved 82-hospital scope, free retry/all previews, reload preservation, explicit approvals, cancellation and retained findings. Zero model calls.');
}finally{await browser?.close();server.kill();db.close();}
