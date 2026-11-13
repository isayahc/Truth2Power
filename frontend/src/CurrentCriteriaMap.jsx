import React,{useEffect,useState} from 'react';
import {useLocale} from './locale.jsx';
import HospitalMap from './HospitalMap.jsx';
import HospitalSearch from './HospitalSearch.jsx';
import {StatusBadge,statusLabels} from './CriterionStatus.jsx';
import {criteriaMapState,criterionColors} from './criteria-map.js';
import rubric from '../../rubrics/css-17-v1.json';

const valid=value=>/^k([1-9]|1[0-7])$/.test(value)?value:'all';
export default function CurrentCriteriaMap({hospitals,counties,onSelect,region}){
 const {t,language}=useLocale();
 const [requirement,setRequirement]=useState(()=>valid(new URLSearchParams(location.search).get('requirement')));
 const [filter,setFilter]=useState(null),[data,setData]=useState(null),[error,setError]=useState(false);
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
 return <div className="content current-criteria-map" lang={language}>
  <section className="map-block" aria-label={t('Hospital locations')}>
   <div className="toolbar"><strong>{t('2026 — Current requirement checks')}</strong><HospitalSearch hospitals={visible} onSelect={onSelect}/></div>
   <div className="map-region-filter"><label htmlFor="map-requirement">{t('Requirement')}</label><select id="map-requirement" value={requirement} onChange={e=>choose(e.target.value)}>
    <option value="all">{t('All requirements')}</option>{rubric.measures.map((m,index)=><option key={m.measure_id} value={`k${index+1}`}>K{index+1} · {t(m.title)}</option>)}
   </select></div>
   <div className="current-map-legend" aria-label={t('Status legend')}><strong>{t('Status legend')}</strong>{Object.keys(statusLabels).map(state=><StatusBadge key={state} status={state} label={labels[state]}/>)}</div>
   {error?<p role="alert">{t('Current results unavailable. Waiting to reconnect.')}</p>:!data?<p role="status">{t('Loading criterion results…')}</p>:<>
    <HospitalMap hospitals={visible} counties={counties} onSelect={onSelect}/>
    <div className="map-footer"><strong>{visible.length} {t('of')} {hospitals.length} {t('hospitals')}</strong><span>{t('Select a hospital to review the selected requirement and its evidence.')}</span></div>
   </>}
  </section>
  <aside className="current-criteria-summary">
   <h2>{t('Current criteria results')}</h2><p>{region?t(region):t('All regions')} · {requirement==='all'?t('All requirements'):requirement.toUpperCase()}</p>
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
   {requirement==='all'&&<p>{t('All-requirement colors: green means all 17 met; red means at least one unmet; blue means evidence needs review; gray means assessment incomplete. Running checks and technical errors are shown separately.')}</p>}
   <p>{t('A small red X beside a circle means the latest attempt failed; the circle keeps the previous finding.')}</p>
  </aside>
 </div>;
}
