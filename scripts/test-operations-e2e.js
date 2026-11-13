// Legacy records remain readable; hospital links now lead to the criterion UI.
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdirSync, mkdtempSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { chromium } from 'playwright';
import {randomUUID} from 'node:crypto';

mkdirSync('.audit/ui/operations', {recursive:true});
const root=mkdtempSync(resolve('.audit/SYN-operations-'));
process.env.AUDIT_DIR=root;
process.env.T2P_REVIEW_DIRECTORY=join(root,'live');
const {openStore,claim}=await import('../backend/audit/store.js');
const {enqueuePipeline,failPipeline}=await import('../backend/audit/pipeline-store.js');
const db=openStore();
const {installCriteria,enqueueCriterion,claimCriterion,finishCriterion,criterionStatus,decideCriterion}=await import('../backend/audit/criterion-service.js');
installCriteria(db);
const id=enqueuePipeline(db,{hospital_key:'739',mode:'discovery_only',year:2026,review_date:'2026-11-10',request_key:'SYN-retained-history'});
for(let attempt=0;attempt<3;attempt++) {
  db.prepare('UPDATE jobs SET available_at=0 WHERE id=?').run(id);
  failPipeline(db,claim(db));
}
const port=process.env.TEST_PORT ?? '8198', origin=`http://127.0.0.1:${port}`;
const server=spawn(process.execPath,['backend/src/local-server.js'],{env:{...process.env,PORT:port},stdio:['ignore','pipe','inherit']});
let browser;
try {
  await new Promise((resolve,reject)=>{server.stdout.once('data',resolve);server.once('error',reject);server.once('exit',code=>reject(Error(`Server exited: ${code}`)));});
  const before=await (await fetch(`${origin}/api/pilot/v1/runs/audit-run-${id}/log.json`)).json();
  browser=await chromium.launch();
  for(const [language,width] of [['en',1440],['en',390],['es',1440],['es',390]]) {
    enqueueCriterion(db,'1002','k12',{request_key:randomUUID(),approved_steps:['k1','k12'],rerun:true},{run:['k1','k12']});
    const job=claimCriterion(db);
    for(const [step,value] of [['k1',true],['k12',null]])db.prepare('INSERT OR REPLACE INTO criterion_results VALUES(?,?,?,?,?)')
      .run('1002',step,job.id,new Date().toISOString(),JSON.stringify({value,explanation:'SYNTHETIC operations fixture',limitations:[],evidence:[{sourceUrl:'https://example.org/SYN.pdf',quote:'SYNTHETIC',locator:'page 1',retrievedAt:'2026-11-01T12:00:00Z'}]}));
    finishCriterion(db,job);
    const page=await browser.newPage({viewport:{width,height:960}}), errors=[], posts=[];
    page.on('pageerror',e=>errors.push(e.message));
    page.on('request',r=>{if(r.method()==='POST')posts.push(r.url());});
    await page.goto(`${origin}/?view=operations&lang=${language}`,{waitUntil:'domcontentloaded'});
    await page.getByRole('searchbox').fill('739');
    const hospital=page.getByRole('link',{name:'A.O. Fox Memorial Hospital',exact:true});
    await hospital.waitFor();await hospital.focus();await page.keyboard.press('Enter');
    await page.locator('#audit-runs .criterion-card').nth(16).waitFor();
    assert.match(page.url(),/hospital=739/);
    assert.equal(await page.locator('.hospital-runs, .hospital-panel-nav').count(),0);
    assert.equal(await page.locator('.hospital-findings').isVisible(),true);
    assert.equal(await page.getByRole('button',{name:/^(Scan documents|Replay saved evidence|Audits and history)$/}).count(),0);
    await page.locator('#criterion-audits-title').scrollIntoViewIfNeeded();
    assert.equal(await page.evaluate(()=>document.documentElement.scrollWidth>innerWidth),false);
    await page.screenshot({path:`.audit/ui/operations/criterion-destination-${language}.png`});
    await page.getByRole('link',{name:language==='en'?'Check history and costs':'Historial de revisiones y costos',exact:true}).click();
    await page.getByRole('searchbox').fill('739');await page.getByRole('link',{name:'A.O. Fox Memorial Hospital',exact:true}).waitFor();
    await page.getByRole('searchbox').fill('1002');
    const row=page.locator('.ops-dashboard tbody tr').filter({hasText:'Ellenville Regional Hospital'});
    await row.waitFor();
    assert.equal(await row.locator('td').nth(5).innerText(),'1/17');
    assert.equal(await row.locator('td').nth(6).innerText(),'1');
    assert.equal(await row.locator('td').nth(7).innerText(),'15');
    assert.equal(await row.locator('td').nth(4).innerText(),language==='en'?'Not scheduled':'Sin programar');
    const missing=language==='en'?'Not recorded':'Sin registrar';
    assert.equal(await row.locator('td').nth(8).innerText(),missing);
    for(const index of [1,2,3])assert.notEqual(await row.locator('td').nth(index).innerText(),missing);
    const item=criterionStatus(db,'1002').items.find(i=>i.id==='k12');
    decideCriterion(db,'1002','k12',{request_key:randomUUID(),revision:item.revision,decision:'unmet',reason:'SYN human review',evidence:'SYN page 1'});
    // Automatic refresh must pick up a decision made from another page.
    await page.waitForFunction(()=>[...document.querySelectorAll('.ops-dashboard tbody tr')].some(row=>row.textContent.includes('2/17')));
    assert.equal(await row.locator('td').nth(6).innerText(),'0');
    assert.equal(await page.evaluate(()=>document.documentElement.scrollWidth>innerWidth),false);
    await page.screenshot({path:`.audit/ui/operations/connected-${language}-${width}.png`});
    await row.getByRole('link',{name:'Ellenville Regional Hospital',exact:true}).click();
    await page.waitForFunction(()=>document.querySelector('.criterion-summary')?.textContent.includes('2/17'));
    assert.deepEqual(posts,[]);assert.deepEqual(errors,[]);
    await page.close();
  }
  const after=await (await fetch(`${origin}/api/pilot/v1/runs/audit-run-${id}/log.json`)).json();
  const {exported_at: beforeExport, ...beforeRecords}=before;
  const {exported_at: afterExport, ...afterRecords}=after;
  assert.deepEqual(afterRecords,beforeRecords);
  assert.equal(db.prepare('SELECT count(*) n FROM jobs').get().n,1);
  console.log('Operations matches database and hospital counts, refreshes human decisions, records timestamps, preserves legacy history, and distinguishes missing costs/schedules; 4 bilingual desktop/mobile scenarios; no model calls.');
} finally {
  await browser?.close();server.kill();db.close();
}
