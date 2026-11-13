import React,{useEffect,useRef,useState} from 'react';
import {useLocale} from './locale.jsx';
import HospitalMap from './HospitalMap.jsx';
import HospitalSearch from './HospitalSearch.jsx';
import {StatusBadge,statusLabels} from './CriterionStatus.jsx';
import {criteriaMapState,criterionColors} from './criteria-map.js';
import rubric from '../../rubrics/css-17-v1.json';
import reference from '../../references/ny-rating-regions-v1.json';
import {notifyCriterionChange} from './CriterionCoverage.jsx';

const valid=value=>/^k([1-9]|1[0-7])$/.test(value)?value:'all';
const restore=key=>{try{return JSON.parse(sessionStorage.getItem(key));}catch{return null;}};
export default function CurrentCriteriaMap({hospitals,counties,onSelect,region,regions,controls}){
 const {t,language}=useLocale();
 const [requirement,setRequirement]=useState(()=>valid(new URLSearchParams(location.search).get('requirement')));
 const [filter,setFilter]=useState(null),[data,setData]=useState(null),[error,setError]=useState(false);
 const [intent,setIntent]=useState(()=>restore('map-run-request')),[lastBatch,setLastBatch]=useState(()=>restore('map-run-result'));
 const [busy,setBusy]=useState(false),[runError,setRunError]=useState(false),lock=useRef(false);
 useEffect(()=>{
  const restore=()=>{setRequirement(valid(new URLSearchParams(location.search).get('requirement')));setFilter(null);};
  window.addEventListener('popstate',restore);return()=>window.removeEventListener('popstate',restore);
 },[]);
 useEffect(()=>{
  let alive=true,controller;
  const load=async()=>{controller?.abort();controller=new AbortController();try{
   const r=await fetch('/api/criteria/regions',{signal:controller.signal});if(!r.ok)throw Error();
   const value=await r.json();if(alive){setData(value);setError(false);}
  }catch(e){if(alive&&e.name!=='AbortError')setError(true);}};
  load();const timer=setInterval(load,5000);window.addEventListener('criterion-change',load);
  return()=>{alive=false;controller?.abort();clearInterval(timer);window.removeEventListener('criterion-change',load);};
 },[]);
 const labels={...statusLabels,...(requirement==='all'?{met:'All 17 requirements met',unmet:'At least one requirement not met',unrun:'Assessment incomplete'}:{})};
 const rows=new Map((data?.hospitals??[]).map(h=>[h.hospital_key,h]));
 const totals={met:0,unmet:0,unclear:0,error:0,unrun:0};
 const hospitalCounts=Object.fromEntries(Object.keys(statusLabels).map(key=>[key,0]));
 let updated=null;
 const points=hospitals.map(h=>{
  const result=criteriaMapState(rows.get(h.id),requirement);
  for(const key of Object.keys(totals))totals[key]+=result.counts[key];
  hospitalCounts[result.state]++;
  if(result.updated&&(!updated||result.updated>updated))updated=result.updated;
  const detail=`${result.counts.met}/${result.total} ${t('Requirements confirmed met')} · ${result.counts.unmet} ${t('Condition not met')} · ${result.assessed}/${result.total} ${t('Assessed requirements')} · ${result.percent===null?t('Not assessed'):`${result.percent}% ${t('Met among assessed requirements')}`}`;
  return {...h,markerStatus:result.state,markerError:result.hasError,markerColor:criterionColors[result.state],markerLabel:t(labels[result.state]),markerDetail:detail,markerRequirement:requirement};
 });
 const visible=filter?points.filter(h=>h.markerStatus===filter):points;
 const assessed=totals.met+totals.unmet,total=hospitals.length*(requirement==='all'?17:1);
 function choose(value){setRequirement(value);setFilter(null);const url=new URL(location.href);url.searchParams.set('year','2026');url.searchParams.set('requirement',value);history.replaceState(null,'',url);}
 async function runJobs(){
  if(lock.current)return;lock.current=true;setBusy(true);setRunError(false);
  const request=intent??{request_key:crypto.randomUUID(),confirm:true,regions:regions.length?[...regions]:Object.keys(reference.regions),steps:requirement==='all'?rubric.measures.map((_,i)=>`k${i+1}`):[requirement]};
  try{
   sessionStorage.setItem('map-run-request',JSON.stringify(request));setIntent(request);
   const response=await fetch('/api/criteria/regions/run',{method:'POST',headers:{'Content-Type':'application/json','X-Review-Request':'1'},body:JSON.stringify(request)});
   if(!response.ok){if(response.status>=400&&response.status<500){sessionStorage.removeItem('map-run-request');setIntent(null);}throw Error();}
   const result=await response.json();setLastBatch(result);sessionStorage.setItem('map-run-result',JSON.stringify(result));
   sessionStorage.removeItem('map-run-request');setIntent(null);notifyCriterionChange();
  }catch{setRunError(true);}finally{lock.current=false;setBusy(false);}
 }
 const batch=data?.batches?.find(b=>b.id===lastBatch?.id)??lastBatch;
 const queued=batch?.jobs.filter(j=>j.status==='queued').length??0,running=batch?.jobs.filter(j=>j.status==='running').length??0;
 const runLabel=intent?'Retry same run request':'Run jobs';
 return <div className="content current-criteria-map" lang={language}>
  <section className="map-block" aria-label={t('Hospital locations')}>
   <div className="toolbar atlas-toolbar">
    <fieldset className="atlas-run-scope" disabled={busy||!!intent} aria-label={t('Run scope')}>
    {controls}
    <label className="atlas-requirement-control" htmlFor="map-requirement">{t('Requirement')}<select id="map-requirement" value={requirement} onChange={e=>choose(e.target.value)}>
    <option value="all">{t('All requirements')}</option>{rubric.measures.map((m,index)=><option key={m.measure_id} value={`k${index+1}`}>K{index+1} · {t(m.title)}</option>)}
    </select></label><HospitalSearch hospitals={visible} onSelect={onSelect}/>
    </fieldset>
    <button className="map-run-jobs" disabled={busy||!data||error||!hospitals.length} onClick={runJobs} title={t('Runs the selected requirements for every hospital in the selected regions. Clicking starts paid AI checks, including saved results and needed prerequisites.')} aria-label={`${t(runLabel)} · ${intent?intent.steps.join(', '):requirement==='all'?t('All requirements'):requirement.toUpperCase()} · ${hospitals.length} ${t('hospitals')}`}>{t(busy?'Starting jobs…':runLabel)}</button>
   </div>
   {runError&&<p className="map-job-status" role="alert">{t(intent?'Run response not received. Retry the same request safely; its original scope is retained.':'Jobs could not start. An active check or changed preparation may block this scope. Try again after existing jobs finish.')}</p>}
   {batch&&<p className="map-job-status" role="status">{batch.selection.steps.join(', ').toUpperCase()} · {batch.selection.regions.map(r=>t(r)).join(', ')} · {batch.selection.hospitals.length} {t('hospitals')} · {queued} {t('Queued')} · {running} {t('Running')} · {batch.jobs.filter(j=>j.status==='completed').length} {t('Completed')} · {batch.jobs.filter(j=>j.status==='failed').length} {t('Execution errors')}</p>}
   <div className="current-map-legend" aria-label={t('Status legend')}><strong>{t('Status legend')}</strong>{Object.keys(statusLabels).map(state=><StatusBadge key={state} status={state} label={labels[state]}/>)}</div>
   {error?<p role="alert">{t('Current results unavailable. Waiting to reconnect.')}</p>:!data?<p role="status">{t('Loading criterion results…')}</p>:<>
    <HospitalMap hospitals={visible} counties={counties} onSelect={onSelect}/>
    <div className="map-footer"><strong>{visible.length} {t('of')} {hospitals.length} {t('hospitals')}</strong><span>{t('Select a hospital to review the selected requirement and its evidence.')}</span></div>
   </>}
  </section>
  <aside className="current-criteria-summary">
   <h2>{t('Current criteria results')}</h2><p>{region?t(region):t('All regions')} · {requirement==='all'?t('All requirements'):requirement.toUpperCase()}</p>
   <p className="map-run-note">{t('Run jobs starts paid AI checks for all hospitals in the selected regions, including saved results and needed prerequisites. Status filters and map zoom do not change the run scope.')}</p>
   <p className="map-run-note">{t('Maximum model tasks')}: {hospitals.length*40} · {t('Per hospital')}: 40 · {t('Time limit per hospital (minutes)')}: 20</p>
   {!data||error?<p>{t(error?'Current results unavailable. Waiting to reconnect.':'Loading criterion results…')}</p>:<>
    <p className="criteria-percent"><strong>{assessed?`${Math.round(totals.met/assessed*100)}%`:t('Not assessed')}</strong><br/>{t('Met among assessed requirements')}</p>
    <p>{totals.met}/{total} {t('Requirements confirmed met')} · {assessed}/{total} {t('Assessed requirements')}</p>
    <p>{t('Only explicit unmet findings count against a hospital. Unclear results, technical errors and unchecked requirements are not failures or passes.')}</p>
    <dl>{['met','unmet','unclear','error','unrun'].map(state=><div key={state}><dt><StatusBadge status={state}/></dt><dd>{totals[state]}</dd></div>)}</dl>
    <h3>{t('Filter hospitals by status')}</h3><p>{t('Status counts below count hospitals, not requirements.')}</p>
    <div className="criteria-status-filters"><button aria-pressed={filter===null} onClick={()=>setFilter(null)}>{t('Show all')} ({points.length})</button>{Object.entries(hospitalCounts).map(([state,count])=><button key={state} aria-pressed={filter===state} onClick={()=>setFilter(filter===state?null:state)}><StatusBadge status={state} label={labels[state]}/> ({count})</button>)}</div>
    <p>{t('Last updated')}: {updated?new Date(updated).toLocaleString(language):t('Not assessed')}</p>
   </>}
   <p>{t('A red circle means not met. A red X means a technical error, not a hospital failure. Previous valid findings remain available.')}</p>
   {requirement==='all'&&<p>{t('All-requirement colors: green means all 17 met; red means at least one unmet; yellow means evidence needs review; gray means assessment incomplete. Running checks and technical errors are shown separately.')}</p>}
   <p>{t('A small red X beside a circle means the latest attempt failed; the circle keeps the previous finding.')}</p>
   <p>{t('Regions follow Attachment G and use the hospital’s county, not its service area.')}</p>
  </aside>
 </div>;
}
