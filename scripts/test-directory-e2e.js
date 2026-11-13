import assert from 'node:assert/strict';
import {spawn} from 'node:child_process';
import {mkdirSync,mkdtempSync,readFileSync} from 'node:fs';
import {resolve} from 'node:path';
import {chromium} from 'playwright';
const root=mkdtempSync(resolve('.audit/SYN-directory-'));
const origin='http://127.0.0.1:8197';
mkdirSync('.audit/ui/directory',{recursive:true});
const server=spawn(process.execPath,['backend/src/local-server.js'],{env:{...process.env,PORT:'8197',AUDIT_DIR:root,T2P_REVIEW_DIRECTORY:root},stdio:['ignore','pipe','inherit']});
let browser;
try{
  await new Promise((resolve,reject)=>{server.stdout.once('data',resolve);server.once('error',reject);});
  const get=async path=>{const r=await fetch(origin+path);assert.equal(r.status,200);return r.json();};
  const dataset=await get('/api/hospitals');assert.equal(dataset.features.length,218);
  const added=JSON.parse(readFileSync('data/maps/directory-reconciliation.json')).added_ids;
  const operations=await get('/api/pilot/v1/operations');assert.equal(operations.items.length,218);
  for(const id of added){assert.ok(operations.items.some(h=>h.hospital_key===id));assert.equal((await get(`/api/hospitals/${id}/criteria`)).summary.unrun,17);}
  browser=await chromium.launch();
  for(const language of ['en','es'])for(const width of [1440,390]){
    const page=await browser.newPage({viewport:{width,height:960}}),errors=[],posts=[];
    page.on('pageerror',e=>errors.push(e.message));page.on('request',r=>{if(r.method()==='POST')posts.push(r.url());});
    const unrated=language==='en'?'Not rated':'Sin calificación';
    await page.goto(`${origin}/?lang=${language}`);
    await page.locator('.intro-stat strong').waitFor({state:'attached'});assert.equal(await page.locator('.intro-stat strong').innerText(),'218');
    const regionSelect=page.locator('#map-region');
    assert.equal(await regionSelect.locator('option').count(),10);
    for(const region of ['NYC Metro','Central']){
      await regionSelect.selectOption(region);
      const regional=dataset.features.filter(f=>f.properties.region===region);
      assert.equal(await page.locator('.intro-stat strong').innerText(),String(regional.length));
      const counts=await page.locator('.legend-item .quantity').allTextContents();
      assert.equal(counts.reduce((sum,n)=>sum+Number(n),0),regional.length);
      const rating=regional.find(f=>f.properties.stars!=null).properties.stars;
      await page.locator('.legend-item').filter({has:page.locator('.stars',{hasText:`${rating} ★`})}).click();
      assert.match(await page.locator('.map-footer strong').innerText(),new RegExp(`${regional.filter(f=>f.properties.stars===rating).length}.*${regional.length}`));
      const names=await page.locator('circle.dot').evaluateAll(nodes=>nodes.map(n=>n.getAttribute('aria-label').split(' · ')[0]));
      assert.ok(names.length>0);assert.ok(names.every(name=>regional.some(f=>f.properties.name===name && f.properties.stars===rating)));
      await page.locator('.legend-item[aria-pressed=true]').click();
    }
    await page.reload();await regionSelect.waitFor();assert.equal(await regionSelect.inputValue(),'Central');
    assert.equal(await page.evaluate(()=>document.documentElement.scrollWidth>innerWidth),false);
    await page.screenshot({path:`.audit/ui/directory/regions-${language}-${width}.png`});
    await regionSelect.selectOption('');
    const filter=page.getByRole('button',{name:new RegExp(unrated+' 7')});await filter.click();
    assert.match(await page.locator('.map-footer strong').innerText(),/7.*218/);
    // Search uses names and keyboard selection, including the separate Glasgow campus.
    await page.locator('.search-bar input').fill("Children's Pavilion");
    await page.keyboard.press('ArrowDown');await page.keyboard.press('Enter');
    await page.locator('.hospital-summary h1').waitFor();assert.match(page.url(),/hospital=15709/);
    for(const id of added){
      await page.goto(`${origin}/?hospital=${id}&lang=${language}`);
      await page.locator('.criterion-card').nth(16).waitFor();
      assert.ok((await page.locator('.hospital-summary .pill').innerText()).includes(unrated));
      assert.equal(await page.locator('.record-actions a').count(),1);
      assert.equal(await page.evaluate(()=>document.documentElement.scrollWidth>innerWidth),false);
    }
    await page.screenshot({path:`.audit/ui/directory/unrated-${language}-${width}.png`});
    await page.goto(`${origin}/?hospital=t2p-0001&lang=${language}`);
    await page.locator('.hospital-summary h1').waitFor();
    assert.match(await page.locator('.hospital-summary').innerText(),language==='en'?/Historical record/:/Registro histórico/);
    await page.goto(`${origin}/?view=overview&lang=${language}`);
    await page.locator('.overview-controls').waitFor();
    await page.locator('.overview-controls select').nth(3).selectOption('historical-unrated');
    assert.equal(await page.locator('table[aria-label] tbody tr').count(),7);
    assert.equal(await page.evaluate(()=>document.documentElement.scrollWidth>innerWidth),false);
    await page.screenshot({path:`.audit/ui/directory/overview-${language}-${width}.png`});
    assert.deepEqual(errors,[]);assert.deepEqual(posts,[]);await page.close();
  }
  console.log('218 current entries; seven unrated details; historical Cohen link; bilingual desktop/mobile search, map filters and Overview passed. No checks submitted.');
}finally{await browser?.close();server.kill();}
