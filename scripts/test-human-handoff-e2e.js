// Synthetic browser test: never writes fabricated evidence to the demo's real store.
import assert from 'node:assert/strict';
import {spawn,execFileSync} from 'node:child_process';
import {mkdtempSync,mkdirSync,rmSync} from 'node:fs';
import {join,resolve} from 'node:path';
import {createServer} from 'node:net';
import {chromium} from 'playwright';

mkdirSync('.audit',{recursive:true});
const root=mkdtempSync(resolve('.audit/SYN-handoff-browser-'));
process.env.AUDIT_DIR=root;process.env.T2P_REVIEW_DIRECTORY=join(root,'live');
const {openStore,claim}=await import('../backend/audit/store.js');
const {enqueuePipeline,failPipeline}=await import('../backend/audit/pipeline-store.js');
const db=openStore();
const socket=createServer();await new Promise(r=>socket.listen(0,'127.0.0.1',r));const port=socket.address().port;await new Promise(r=>socket.close(r));
const server=spawn(process.execPath,['backend/src/local-server.js','--dev'],{env:{...process.env,PORT:String(port)},stdio:'ignore'});
let browser;
try {
  browser=await chromium.launch();
  const pdf=execFileSync(process.env.T2P_PYTHON||'python',['-c',"import io,sys;from pypdf import PdfWriter;w=PdfWriter();w.add_blank_page(width=100,height=100);w.add_metadata({'/Title':'SYN public blank test document'});buffer=io.BytesIO();w.write(buffer);sys.stdout.buffer.write(buffer.getvalue())"]);
  for(const [language,width] of [['en',1440],['es',390]]) {
    const id=enqueuePipeline(db,{hospital_key:'798',mode:'full_audit',year:2026,review_date:'2026-11-10',request_key:`SYN-browser-${language}`});
    failPipeline(db,claim(db),{code:'website_verification_required',diagnostic:{http_status:403,source_url:'https://public.example/SYN-financial-assistance'}});
    const p=await browser.newPage({viewport:{width,height:900}});
    for(let n=0;;n++) {try{await p.goto(`http://127.0.0.1:${port}/?hospital=798&lang=${language}#audit-runs`);break}catch(e){if(n===40)throw e;await new Promise(r=>setTimeout(r,250))}}
    const form=p.locator('.hospital-runs .human-intervention');
    await form.locator('form').waitFor();
    assert.equal(await p.locator('.hospital-runs > .ops-controls button').nth(1).isDisabled(),true);
    await p.locator('header .review-nav').click();
    const task=p.locator('details').filter({has:p.locator('summary',{hasText:`audit-run-${id}`})}).first();
    await task.locator('summary').click();
    const panel=task.locator('.human-intervention');
    await panel.locator('input[type=url]').fill(`https://public.example/SYN-${language}.pdf`);
    await panel.locator('input[type=datetime-local]').fill('2026-11-09T12:00');
    await panel.locator('select').selectOption('en');
    await panel.locator('input[type=file]').setInputFiles({name:'SYN-blank.pdf',mimeType:'application/pdf',buffer:pdf});
    await panel.locator('input[type=checkbox]').check();
    await panel.getByRole('button',{name:language==='en'?'Import document':'Importar documento',exact:true}).click();
    await panel.getByText(language==='en'?'Imported documents: 1':'Documentos importados: 1',{exact:true}).waitFor();
    assert.equal(await p.evaluate(()=>document.documentElement.scrollWidth>innerWidth),false);
    await p.screenshot({path:`.playwright-mcp/human-handoff-${language}.png`});
    await panel.getByRole('button',{name:language==='en'?'Resume with imported documents':'Continuar con los documentos importados',exact:true}).click();
    await task.waitFor({state:'detached'});
    execFileSync(process.execPath,['backend/audit/worker.js','--once'],{env:{...process.env,PORT:String(port)},timeout:90000,stdio:'pipe'});
    const logs=await (await p.request.get(`http://127.0.0.1:${port}/api/pilot/v1/runs/audit-run-${id}/log.json`)).json();
    assert.equal(logs.human_intervention.status,'resumed');
    const child=await (await p.request.get(`http://127.0.0.1:${port}/api/pilot/v1/runs/${logs.human_intervention.resumed_run_id}/log.json`)).json();
    assert.equal(child.run.status,'partial');
    assert.equal(child.run.attempts,1);
    assert.equal(child.receipt.units.network_requests,0);
    assert.equal(child.imported_evidence_origin.parent_run_id,`audit-run-${id}`);
    console.log(JSON.stringify({language,width,result:'passed',network_requests:0}));
    await p.close();
  }
} finally {
  await browser?.close();
  await new Promise(r=>{if(server.exitCode!==null)r();else{server.once('exit',r);server.kill()}});
  db.close();rmSync(root,{recursive:true,force:true});
}
