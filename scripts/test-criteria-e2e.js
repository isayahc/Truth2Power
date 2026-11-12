// Synthetic queue/runner/browser integration. No SDK or paid model is invoked.
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdir, mkdtemp, writeFile } from 'node:fs/promises';
import { resolve, join } from 'node:path';
import { chromium } from 'playwright';
import { openStore } from '../backend/audit/store.js';
import { installCriteria, claimCriterion, criterionHospital, saveCriterionProgress, finishCriterion } from '../backend/audit/criterion-service.js';
import { runAudit } from '../agents/runner.ts';
import { steps } from '../agents/steps.ts';

await mkdir('.audit/browser-checks', { recursive: true });
const root = await mkdtemp(resolve('.audit/browser-checks/SYN-criteria-'));
const db = openStore(root); installCriteria(db);
const server = spawn(process.execPath, ['backend/src/local-server.js'], {
  env: { ...process.env, PORT:'5198', AUDIT_DIR:root }, stdio:['ignore','pipe','pipe'],
});
const browser = await chromium.launch();
const base = 'http://127.0.0.1:5198';
try {
  await new Promise((resolve, reject) => { server.stdout.once('data', resolve); server.once('error', reject); server.once('exit', code => reject(Error(`Server exited: ${code}`))); });
  const post = (path, body, headers={}) => fetch(base + path, {method:'POST',headers:{'Content-Type':'application/json','X-Review-Request':'1',...headers},body:JSON.stringify(body)});
  assert.equal((await post('/api/hospitals/1002/criteria/k1', {}, {Origin:'https://example.org'})).status, 403);
  assert.equal((await post('/api/hospitals/1002/criteria/k18', {})).status, 400);
  assert.equal((await fetch(base+'/api/hospitals/99999999/criteria')).status, 404);
  let scenarios = 0;
  for (const language of ['en','es']) for (const width of [1440,390]) {
    db.exec('DELETE FROM criterion_requests; DELETE FROM criterion_jobs; DELETE FROM criterion_results;');
    const context = await browser.newContext({viewport:{width,height:1000}});
    const page = await context.newPage(), errors = [];
    page.on('pageerror', e => errors.push(e.message));
    await page.goto(`${base}/?hospital=1002&lang=${language}`, {waitUntil:'domcontentloaded'});
    await page.locator('.criterion-card').nth(16).waitFor();
    assert.equal(await page.locator('.criterion-card').count(), 17);
    assert.equal(db.prepare('SELECT count(*) n FROM criterion_jobs').get().n, 0);
    assert.equal(await page.getByRole('button', {name: language==='en'?'Full audit':'Auditoría completa',exact:true}).count(),0);
    const target = page.locator('.criterion-card').nth(11);
    await target.getByRole('button').focus(); await page.keyboard.press('Enter');
    await page.locator('.criterion-confirm').waitFor();
    assert.match(await page.locator('.criterion-confirm').innerText(), /K1, K12/);
    assert.equal(db.prepare('SELECT count(*) n FROM criterion_jobs').get().n, 0);
    await page.locator('.criterion-confirm').screenshot({path:join(root,`confirm-${language}-${width}.png`)});
    await page.locator('.criterion-confirm button').first().evaluate(button => { button.click(); button.click(); });
    await page.locator('.criterion-progress').waitFor();
    assert.equal(db.prepare('SELECT count(*) n FROM criterion_jobs').get().n, 1);
    assert.equal(await target.getByRole('button').isDisabled(), true);
    await page.reload({waitUntil:'domcontentloaded'}); await page.locator('.criterion-progress').waitFor();
    assert.equal(db.prepare('SELECT count(*) n FROM criterion_jobs').get().n, 1);

    const job = claimCriterion(db), hospital = criterionHospital('1002');
    const registry = { ...steps };
    for (const id of ['k1','k12']) registry[id] = { ...steps[id], run: async () => {
      const path = join(root, `SYN-${id}.json`);
      const result = { synthetic:true, runId:'SYN-browser', hospital, criterion:steps[id].criterion,
        value:id==='k1'?true:null, explanation:'Synthetic fixture: extraction needs review.',
        evidence:[{sourceUrl:'https://example.org/SYN.pdf',locator:'PDF page 1',quote:'SYNTHETIC <script> text stays text.'}],limitations:['Synthetic test only.'] };
      await writeFile(path, JSON.stringify(result)); return {...result,path};
    } };
    await runAudit(hospital, {requested:['k12'],approvedSteps:['k1','k12'],auditRoot:root}, {
      registry, find:async()=>undefined, log:()=>{}, checkpoint:m=>saveCriterionProgress(db,job,m,root),
    });
    finishCriterion(db,job);
    await page.locator('.criterion-audits > button').click();
    await page.locator('.criterion-progress').waitFor({state:'detached'});
    await target.locator('summary').click();
    await target.locator('blockquote').waitFor();
    assert.match(await target.innerText(), /SYNTHETIC <script> text stays text/);
    assert.match(await target.innerText(), language==='en'?/Needs review/:/Requiere revisión/);
    assert.equal(await target.locator('script').count(),0);
    assert.equal(await page.evaluate(()=>document.documentElement.scrollWidth>innerWidth),false);
    await target.screenshot({path:join(root,`result-${language}-${width}.png`)});

    // Lost response after acceptance must reuse the exact key, even after reload.
    await target.getByRole('button').click(); await page.locator('.criterion-confirm').waitFor();
    await page.route('**/criteria/k12', async route => { await route.fetch(); await route.abort(); }, {times:1});
    await page.locator('.criterion-confirm button').first().click();
    await page.locator('.criterion-audits [role="alert"]').waitFor();
    assert.equal(db.prepare('SELECT count(*) n FROM criterion_jobs').get().n,2);
    await page.reload({waitUntil:'domcontentloaded'}); await page.locator('.criterion-confirm').waitFor();
    await page.locator('.criterion-confirm button').first().click();
    await page.locator('.criterion-confirm').waitFor({state:'detached'});
    assert.equal(db.prepare('SELECT count(*) n FROM criterion_jobs').get().n,2);
    assert.deepEqual(errors,[]);
    scenarios++; await context.close();
  }
  console.log(JSON.stringify({scenarios,modelCalls:0,screenshots:root,checks:'17 criteria, read-only viewing, explicit preparation, duplicate clicks, reload persistence, synthetic runner results, citations, bilingual mobile layout, lost-response idempotency, origin validation'}));
} finally {
  await browser.close(); server.kill(); db.close();
}
