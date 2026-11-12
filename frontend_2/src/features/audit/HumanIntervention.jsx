// Website-verification flow (Phase 3) — port of the old app's
// HumanIntervention.jsx. GETs go through getJson, writes through
// reviewRequest (x-review-request: 1), exactly like the old request()
// helper did. The inbox loads once on mount and reloads after a resume;
// it never polls.
import React, { useEffect, useState } from 'react';
import { useLocale } from '../../i18n/locale.jsx';
import { getJson, reviewRequest } from '../../api/client.js';

export function HumanIntervention({runId,onResume}) {
  const {t,language,localHref}=useLocale();
  const [task,setTask]=useState(null),[error,setError]=useState(false),[busy,setBusy]=useState(false),[source,setSource]=useState(''),[retrieved,setRetrieved]=useState(''),[lang,setLang]=useState('und'),[confirmed,setConfirmed]=useState(false),[file,setFile]=useState(null),[resumed,setResumed]=useState(null);
  const path=`/api/pilot/v1/runs/${runId}/intervention`;
  useEffect(()=>{let live=true; getJson(path).then(x=>{if(live)setTask(x)}).catch(()=>{if(live)setError(true)});return()=>{live=false}},[path]);
  async function upload(e){
    e.preventDefault();setBusy(true);setError(false);
    try {
      if(!file || file.size>4*1024*1024 || !confirmed) throw Error();
      const bytes=await new Promise((resolve,reject)=>{const r=new FileReader();r.onload=()=>resolve(String(r.result).split(',')[1]);r.onerror=reject;r.readAsDataURL(file)});
      await reviewRequest(path+'/documents',{source_url:source,retrieved_at:new Date(retrieved).toISOString(),language:lang,public_document:true,bytes});
      setTask(await getJson(path));setSource('');setConfirmed(false);
    } catch {setError(true)} finally {setBusy(false)}
  }
  async function resume(){setBusy(true);setError(false);try{const next=await reviewRequest(path+'/resume',{confirm:true});setResumed(next.audit_run_id);onResume?.();}catch{setError(true)}finally{setBusy(false)}}
  return <section className="human-intervention" lang={language}>
    <h4>{t('Human intervention required: website verification.')}</h4>
    {error && <p role="alert">{t('Unable to complete this action. Check the public PDF, URL and retrieval date, then retry.')}</p>}
    {!task && !error && <p role="status">{t('Loading…')}</p>}
    {task && <>
      <p>{t('Open the blocked page in your browser, complete any website verification yourself, and download the public assistance documents.')}</p>
      <a href={task.source_url} target="_blank" rel="noreferrer">{t('Open blocked website')}</a>
      {resumed || task.resumed_run_id ? <p role="status">{t('Processing imported evidence')}: <a href={localHref(`?hospital=${task.hospital_key}#audit-runs`)}>{resumed||task.resumed_run_id}</a></p> : <>
        <p>{t('Import public blank PDFs only (4 MB each). Do not upload patient records or completed applications. Imported documents still require scope review.')}</p>
        <form onSubmit={upload}>
          <label>{t('Public document URL')}<input type="url" required value={source} onChange={e=>setSource(e.target.value)} placeholder="https://" /></label>
          <label>{t('Retrieved at')}<input type="datetime-local" required value={retrieved} onChange={e=>setRetrieved(e.target.value)} /></label>
          <label>{t('Document language')}<select value={lang} onChange={e=>setLang(e.target.value)}><option value="und">{t('Unknown')}</option><option value="en">English</option><option value="es">Español</option></select></label>
          <label>{t('Public PDF')}<input type="file" accept="application/pdf,.pdf" required onChange={e=>setFile(e.target.files[0])} /></label>
          <label><input type="checkbox" required checked={confirmed} onChange={e=>setConfirmed(e.target.checked)} />{t('I confirm this is a public blank document with no patient information, and the source and retrieval date are accurate.')}</label>
          <button disabled={busy}>{t('Import document')}</button>
        </form>
        <p role="status">{t('Imported documents')}: {task.documents.length}</p>
        <ul>{task.documents.map(d=><li key={d.sha256+d.source_url}>{d.source_url} · SHA-256: <code>{d.sha256.slice(0,12)}</code></li>)}</ul>
        <button disabled={busy||!task.documents.length} onClick={resume}>{t('Resume with imported documents')}</button>
      </>}
    </>}
  </section>;
}

export function HumanInterventionInbox(){
  const {t,language}=useLocale();const [items,setItems]=useState([]),[error,setError]=useState(false),[tick,setTick]=useState(0);
  useEffect(()=>{let live=true;getJson('/api/pilot/v1/interventions').then(x=>{if(live)setItems(x.items)}).catch(()=>{if(live)setError(true)});return()=>{live=false}},[tick]);
  return <section lang={language}><h3>{t('Website access tasks')}</h3>{error&&<p role="alert">{t('Unable to load audit records.')}</p>}
    {!items.length&&!error&&<p>{t('No website access tasks.')}</p>}
    {items.map(item=><details key={item.audit_run_id}><summary>{item.hospital_name} · {item.audit_run_id}</summary><HumanIntervention runId={item.audit_run_id} onResume={()=>setTick(n=>n+1)} /></details>)}
  </section>;
}
