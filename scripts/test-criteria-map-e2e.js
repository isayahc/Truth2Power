// Static production frontend with synthetic API responses. No backend, audit worker or model calls.
import {preview} from 'vite';
import {chromium} from 'playwright';
import {readFileSync,mkdirSync} from 'node:fs';
import assert from 'node:assert/strict';
const geo=JSON.parse(readFileSync('data/maps/hospitals.geojson','utf8'));
geo.features=geo.features.filter(h=>h.properties.current_directory!==false).slice(0,7);
// Synthetic region assignment isolates the multi-select behavior from roster ordering.
geo.features.forEach((h,i)=>{h.properties.region=i<3?'Northern Metro':'Central';});
const counties=JSON.parse(readFileSync('data/maps/counties.geojson','utf8'));
const rubric=JSON.parse(readFileSync('rubrics/css-17-v1.json','utf8'));
const states=['met','unmet','unclear','error','unrun','met','unrun'];
const hospitals=geo.features.map((h,n)=>({hospital_key:h.id,name:h.properties.name,region:h.properties.region,
 active:n===6?{status:'running',requested:['k1'],progress:{k1:{status:'running'}}}:null,
 items:rubric.measures.map((m,i)=>({id:`k${i+1}`,title:m.title,effective:i===0?states[n]:n===0?'met':'unrun',technical_error:i===0&&(n===3||n===5),updated_at:'2026-11-13T00:00:00Z',saved:null,revision:null})),
}));
const server=await preview({preview:{host:'127.0.0.1',port:8198,strictPort:true}}),browser=await chromium.launch();
mkdirSync('.audit/ui/criteria-map',{recursive:true});
try{
 for(const lang of ['en','es'])for(const width of [1440,390]){
  const page=await browser.newPage({viewport:{width,height:1000}}),errors=[];let posts=0,unavailable=false,batches=[];const requests=[];
  page.on('pageerror',e=>errors.push(e.message));
  await page.route('**/api/**',route=>{
   const request=route.request(),path=new URL(request.url()).pathname;
   if(request.method()!=='GET'){
    posts++;assert.equal(path,'/api/criteria/regions/run');const input=request.postDataJSON();requests.push(input);
    const selected=hospitals.filter(h=>input.regions.includes(h.region));
    batches=[{id:input.request_key,selection:{regions:input.regions,steps:input.steps,hospitals:selected.map(h=>h.hospital_key)},jobs:selected.map(h=>({hospital:h.hospital_key,status:'queued'}))}];
    if(posts===1)return route.abort(); // Simulate a lost response after acceptance.
    return route.fulfill({status:202,json:batches[0]});
   }
   if(path==='/api/hospitals')return route.fulfill({json:geo});
   if(path==='/api/counties')return route.fulfill({json:counties});
   if(path==='/api/criteria/regions')return route.fulfill(unavailable?{status:503,json:{}}:{json:{hospitals,regions:[],batches}});
   if(/^\/api\/hospitals\/[^/]+\/criteria$/.test(path))return route.fulfill({json:{...hospitals[0],summary:{met:17,unmet:0,unclear:0,error:0,unrun:0,confirmed:17},active:null}});
   if(['/api/criteria/summary','/api/reviews','/api/pilot/v1/interventions'].includes(path))return route.fulfill({json:{hospitals:{},activity:{},reviews:[],items:[],pending:0}});
   return route.fulfill({status:404,json:{}});
  });
  await page.goto(`http://127.0.0.1:8198/?lang=${lang}`);
  await page.locator('.current-criteria-summary .criteria-percent').waitFor();
  assert.equal(await page.locator('#map-requirement option').count(),18);
  await page.locator('#map-requirement').selectOption('k1');
  assert.equal(posts,0);
  assert.equal(await page.locator('.current-map-legend .criterion-status--unclear .criterion-dot').evaluate(el=>getComputedStyle(el).backgroundColor),'rgb(250, 204, 21)');
  assert.equal(await page.locator('.criteria-percent strong').innerText(),'67%');
  if(width===1440){
   assert.ok((await page.locator('.atlas-toolbar').boundingBox()).height<=60,'Desktop controls fit in one compact row');
   assert.ok((await page.locator('.viewport').boundingBox()).height>=500,'Map keeps at least half the 1000px desktop viewport');
  }
  assert.equal(await page.locator('#state-view [data-audit-status="unmet"]').count(),1);
  assert.equal(await page.locator('#state-view .hospital-error-cross').count(),1);
  assert.equal(await page.locator('#state-view .hospital-error-badge').count(),1);
  assert.equal(await page.locator('#state-view [data-audit-status="met"]').count(),2);
  const filter=page.locator('.criteria-status-filters button').filter({has:page.locator('.criterion-status--unmet')});
  await filter.click();assert.equal(await page.locator('#state-view .dot').count(),1);
  await page.locator('.region-picker-menu summary').click();
  const checkboxes=page.locator('.region-picker-options input');
  await checkboxes.nth(3).check(); // Northern Metro in Attachment G order.
  await checkboxes.nth(7).check(); // Central.
  assert.equal(await page.locator('.region-chip').count(),2);
  await page.locator('.region-picker-menu summary').click();
  await page.locator('.map-run-jobs').click();await page.locator('.map-job-status[role="alert"]').waitFor();
  assert.equal(await page.locator('#map-requirement').isDisabled(),true);
  await page.locator('.map-run-jobs').click();await page.locator('.map-job-status[role="alert"]').waitFor({state:'detached'});
  assert.equal(requests.length,2);assert.equal(requests[0].request_key,requests[1].request_key);
  assert.deepEqual(requests[0].steps,['k1']);assert.equal(requests[0].confirm,true);
  assert.deepEqual(requests[0].regions,['Northern Metro','Central']);assert.equal(requests[0].hospitals,undefined);
  assert.equal(batches[0].jobs.length,7); // Status filter does not shrink execution scope.
  if(width===1440)assert.ok((await page.locator('.atlas-toolbar').boundingBox()).height<=60,'Selected region chips must not add toolbar rows');
  assert.equal(await page.evaluate(()=>document.documentElement.scrollWidth>innerWidth),false);
  await page.screenshot({path:`.audit/ui/criteria-map/multi-region-run-${lang}-${width}.png`,fullPage:true});
  await page.locator('.region-chip button').last().click();assert.equal(await page.locator('.region-chip').count(),1);
  await page.reload();await page.locator('.criteria-percent').waitFor();assert.equal(await page.locator('.region-chip').count(),1);
  await page.locator('.region-chip button').click();assert.equal(await page.locator('.region-chip').count(),0);
  assert.equal(await page.locator('#state-view .dot').count(),7);
  await page.locator('.current-criteria-summary').evaluate(el=>{el.scrollTop=0;});
  assert.equal(await page.evaluate(()=>document.documentElement.scrollWidth>innerWidth),false);
  await page.screenshot({path:`.audit/ui/criteria-map/k1-${lang}-${width}.png`,fullPage:true});
  await page.reload();await page.locator('.criteria-percent').waitFor();assert.equal(await page.locator('#map-requirement').inputValue(),'k1');
  await page.locator('.map-year-switch button').first().click();
  assert.equal(await page.locator('.legend-item').count(),7);assert.equal(await page.locator('#map-requirement').count(),0);
  await page.locator('.legend-item').first().click();assert.equal(await page.locator('.legend-item').first().getAttribute('aria-pressed'),'true');
  await page.goBack();await page.locator('#map-requirement').waitFor();assert.equal(await page.locator('#map-requirement').inputValue(),'k1');
  await page.locator('#map-requirement').selectOption('k17');
  assert.equal(await page.locator('.criteria-percent strong').innerText(),'100%');
  await page.locator('#map-requirement').selectOption('k1');
  await page.locator('#state-view .dot').first().focus();await page.keyboard.press('Enter');
  assert.ok(page.url().endsWith('#criterion-k1'));assert.ok(page.url().includes('hospital='));
  await page.locator('.criterion-audits').waitFor();
  await page.goBack();await page.locator('.criteria-percent').waitFor();
  unavailable=true;
  await page.waitForFunction(()=>document.querySelector('.current-criteria-map [role="alert"]'));
  assert.equal(await page.locator('.current-criteria-map .dot').count(),0);
  assert.equal(posts,2);assert.deepEqual(errors,[]);await page.close();
 }
 console.log('Four static bilingual desktop/mobile map scenarios passed: multi-region chips/removal, yellow legend, direct run scope, lost-response retry key, year switching, K1-K17 filtering, compact layout and evidence links. POSTs intercepted by Playwright only; zero backend/model calls.');
}finally{await browser.close();await new Promise(resolve=>server.httpServer.close(resolve));}
