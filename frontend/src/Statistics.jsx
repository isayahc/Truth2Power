import React,{useEffect,useState} from 'react';
import {useLocale} from './locale.jsx';
import RegionPicker,{regionsFromUrl} from './RegionPicker.jsx';
import rubric from '../../rubrics/css-17-v1.json';
import reference from '../../references/ny-rating-regions-v1.json';
import {requirementStats} from './statistics.js';

const readRequirement=()=>{const value=new URLSearchParams(location.search).get('requirement');return /^k([1-9]|1[0-7])$/.test(value)?value:'all';};
export default function Statistics(){
 const {t,language,localHref}=useLocale();
 const [requirement,setRequirement]=useState(readRequirement),[regions,setRegions]=useState(regionsFromUrl);
 const [data,setData]=useState(null),[error,setError]=useState(false),[attempt,setAttempt]=useState(0);
 useEffect(()=>{const restore=()=>{setRequirement(readRequirement());setRegions(regionsFromUrl());};window.addEventListener('popstate',restore);return()=>window.removeEventListener('popstate',restore);},[]);
 useEffect(()=>{
  let alive=true,controller;
  const load=async()=>{controller?.abort();controller=new AbortController();try{const response=await fetch('/api/criteria/regions',{signal:controller.signal});if(!response.ok)throw Error();const value=await response.json();if(alive){setData(value);setError(false);}}catch(e){if(alive&&e.name!=='AbortError')setError(true);}};
  load();const timer=setInterval(load,10000);return()=>{alive=false;controller?.abort();clearInterval(timer);};
 },[attempt]);
 function choose(nextRequirement,nextRegions=regions){
  setRequirement(nextRequirement);setRegions(nextRegions);
  const url=new URL(location.href);url.searchParams.set('requirement',nextRequirement);url.searchParams.delete('region');for(const region of nextRegions)url.searchParams.append('region',region);history.pushState(null,'',url);
 }
 const hospitals=(data?.hospitals??[]).filter(h=>!regions.length||regions.includes(h.region));
 const title=id=>`${id.toUpperCase()} · ${t(rubric.measures[Number(id.slice(1))-1].title)}`;
 const rows=requirement==='all'?rubric.measures.map((_,i)=>({id:`k${i+1}`,label:title(`k${i+1}`),counts:requirementStats(hospitals,`k${i+1}`)})):
  [...(regions.length?regions:Object.keys(reference.regions)).map(region=>({id:region,label:t(region),counts:requirementStats(hospitals.filter(h=>h.region===region),requirement)})),{id:'total',label:t('Selected regions total'),counts:requirementStats(hospitals,requirement)}];
 const percent=(n,d)=>d?new Intl.NumberFormat(language,{style:'percent',maximumFractionDigits:1}).format(n/d):t('Not assessed');
 const columns=['Checked','Requirement met','Requirement not met','Needs evidence review','Clear answers'];
 return <section className="statistics-page" lang={language}>
  <a href={localHref('/')}>{t('← Back to hospital map')}</a><h1>{t('Statistics')}</h1>
  <div className="toolbar atlas-toolbar statistics-filters">
   <label htmlFor="statistics-requirement">{t('Requirement')} <select id="statistics-requirement" value={requirement} onChange={e=>choose(e.target.value)}><option value="all">{t('All requirements')}</option>{rubric.measures.map((_,i)=><option key={i} value={`k${i+1}`}>{title(`k${i+1}`)}</option>)}</select></label>
   <RegionPicker values={regions} onChange={values=>choose(requirement,values)}/>
  </div>
  <p>{t('Latest saved agent answers, before human decisions. Clear answers = met + unmet. Rates exclude checks without a valid finding; a failed retry keeps its previous valid answer.')}</p>
  {error?<p role="alert">{t('Statistics could not be refreshed.')} <button onClick={()=>setAttempt(attempt+1)}>{t('Try again')}</button></p>:null}
  {!data&&!error?<p role="status">{t('Loading statistics…')}</p>:data&&<>
   <h2>{requirement==='all'?t('All requirements'):title(requirement)}</h2>
   <table className="statistics-table"><thead><tr><th scope="col">{t(requirement==='all'?'Requirement':'Region')}</th>{columns.map(c=><th scope="col" key={c}>{t(c)}</th>)}</tr></thead>
    <tbody>{rows.map(({id,label,counts:c})=><tr key={id}>
     <th scope="row">{requirement==='all'?<button className="plain" onClick={()=>choose(id)}>{label}</button>:label}</th>
     {[`${c.checked}/${c.total}`,c.met,c.unmet,`${c.unclear} · ${percent(c.unclear,c.checked)}`,`${c.clear}/${c.checked} · ${percent(c.clear,c.checked)}`].map((value,i)=><td key={i} data-label={t(columns[i])}>{i===1||i===2||i===3?<span aria-hidden="true" className={`statistics-dot statistics-dot--${['','','unmet','unclear'][i]||'met'}`}/>:null}{value}</td>)}
    </tr>)}</tbody>
   </table>
   <details className="statistics-details"><summary>{t('Technical errors, unfinished checks and last updated')}</summary>{rows.map(({id,label,counts:c})=><p key={id}><strong>{label}</strong> · {t('Technical errors')}: {c.errors} · {t('Without a valid finding')}: {c.unfinished} · {t('Last updated')}: {c.updated?new Date(c.updated).toLocaleString(language):t('Not assessed')}</p>)}</details>
  </>}
 </section>;
}
