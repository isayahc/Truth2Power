// Read-only checks using isolated stores; no model calls or audit submissions.
import assert from 'node:assert/strict';
import {mkdirSync,mkdtempSync} from 'node:fs';
import {resolve,join} from 'node:path';
import {spawn} from 'node:child_process';
import {chromium} from 'playwright';

mkdirSync('.audit/browser-checks',{recursive:true});
const root=mkdtempSync(resolve('.audit/browser-checks/SYN-overview-navigation-'));
const port=18230,base=`http://127.0.0.1:${port}`;
const server=spawn(process.execPath,['backend/src/local-server.js'],{env:{...process.env,PORT:String(port),AUDIT_DIR:root,T2P_REVIEW_DIRECTORY:join(root,'live')},stdio:['ignore','pipe','inherit']});
let browser;
try {
  await new Promise((ready,reject)=>{server.stdout.once('data',ready);server.once('error',reject);server.once('exit',code=>reject(Error(`Server exited ${code}`)));});
  browser=await chromium.launch();
  for(const language of ['en','es']) for(const width of [1440,390]) {
    const page=await browser.newPage({viewport:{width,height:1000}}),errors=[],posts=[];
    page.on('pageerror',error=>errors.push(error.message));
    page.on('request',request=>{if(request.method()==='POST')posts.push(request.url());});
    await page.goto(`${base}/?view=overview&lang=${language}`,{waitUntil:'domcontentloaded'});
    const table=page.getByRole('table',{name:language==='en'?'Hospital directory':'Directorio de hospitales',exact:true});
    await table.locator('tbody tr').nth(9).waitFor();
    assert.equal(await page.locator('header a[href*="view=changes"]').count(),0);
    assert.equal(await table.locator('tbody tr').count(),10);
    const first=await table.locator('tbody tr').first().innerText();
    const pagination=page.locator('.overview-pagination');
    assert.match(await pagination.innerText(),/1–10 .* 218/);
    const previous=pagination.locator('button').nth(0),next=pagination.locator('button').nth(1);
    assert.equal(await previous.isDisabled(),true);
    await next.click();
    assert.match(await pagination.innerText(),/11–20 .* 218/);
    assert.notEqual(await table.locator('tbody tr').first().innerText(),first);
    await previous.click();
    assert.equal(await table.locator('tbody tr').first().innerText(),first);
    const coverage=page.locator('#overview-tab-coverage'), findings=page.locator('#overview-tab-findings');
    await coverage.focus();await page.keyboard.press('ArrowRight');
    assert.equal(await findings.getAttribute('aria-selected'),'true');
    assert.equal(await page.locator('#overview-panel-coverage').isVisible(),false);
    assert.equal(await page.locator('#overview-panel-findings').isVisible(),true);
    await page.keyboard.press('Home');assert.equal(await coverage.getAttribute('aria-selected'),'true');
    await next.click();
    const region=page.locator('.overview-controls select').nth(0);
    const selected=await region.locator('option').nth(1).getAttribute('value');
    const selectedLabel=await region.locator('option').nth(1).innerText();
    await region.selectOption(selected);
    await page.waitForFunction(()=>document.querySelector('.overview-pagination [role=status]').textContent.includes('1–'));
    assert.match(await pagination.innerText(),/1–/);
    await findings.click();
    assert.ok((await page.locator('#overview-panel-findings h2').innerText()).includes(selectedLabel));
    await page.getByRole('button',{name:language==='en'?'Clear filters':'Quitar filtros',exact:true}).click();
    await page.getByRole('button',{name:language==='en'?'Show checked hospitals on map':'Mostrar hospitales revisados en el mapa',exact:true}).click();
    const mapPoints=await page.locator('circle.dot').count();
    assert.ok(mapPoints>=218); // Statewide plus the metro inset share some hospitals.
    await next.click();assert.equal(await page.locator('circle.dot').count(),mapPoints);
    await page.getByRole('button',{name:language==='en'?'Hide map':'Ocultar mapa',exact:true}).click();
    // Last page and empty filtered results keep navigation bounded.
    while(!await next.isDisabled())await next.click();
    assert.equal(await table.locator('tbody tr').count(),8);
    assert.match(await pagination.innerText(),/211–218/);
    await page.locator('.overview-controls select').nth(1).selectOption('current');
    await page.route('**/api/overview',async route=>{
      const data=await (await route.fetch()).json();
      data.hospitals=[];
      await route.fulfill({json:data});
    },{times:1});
    await page.getByRole('button',{name:language==='en'?'Refresh overview':'Actualizar resumen',exact:true}).click();
    await page.waitForFunction(()=>document.querySelector('.overview-pagination [role=status]').textContent.includes('0–0'));
    assert.equal(await previous.isDisabled(),true);assert.equal(await next.isDisabled(),true);
    await page.getByRole('button',{name:language==='en'?'Refresh overview':'Actualizar resumen',exact:true}).click();
    await page.getByRole('button',{name:language==='en'?'Clear filters':'Quitar filtros',exact:true}).click();
    await table.locator('tbody tr').nth(9).waitFor();
    assert.equal(await table.locator('tbody tr').count(),10);
    assert.equal(await page.evaluate(()=>document.documentElement.scrollWidth>innerWidth),false);
    await page.locator('.overview-tabs').scrollIntoViewIfNeeded();
    await page.screenshot({path:join(root,`tabs-${language}-${width}.png`)});
    await pagination.scrollIntoViewIfNeeded();
    await page.screenshot({path:join(root,`directory-${language}-${width}.png`)});
    const href=await table.locator('tbody a').first().getAttribute('href');
    assert.equal(new URL(href,base).searchParams.get('lang'),language==='es'?'es':null);
    assert.deepEqual(errors,[]);assert.deepEqual(posts,[]);
    await page.close();
  }
  console.log(JSON.stringify({scenarios:4,modelCalls:0,screenshots:root,checks:'header link removed, keyboard tabs, pagination, filter reset, empty/last pages, full filtered map, bilingual mobile layout'}));
} finally {await browser?.close();server.kill();}
