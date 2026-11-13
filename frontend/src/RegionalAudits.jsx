import React,{useEffect,useRef,useState} from 'react';
import {useLocale} from './locale.jsx';
import {notifyCriterionChange} from './CriterionCoverage.jsx';
import HospitalMap from './HospitalMap.jsx';
import HospitalSearch from './HospitalSearch.jsx';
import reference from '../../references/ny-rating-regions-v1.json';

const endpoint='/api/criteria/regions';
const storage='regional-check-preview';
const restore=()=>{try{return JSON.parse(sessionStorage.getItem(storage));}catch{return null;}};
const statusLabels={queued:'Queued',running:'Running',completed:'Completed',failed:'Execution failed',cancelled:'Cancelled'};
export default function RegionalAudits({features,counties}){
 const {t,language,localHref}=useLocale();
 const [initial]=useState(restore);
 const [regions,setRegions]=useState(initial?.selection.regions??['NYC Metro','Central']);
 const [steps,setSteps]=useState(initial?.selection.steps??['k1']);
 const [selected,setSelected]=useState(initial&&initial.selection.scope!=='all'?initial.selection.hospitals:null);
 const [preview,setPreview]=useState(initial),[data,setData]=useState(null),[error,setError]=useState(false),[actionError,setActionError]=useState(false),[busy,setBusy]=useState(false),[tick,setTick]=useState(0);
 const lock=useRef(false);
 useEffect(()=>{
  const controller=new AbortController();
  fetch(endpoint,{signal:controller.signal}).then(async r=>{if(!r.ok)throw Error();return r.json();}).then(d=>{setData(d);setError(false);}).catch(e=>{if(e.name!=='AbortError')setError(true);});
  return()=>controller.abort();
 },[tick]);
 useEffect(()=>{const timer=setInterval(()=>setTick(n=>n+1),5000);return()=>clearInterval(timer);},[]);
 async function post(path,input){const r=await fetch(endpoint+path,{method:'POST',headers:{'Content-Type':'application/json','X-Review-Request':'1'},body:JSON.stringify(input)});if(!r.ok)throw Error();return r.json();}
 async function act(fn){if(lock.current)return;lock.current=true;setBusy(true);setActionError(false);try{await fn();setTick(n=>n+1);notifyCriterionChange();}catch{setActionError(true);}finally{lock.current=false;setBusy(false);}}
 function closePreview(){sessionStorage.removeItem(storage);setPreview(null);setActionError(false);}
 const rows=data?.hospitals.filter(h=>regions.includes(h.region))??[];
 const requirements=data?.hospitals[0]?.items??[];
 const chosen=selected??rows.map(h=>h.hospital_key);
 const points=features.filter(f=>regions.includes(f.properties.region));
 const date=value=>value?new Date(value).toLocaleString(language):t('Not checked');
 return <section className="regional-audits" lang={language}>
  <a href={localHref('?')}>{t('← Back to hospital map')}</a>
  <h1>{t('Compare two regions')}</h1>
  <p>{t('Choose two regions and the requirements to check. All hospitals in both regions are included. Preview once, approve once, and the checks continue automatically. Saved results are kept; missing prerequisites may also run.')}</p>
  {error&&<p role="alert">{t('Regional results unavailable. Refresh to try again.')}</p>}
  {!data&&<p role="status">{t('Loading criterion results…')}</p>}
  <fieldset disabled={busy||!!preview} className="regional-selectors"><legend>{t('Select two regions')}</legend>
   {regions.map((region,index)=><label key={index}>{t(index===0?'Region A':'Region B')}<select value={region} onChange={e=>{setRegions(regions.map((r,i)=>i===index?e.target.value:r));setSelected(null);}}>
    {Object.keys(reference.regions).map(name=><option key={name} value={name} disabled={regions[1-index]===name}>{reference.region_numbers[name]} · {t(name)}</option>)}
   </select><span>{rows.filter(h=>h.region===region).length} {t('hospitals')}</span></label>)}
  </fieldset>
  <div className="toolbar"><HospitalSearch hospitals={points} onSelect={f=>window.location.assign(localHref(`?hospital=${f.id}`))}/></div>
  <HospitalMap hospitals={points} counties={counties} onSelect={f=>window.location.assign(localHref(`?hospital=${f.id}`))}/>
  <p className="regional-map-legend">{t('Map activity: clock = queued; spinning ring = running; check = finished; warning = needs attention. Dot colors remain September 2025 ratings.')}</p>
  <fieldset disabled={busy||!!preview||!data} className="regional-requirements"><legend>{t('Choose requirements')}</legend>
   <div className="regional-actions"><button onClick={()=>setSteps(requirements.map(i=>i.id))}>{t('Select all requirements')}</button><button onClick={()=>setSteps([])}>{t('Clear requirements')}</button></div>
   <div className="regional-checklist">{requirements.map(item=><label key={item.id}><input type="checkbox" checked={steps.includes(item.id)} onChange={e=>setSteps(e.target.checked?[...steps,item.id]:steps.filter(s=>s!==item.id))}/>{item.id.toUpperCase()} · {t(item.title)}</label>)}</div>
  </fieldset>
  <p className="regional-scope" role="status">{selected===null?t('All hospitals included'):t('Custom hospital selection')}: <strong>{chosen.length} / {rows.length}</strong> {t('hospitals')}</p>
  <details className="regional-custom-selection"><summary>{t('Optional: choose specific hospitals')}</summary>
  <fieldset disabled={busy||!!preview||!data}><legend>{t('Choose hospitals')}</legend>
   <button onClick={()=>setSelected(null)}>{t('Reset to all hospitals')}</button>
   <button onClick={()=>setSelected([])}>{t('Clear hospital selection')}</button>
   <div className="regional-hospitals">{regions.map(region=><details key={region}><summary>{t(region)} · {rows.filter(h=>h.region===region).length}</summary>
    {rows.filter(h=>h.region===region).map(h=><label key={h.hospital_key}><input type="checkbox" checked={chosen.includes(h.hospital_key)} onChange={e=>setSelected(e.target.checked?[...chosen,h.hospital_key]:chosen.filter(key=>key!==h.hospital_key))}/><span>{h.name}<small>{h.active?t(statusLabels[h.active.status]):`${h.items.filter(i=>steps.includes(i.id)&&!i.saved).length} ${t('Unchecked selected requirements')}`}</small></span></label>)}
   </details>)}</div>
  </fieldset></details>
  {!preview&&<button className="regional-primary" disabled={busy||error||!chosen.length||!steps.length} onClick={()=>act(async()=>{const value=await post('/preview',{regions,steps,...(selected===null?{}:{hospitals:selected})});sessionStorage.setItem(storage,JSON.stringify(value));setPreview(value);})}>{t('Preview checks')} · {chosen.length} {t('hospitals')}</button>}
  {preview&&<section className="regional-preview" aria-labelledby="regional-preview-title">
   <h2 id="regional-preview-title">{t('Approve regional checks')}</h2>
   <p><strong>{preview.selection.hospitals.length} {t('Hospitals included')}</strong> · {preview.plan.jobs} {t('Hospitals needing new checks')} · {preview.plan.hospitals.length-preview.plan.jobs} {t('Hospitals with saved results')}</p>
   <p>{preview.plan.checks} {t('Unchecked selected requirements')} · {t('One approval covers all included hospitals. No manual batches are needed.')}</p>
   <p>{t('Missing source documents may be downloaded. Model calls cost money; this is not a fixed-price quote.')}</p>
   <p>{t('Maximum model tasks')}: {preview.plan.max_model_calls} · {t('Per hospital')}: 40 · {t('Time limit per hospital (minutes)')}: 20</p>
   <details><summary>{t('Hospital and prerequisite details')}</summary><ul>{preview.plan.hospitals.map(h=><li key={h.hospital_key}><strong>{h.name} · {t(h.region)}</strong><p>{t('Selected checks')}: {h.requested.join(', ')||t('None')}</p><p>{t('Criteria to execute, including missing prerequisites')}: {h.run.join(', ')||t('None')}</p><p>{t('Saved prerequisites to reuse')}: {h.reuse.join(', ')||t('None')}</p></li>)}</ul></details>
   {!preview.plan.jobs&&<p>{t('All selected requirements already have saved results. See the comparison below or review unclear results.')}</p>}
   <button className="regional-primary" disabled={busy||!preview.plan.jobs} onClick={()=>act(async()=>{await post(`/${preview.id}/start`,{confirm:true});closePreview();})}>{t(actionError?'Retry same request':'Approve and check all included hospitals')}</button>
   <button disabled={busy} onClick={closePreview}>{t('Close run request')}</button>
  </section>}
  {actionError&&<p role="alert">{t('Regional request not confirmed. Retry the same approval safely. If preparation changed, close it and create a new preview.')}</p>}
  <h2>{t('Check progress and findings')}</h2>
  {data?.batches.filter(b=>b.selection.regions.every(r=>regions.includes(r))).map(batch=>{
   const pending=batch.jobs.filter(j=>['queued','running'].includes(j.status)).length;
   const failures=batch.jobs.filter(j=>j.status==='failed').length;
   const stopped=batch.jobs.filter(j=>j.status==='cancelled').length;
   const scope=new Set(batch.selection.hospitals);
   const outcomes=rows.filter(h=>scope.has(h.hospital_key)).flatMap(h=>h.items.filter(i=>batch.selection.steps.includes(i.id)).map(i=>({...i,hospital:h})));
   const counts={met:0,unmet:0,unclear:0,unrun:0};for(const i of outcomes)counts[i.effective]++;
   return <div className="regional-batch" key={batch.id}>
    <h3>{t(pending?'Checks in progress':stopped?'Checks stopped':failures?'Finished with execution errors':'All checks finished')} · {batch.jobs.length-pending}/{batch.jobs.length}</h3>
    <p>{date(batch.created)} · {batch.selection.steps.join(', ')}</p>
    <p>{t('Current findings for included hospitals and selected requirements')}</p>
    <p className="regional-findings"><span>{t('Condition met')}: <strong>{counts.met}</strong></span><span>{t('Condition not met')}: <strong>{counts.unmet}</strong></span><span>{t('Unclear')}: <strong>{counts.unclear}</strong></span><span>{t('Not checked')}: <strong>{counts.unrun}</strong></span></p>
    <p>{batch.selection.hospitals.length} {t('Hospitals included')} · {t('Execution errors')}: {failures}</p>
    {!!counts.unclear&&<details className="regional-unclear"><summary>{t('Review unclear results')} ({counts.unclear})</summary><ul>{outcomes.filter(i=>i.effective==='unclear').map(i=><li key={`${i.hospital.hospital_key}-${i.id}`}><a href={localHref(`?hospital=${i.hospital.hospital_key}#criterion-${i.id}`)}>{i.hospital.name} · {i.id.toUpperCase()} · {t(i.title)}</a></li>)}</ul></details>}
    <a href="#regional-statistics-title">{t('View regional comparison')}</a>
    <details><summary>{t('Execution details')}</summary>{regions.map(region=>{const keys=new Set(batch.plan.hospitals.filter(h=>h.region===region).map(h=>h.hospital_key));const jobs=batch.jobs.filter(j=>keys.has(j.hospital));return <p key={region}><strong>{t(region)}</strong>: {Object.entries(statusLabels).map(([state,label])=>`${t(label)}: ${jobs.filter(j=>j.status===state).length}`).join(' · ')}</p>;})}</details>
    {!batch.cancelled&&batch.jobs.some(j=>j.status==='queued')&&<><p>{t('Cancel stops queued hospitals only. A hospital already running finishes its bounded check.')}</p><button disabled={busy} onClick={()=>act(()=>post(`/${batch.id}/cancel`,{}))}>{t('Stop remaining checks')}</button></>}
   </div>;
  })}
  <h2 id="regional-statistics-title">{t('Regional requirement statistics')}</h2>
  <p>{t('Current saved findings only. Unchecked hospitals are not failures. Historical grades stay separate. Counts include the entire region, not just this batch.')}</p>
  <div className="regional-stats-scroll" tabIndex={0} role="region" aria-label={t('Regional requirement statistics')}><table className="regional-statistics"><thead><tr><th>{t('Requirement')}</th>{regions.map(region=><th key={region}>{t(region)}</th>)}</tr></thead>
   <tbody>{requirements.filter(i=>steps.includes(i.id)).map(item=><tr key={item.id}><th>{item.id.toUpperCase()} · {t(item.title)}</th>{regions.map(region=>{const r=data.regions.find(r=>r.region===region),s=r.items.find(i=>i.id===item.id);return <td key={region}><div>{t('Condition met')}: {s.met} · {t('Condition not met')}: {s.unmet}</div><div>{t('Unclear')}: {s.unclear} · {t('Not checked')}: {s.unrun}</div><div>{t('Checked')}: {s.checked}/{r.total} · {t('Confirmed requirements')}: {s.confirmed}/{r.total}</div><small>{t('Last updated')}: {date(s.updated_at)}</small></td>;})}</tr>)}</tbody>
  </table></div>
 </section>;
}
