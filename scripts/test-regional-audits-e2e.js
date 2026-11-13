// Synthetic local queue only: this script starts the web server, never an audit worker.
import assert from 'node:assert/strict';
import {spawn} from 'node:child_process';
import {mkdirSync,mkdtempSync} from 'node:fs';
import {resolve} from 'node:path';
import {chromium} from 'playwright';
const root=mkdtempSync(resolve('.audit/SYN-regional-ui-'));
process.env.AUDIT_DIR=root;
process.env.T2P_REVIEW_DIRECTORY=root;
const {openStore}=await import('../backend/audit/store.js');
const {installCriteria,claimCriterion}=await import('../backend/audit/criterion-service.js');
const {installRegional}=await import('../backend/audit/regional-criteria.js');
const db=openStore();installCriteria(db);installRegional(db);
const origin='http://127.0.0.1:8195';
mkdirSync('.audit/ui/regional-audits',{recursive:true});
const server=spawn(process.execPath,['backend/src/local-server.js'],{env:{...process.env,PORT:'8195'},stdio:['ignore','pipe','inherit']});
let browser;
try{
 await new Promise((resolve,reject)=>{server.stdout.once('data',resolve);server.once('error',reject);});
 // A missing approval header is rejected before queuing.
 assert.equal((await fetch(origin+'/api/criteria/regions/preview',{method:'POST',headers:{'Content-Type':'application/json'},body:'{}'})).status,403);
 browser=await chromium.launch();
 for(const language of ['en','es'])for(const width of [1440,390]){
  const page=await browser.newPage({viewport:{width,height:1000}}),errors=[];
  page.on('pageerror',e=>errors.push(e.message));
  await page.goto(`${origin}/?view=regional&lang=${language}`);
  await page.locator('.regional-checklist input').nth(16).waitFor();
  assert.equal(await page.locator('.regional-selectors select').nth(0).inputValue(),'NYC Metro');
  assert.equal(await page.locator('.regional-selectors select').nth(1).inputValue(),'Central');
  assert.equal(await page.locator('.regional-checklist input:checked').count(),1);
  // Add K5; K1 is selected by default. Preview must describe only these plus needed prerequisites.
  await page.locator('.regional-checklist input').nth(4).check();
  await page.getByRole('button',{name:language==='en'?'Select next batch':'Seleccionar el siguiente lote',exact:true}).click();
  assert.equal(await page.locator('.regional-hospitals input:checked').count(),10);
  const before=db.prepare('SELECT count(*) n FROM criterion_jobs').get().n;
  await page.getByRole('button',{name:language==='en'?'Preview regional checks':'Ver plan de revisiones regionales',exact:true}).click();
  await page.locator('.regional-preview').waitFor();
  assert.equal(db.prepare('SELECT count(*) n FROM criterion_jobs').get().n,before);
  const batch=db.prepare('SELECT * FROM criterion_batches ORDER BY created DESC LIMIT 1').get();
  const plan=JSON.parse(batch.plan);
  assert.equal(plan.jobs,10);assert.equal(plan.checks,20);assert.equal(plan.max_model_calls,400);
  for(const h of plan.hospitals)assert.deepEqual(h.requested,['k1','k5']);
  const unapproved=await fetch(`${origin}/api/criteria/regions/${batch.id}/start`,{method:'POST',headers:{'Content-Type':'application/json','X-Review-Request':'1'},body:JSON.stringify({confirm:false})});
  assert.equal(unapproved.status,400);assert.equal(db.prepare('SELECT count(*) n FROM criterion_jobs').get().n,before);
  await page.reload();await page.locator('.regional-preview').waitFor();
  await page.getByRole('button',{name:language==='en'?'Approve and start batch':'Aprobar e iniciar el lote',exact:true}).click();
  await page.locator('.regional-preview').waitFor({state:'detached'});
  assert.equal(db.prepare('SELECT count(*) n FROM criterion_jobs').get().n,before+10);
  // Retrying the exact approval cannot create another job, including after a lost response.
  const retry=await fetch(`${origin}/api/criteria/regions/${batch.id}/start`,{method:'POST',headers:{'Content-Type':'application/json','X-Review-Request':'1'},body:JSON.stringify({confirm:true})});
  assert.equal(retry.status,202);assert.equal(db.prepare('SELECT count(*) n FROM criterion_jobs').get().n,before+10);
  await page.waitForFunction(()=>document.querySelectorAll('[data-audit-status="queued"]').length>0);
  const job=claimCriterion(db);assert.ok(job);
  await page.evaluate(()=>window.dispatchEvent(new Event('criterion-change')));
  await page.locator('.hospital-audit-spinner').first().waitFor();
  assert.ok(Number(await page.locator('circle.dot').first().getAttribute('r'))>3.65);
  await page.emulateMedia({reducedMotion:'reduce'});
  assert.equal(await page.locator('.hospital-audit-spinner').first().evaluate(e=>getComputedStyle(e).animationName),'none');
  await page.emulateMedia({reducedMotion:'no-preference'});
  assert.equal(await page.evaluate(()=>document.documentElement.scrollWidth>innerWidth),false);
  await page.locator('.regional-audits h1').scrollIntoViewIfNeeded();
  await page.screenshot({path:`.audit/ui/regional-audits/map-${language}-${width}.png`});
  const cancel=page.locator('.regional-batch button:not([disabled])');
  // Only one batch remains cancellable; older batches have already been cancelled.
  const cancellation=page.waitForResponse(r=>r.url().endsWith('/cancel')&&r.request().method()==='POST');
  await cancel.click();assert.equal((await cancellation).status(),200);
  assert.equal(db.prepare("SELECT count(*) n FROM criterion_jobs WHERE status='queued'").get().n,0);
  assert.equal(db.prepare('SELECT status FROM criterion_jobs WHERE id=?').get(job.id).status,'running');
  // Simulate a failed local worker to verify attention state and regional statistics without model calls.
  db.prepare("UPDATE criterion_jobs SET status='failed',completed=?,error='SYN-execution-failed',lease=NULL WHERE id=?").run(new Date().toISOString(),job.id);
  await page.evaluate(()=>window.dispatchEvent(new Event('criterion-change')));
  await page.waitForFunction(()=>document.querySelectorAll('[data-audit-status="attention"]').length>0);
  await page.locator('.regional-statistics').scrollIntoViewIfNeeded();
  assert.equal(await page.locator('.regional-statistics tbody tr').count(),2);
  await page.screenshot({path:`.audit/ui/regional-audits/statistics-${language}-${width}.png`});
  assert.deepEqual(errors,[]);await page.close();
 }
 console.log('Regional audit UI passed 4 bilingual desktop/mobile scenarios: free previews, approval, retry deduplication, queue cancellation, real database activity, reduced motion and statistics. No worker or model calls.');
}finally{await browser?.close();server.kill();db.close();}
