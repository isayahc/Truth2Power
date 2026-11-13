import assert from 'node:assert/strict';
import {spawn} from 'node:child_process';
import {mkdirSync,mkdtempSync} from 'node:fs';
import {resolve} from 'node:path';
import {chromium} from 'playwright';
const root=mkdtempSync(resolve('.audit/SYN-inbox-layout-'));
const origin='http://127.0.0.1:8196',stage=process.env.CAPTURE_BEFORE?'before':'after';
mkdirSync('.audit/ui/inbox-layout',{recursive:true});
const reviews=[
  {hospital_key:'1002',hospital_name:'SYN Community Hospital',step:'k1',title:'Financial assistance application posted',updated_at:'2026-11-12T12:00:00Z'},
  {hospital_key:'15709',hospital_name:'SYN Children’s Hospital and Regional Health Center',step:'k5',title:'Primary service-area boundaries comply',updated_at:'2026-11-12T12:05:00Z'},
  {hospital_key:'1002',hospital_name:'SYN Community Hospital',step:'k12',title:'Application contact information provided',updated_at:'2026-11-12T12:10:00Z'},
  ...Array.from({length:10},(_,i)=>({hospital_key:`SYN-${i}`,hospital_name:`SYN Additional Hospital ${i+1}`,step:'k1',title:'Financial assistance application posted',updated_at:'2026-11-12T12:00:00Z'})),
];
const server=spawn(process.execPath,['backend/src/local-server.js'],{env:{...process.env,PORT:'8196',AUDIT_DIR:root,T2P_REVIEW_DIRECTORY:root},stdio:['ignore','pipe','inherit']});
let browser;
try{
 await new Promise((resolve,reject)=>{server.stdout.once('data',resolve);server.once('error',reject);});
 browser=await chromium.launch();
 for(const language of ['en','es'])for(const width of [1440,390]){
  const page=await browser.newPage({viewport:{width,height:1000}}),errors=[],posts=[];
  let items=reviews;
  page.on('pageerror',e=>errors.push(e.message));page.on('request',r=>{if(r.method()==='POST')posts.push(r.url());});
  await page.route('**/api/criteria/summary',route=>route.fulfill({json:{hospitals:{},pending:items.length,reviews:items}}));
  await page.goto(`${origin}/?lang=${language}`);
  await page.locator('.intro-stat strong').waitFor({state:'attached'});
  await page.locator('header button.review-nav').click();
   const inbox=page.locator('.criterion-review-inbox');await inbox.locator('.criterion-review-group').first().waitFor();
  if(stage==='after'){
   assert.equal(await inbox.locator('.criterion-review-group').count(),10);
   assert.equal(await inbox.locator('details[open]').count(),0);
   assert.equal(await inbox.locator('.criterion-review-heading .criterion-review-total').innerText(),'13');
   const pagination=inbox.locator('.criterion-review-pagination');
   assert.match(await pagination.innerText(),/1–10 .* 12/);
   assert.equal(await pagination.locator('button').first().isDisabled(),true);
   const summary=inbox.locator('summary').first();await summary.focus();await page.keyboard.press('Enter');
   assert.equal(await inbox.locator('.criterion-review-row:visible').count(),2);
   await page.keyboard.press('Space');assert.equal(await inbox.locator('.criterion-review-row:visible').count(),0);
   await page.keyboard.press('Enter');
   assert.equal(await inbox.locator('.criterion-review-group').first().locator('.criterion-review-row').count(),2);
   assert.equal(await inbox.locator('.criterion-review-badge').count(),11);
   assert.equal(await inbox.locator('time[datetime]').count(),11);
   assert.equal(await inbox.locator('.criterion-review-action').first().innerText(),language==='en'?'Review →':'Revisar →');
   assert.equal(await page.evaluate(()=>document.documentElement.scrollWidth>innerWidth),false);
   const refresh=async()=>{const response=page.waitForResponse('**/api/criteria/summary');await page.evaluate(()=>window.dispatchEvent(new Event('criterion-change')));await response;};
   await refresh();assert.equal(await inbox.locator('details[open]').count(),1);
   await pagination.locator('button').last().click();
   assert.equal(await inbox.locator('.criterion-review-group').count(),2);
   assert.match(await pagination.innerText(),/11–12 .* 12/);
   assert.equal(await pagination.locator('button').last().isDisabled(),true);
   // A live refresh that removes the last page must return to a valid page.
   items=reviews.slice(0,3);await refresh();
   await page.waitForFunction(()=>document.querySelector('.criterion-review-pagination')?.textContent.includes('1–2'));
   items=reviews;await refresh();
   await page.waitForFunction(()=>document.querySelectorAll('.criterion-review-group').length===10);
   await inbox.locator('summary').first().click();
  }
  await inbox.screenshot({path:`.audit/ui/inbox-layout/${stage}-${language}-${width}.png`});
  if(stage==='after'){
   const link=inbox.locator('.criterion-review-action').first();await link.focus();await page.keyboard.press('Enter');
   await page.locator('#criterion-k1').waitFor();assert.match(page.url(),/hospital=1002.*#criterion-k1/);
   await page.locator('header button.review-nav').click();
   items=[];await page.evaluate(()=>window.dispatchEvent(new Event('criterion-change')));
   await inbox.locator('.criterion-review-empty').waitFor();
    assert.equal(await inbox.locator('.criterion-review-group').count(),0);
    assert.equal(await inbox.locator('.criterion-review-pagination').count(),0);
  }
  assert.deepEqual(errors,[]);assert.deepEqual(posts,[]);await page.close();
 }
 console.log(`${stage}: inbox screenshots and bilingual desktop/mobile checks completed; synthetic fixtures; no jobs submitted.`);
}finally{await browser?.close();server.kill();}
