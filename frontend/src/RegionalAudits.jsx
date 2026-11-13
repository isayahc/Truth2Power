import React,{useEffect,useRef,useState} from 'react';
import {useLocale} from './locale.jsx';
import {notifyCriterionChange} from './CriterionCoverage.jsx';
import HospitalMap from './HospitalMap.jsx';
import HospitalSearch from './HospitalSearch.jsx';
import reference from '../../references/ny-rating-regions-v1.json';

const endpoint='/api/criteria/regions';
const storage='regional-check-preview';
const restore=()=>{try{return JSON.parse(sessionStorage.getItem(storage));}catch{return null;}};
const statusLabels={queued:'Queued',running:'Running',completed:'Completed',failed:'Needs review',cancelled:'Cancelled'};
export default function RegionalAudits({features,counties}){
 const {t,language,localHref}=useLocale();
 const [initial]=useState(restore);
 const [regions,setRegions]=useState(initial?.selection.regions??['NYC Metro','Central']);
 const [steps,setSteps]=useState(initial?.selection.steps??['k1']);
 const [selected,setSelected]=useState(initial?.selection.hospitals??[]);
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
 const eligible=h=>!h.active&&h.items.some(i=>steps.includes(i.id)&&!i.saved);
 const points=features.filter(f=>regions.includes(f.properties.region));
 function nextBatch(){
  const lists=regions.map(region=>rows.filter(h=>h.region===region&&eligible(h)));
  const keys=[];for(let n=0;keys.length<10 && lists.some(list=>n<list.length);n++)for(const list of lists)if(list[n]&&keys.length<10)keys.push(list[n].hospital_key);
  setSelected(keys);
 }
 const date=value=>value?new Date(value).toLocaleString(language):t('Not checked');
 return <section className="regional-audits" lang={language}>
  <a href={localHref('?')}>{t('← Back to hospital map')}</a>
  <h1>{t('Compare two regions')}</h1>
  <p>{t('Choose two regions, select requirements, then preview a batch of up to 10 hospitals. Selected requirements with saved results are skipped. Missing prerequisites may also run.')}</p>
  {error&&<p role="alert">{t('Regional results unavailable. Refresh to try again.')}</p>}
  {!data&&<p role="status">{t('Loading criterion results…')}</p>}
  <fieldset disabled={busy||!!preview} className="regional-selectors"><legend>{t('Select two regions')}</legend>
   {regions.map((region,index)=><label key={index}>{t(index===0?'Region A':'Region B')}<select value={region} onChange={e=>{setRegions(regions.map((r,i)=>i===index?e.target.value:r));setSelected([]);}}>
    {Object.keys(reference.regions).map(name=><option key={name} value={name} disabled={regions[1-index]===name}>{reference.region_numbers[name]} · {t(name)}</option>)}
   </select><span>{rows.filter(h=>h.region===region).length} {t('hospitals')}</span></label>)}
  </fieldset>
  <div className="toolbar"><HospitalSearch hospitals={points} onSelect={f=>window.location.assign(localHref(`?hospital=${f.id}`))}/></div>
  <HospitalMap hospitals={points} counties={counties} onSelect={f=>window.location.assign(localHref(`?hospital=${f.id}`))}/>
  <p className="regional-map-legend">{t('Map activity: clock = queued; spinning ring = running; check = finished; warning = needs attention. Dot colors remain September 2025 ratings.')}</p>
  <fieldset disabled={busy||!!preview||!data} className="regional-requirements"><legend>{t('Choose requirements')}</legend>
   <div className="regional-actions"><button onClick={()=>{setSteps(requirements.map(i=>i.id));setSelected([]);}}>{t('Select all requirements')}</button><button onClick={()=>{setSteps([]);setSelected([]);}}>{t('Clear requirements')}</button></div>
   <div className="regional-checklist">{requirements.map(item=><label key={item.id}><input type="checkbox" checked={steps.includes(item.id)} onChange={e=>{setSteps(e.target.checked?[...steps,item.id]:steps.filter(s=>s!==item.id));setSelected([]);}}/>{item.id.toUpperCase()} · {t(item.title)}</label>)}</div>
  </fieldset>
  <fieldset disabled={busy||!!preview||!data||!steps.length}><legend>{t('Choose hospitals')}</legend>
   <p>{t('Limit: 10 hospitals per batch. Preview and approve another batch to continue.')}</p>
   <button onClick={nextBatch}>{t('Select next batch')}</button> <span>{selected.length}/10 {t('hospitals')}</span>
   <div className="regional-hospitals">{regions.map(region=><details key={region}><summary>{t(region)} · {rows.filter(h=>h.region===region).length}</summary>
    {rows.filter(h=>h.region===region).map(h=><label key={h.hospital_key}><input type="checkbox" checked={selected.includes(h.hospital_key)} disabled={!eligible(h)||(!selected.includes(h.hospital_key)&&selected.length>=10)} onChange={e=>setSelected(e.target.checked?[...selected,h.hospital_key]:selected.filter(key=>key!==h.hospital_key))}/><span>{h.name}<small>{h.active?t(statusLabels[h.active.status]):`${h.items.filter(i=>steps.includes(i.id)&&!i.saved).length} ${t('Unchecked selected requirements')}`}</small></span></label>)}
   </details>)}</div>
  </fieldset>
  {!preview&&<button disabled={busy||error||!selected.length||!steps.length} onClick={()=>act(async()=>{const value=await post('/preview',{regions,steps,hospitals:selected});sessionStorage.setItem(storage,JSON.stringify(value));setPreview(value);})}>{t('Preview regional checks')}</button>}
  {preview&&<section className="regional-preview" aria-labelledby="regional-preview-title">
   <h2 id="regional-preview-title">{t('Approve regional checks')}</h2>
   <p>{preview.plan.jobs} {t('hospitals')} · {preview.plan.checks} {t('Unchecked selected requirements')}</p>
   <p>{t('Missing source documents may be downloaded. Model calls cost money; this is not a fixed-price quote.')}</p>
   <p>{t('Maximum model tasks')}: {preview.plan.max_model_calls} · {t('Per hospital')}: 40 · {t('Time limit per hospital (minutes)')}: 20</p>
   <ul>{preview.plan.hospitals.map(h=><li key={h.hospital_key}><strong>{h.name} · {t(h.region)}</strong><p>{t('Selected checks')}: {h.requested.join(', ')||t('None')}</p><p>{t('Criteria to execute, including missing prerequisites')}: {h.run.join(', ')||t('None')}</p><p>{t('Saved prerequisites to reuse')}: {h.reuse.join(', ')||t('None')}</p></li>)}</ul>
   <button disabled={busy||!preview.plan.jobs} onClick={()=>act(async()=>{await post(`/${preview.id}/start`,{confirm:true});closePreview();setSelected([]);})}>{t(actionError?'Retry same request':'Approve and start batch')}</button>
   <button disabled={busy} onClick={closePreview}>{t('Close run request')}</button>
  </section>}
  {actionError&&<p role="alert">{t('Regional request not confirmed. Retry the same approval safely. If preparation changed, close it and create a new preview.')}</p>}
  <h2>{t('Batch progress')}</h2>
  <p>{t('Cancel stops queued hospitals only. A hospital already running finishes its bounded check.')}</p>
  {data?.batches.filter(b=>b.selection.regions.every(r=>regions.includes(r))).map(batch=><div className="regional-batch" key={batch.id}>
   <p>{date(batch.created)} · {batch.selection.steps.join(', ')}</p>
   {regions.map(region=>{const keys=new Set(batch.plan.hospitals.filter(h=>h.region===region).map(h=>h.hospital_key));const jobs=batch.jobs.filter(j=>keys.has(j.hospital));return <p key={region}><strong>{t(region)}</strong>: {Object.entries(statusLabels).map(([state,label])=>`${t(label)}: ${jobs.filter(j=>j.status===state).length}`).join(' · ')}</p>;})}
   <button disabled={busy||!!batch.cancelled||!batch.jobs.some(j=>j.status==='queued')} onClick={()=>act(()=>post(`/${batch.id}/cancel`,{}))}>{t('Cancel queued hospitals')}</button>
  </div>)}
  <h2>{t('Regional requirement statistics')}</h2>
  <p>{t('Current saved findings only. Unchecked hospitals are not failures. Historical grades stay separate. Counts include the entire region, not just this batch.')}</p>
  <div className="regional-stats-scroll" tabIndex={0} role="region" aria-label={t('Regional requirement statistics')}><table className="regional-statistics"><thead><tr><th>{t('Requirement')}</th>{regions.map(region=><th key={region}>{t(region)}</th>)}</tr></thead>
   <tbody>{requirements.filter(i=>steps.includes(i.id)).map(item=><tr key={item.id}><th>{item.id.toUpperCase()} · {t(item.title)}</th>{regions.map(region=>{const r=data.regions.find(r=>r.region===region),s=r.items.find(i=>i.id===item.id);return <td key={region}><div>{t('Condition met')}: {s.met} · {t('Condition not met')}: {s.unmet}</div><div>{t('Unclear')}: {s.unclear} · {t('Not checked')}: {s.unrun}</div><div>{t('Checked')}: {s.checked}/{r.total} · {t('Confirmed requirements')}: {s.confirmed}/{r.total}</div><small>{t('Last updated')}: {date(s.updated_at)}</small></td>;})}</tr>)}</tbody>
  </table></div>
 </section>;
}
