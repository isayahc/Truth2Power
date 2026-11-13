// Synthetic responses only; no backend or model calls.
import {preview} from 'vite';
import {chromium} from 'playwright';
import {readFileSync,mkdirSync} from 'node:fs';
import assert from 'node:assert/strict';
const geo=JSON.parse(readFileSync('data/maps/hospitals.geojson','utf8'));
const hospitals=['met','unclear','unmet',null].map((outcome,i)=>({hospital_key:`SYN-${i}`,region:i<2?'NYC Metro':'Northern Metro',items:[{id:'k1',agent_outcome:outcome,technical_error:i===3,agent_updated_at:outcome?'2026-11-13T00:00:00Z':null}]}));
const server=await preview({preview:{host:'127.0.0.1',port:8199,strictPort:true}}),browser=await chromium.launch();
mkdirSync('.audit/ui/statistics',{recursive:true});
try{
 for(const lang of ['en','es'])for(const width of [1440,390]){
  const page=await browser.newPage({viewport:{width,height:1000}}),errors=[];let writes=0;
  page.on('pageerror',e=>errors.push(e.message));
  await page.route('**/api/**',route=>{
   if(route.request().method()!=='GET'){writes++;return route.abort();}
   const path=new URL(route.request().url()).pathname;
   return route.fulfill({json:path==='/api/criteria/regions'?{hospitals}:['/api/hospitals','/api/counties'].includes(path)?geo:{hospitals:{},activity:{},reviews:[],items:[],pending:0}});
  });
  await page.goto(`http://127.0.0.1:8199/?view=statistics&lang=${lang}&region=NYC+Metro&region=Northern+Metro`);
  await page.locator('.statistics-table').waitFor();
  if(lang==='es')assert.doesNotMatch(await page.locator('.statistics-table').innerText(),/Requirement (not )?met/);
  assert.equal(await page.locator('.statistics-table tbody tr').count(),17);
  assert.match(await page.locator('.statistics-table tbody tr').first().innerText(),/2\/3/);
  await page.locator('.statistics-table tbody th button').first().click();
  assert.equal(await page.locator('#statistics-requirement').inputValue(),'k1');
  assert.equal(await page.locator('.statistics-table tbody tr').count(),3);
  await page.locator('#statistics-requirement').selectOption('k2');
  assert.equal(await page.locator('.region-chip').count(),2);
  assert.match(await page.locator('.statistics-table tbody').innerText(),lang==='en'?/Not assessed/:/Sin evaluar/);
  await page.reload();await page.locator('.statistics-table').waitFor();
  assert.equal(await page.locator('#statistics-requirement').inputValue(),'k2');
  await page.locator('#statistics-requirement').selectOption('k1');
  await page.locator('.region-picker-menu summary').click();
  const box=await page.locator('.region-picker-options').boundingBox();assert.ok(box.x>=0&&box.x+box.width<=width);
  await page.locator('.region-picker-menu summary').click();
  assert.equal(await page.evaluate(()=>document.documentElement.scrollWidth>innerWidth),false);
  await page.screenshot({path:`.audit/ui/statistics/${lang}-${width}.png`,fullPage:true});
  assert.equal(writes,0);assert.deepEqual(errors,[]);await page.close();
 }
 console.log('Statistics: bilingual desktop/mobile, rates, requirement switching, preserved regions, reload and menu bounds passed. No backend/model calls.');
}finally{await browser.close();await new Promise(resolve=>server.httpServer.close(resolve));}
