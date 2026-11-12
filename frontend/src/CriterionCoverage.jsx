import React, { createContext, useContext, useEffect, useState } from 'react';
import { useLocale } from './locale.jsx';

const Context = createContext({data:null,error:false});
export const emptyCoverage = {met:0,unmet:0,unclear:0,unrun:17,confirmed:0,total:17,updated_at:null};
export const notifyCriterionChange = () => window.dispatchEvent(new Event('criterion-change'));

export function CriterionCoverageProvider({children}) {
  const [state,setState] = useState({data:null,error:false});
  useEffect(() => {
    let alive=true, controller;
    const load=async()=>{
      controller?.abort(); controller=new AbortController();
      try {
        const response=await fetch('/api/criteria/summary',{signal:controller.signal});
        if(!response.ok)throw Error();
        const data=await response.json(); if(alive)setState({data,error:false});
      } catch(error) {if(alive && error.name!=='AbortError')setState(previous=>({...previous,error:true}));}
    };
    load();const timer=setInterval(load,5000);window.addEventListener('criterion-change',load);
    return()=>{alive=false;controller?.abort();clearInterval(timer);window.removeEventListener('criterion-change',load);};
  },[]);
  return <Context.Provider value={state}>{children}</Context.Provider>;
}
export const useCriterionCoverage = () => useContext(Context);
export function coverageText(summary, t, language) {
  return `${t('Current criterion audit')}: ${summary.confirmed}/17 ${t('criteria confirmed')} · ${t('Last updated')}: ${summary.updated_at ? new Date(summary.updated_at).toLocaleString(language) : t('Not yet assessed')}`;
}
export function CriterionCoverage({hospitalKey, historical=false}) {
  const {data,error}=useCriterionCoverage(), {t,language}=useLocale();
  return <span className="criterion-coverage" lang={language}>
    {historical && <span>{t('Published September 2025; confirmed-criterion count not recorded.')} </span>}
    <span>{error ? t('Criterion coverage unavailable.') : data ? coverageText(data.hospitals[hospitalKey] ?? emptyCoverage,t,language) : t('Loading criterion coverage…')}</span>
  </span>;
}
export function CriterionReviewNotifications({hospitalKey=''}) {
  const {data,error}=useCriterionCoverage(), {t,language,localHref}=useLocale();
  const reviews=(data?.reviews ?? []).filter(item=>!hospitalKey || item.hospital_key===hospitalKey);
  return <section className="criterion-review-inbox" lang={language} aria-labelledby="criterion-review-heading">
    <h2 id="criterion-review-heading">{t('Criteria needing human review')} ({reviews.length})</h2>
    {error && <p role="alert">{t('Criterion coverage unavailable.')}</p>}
    {!data && !error && <p role="status">{t('Loading criterion coverage…')}</p>}
    {data && !reviews.length && <p>{t('No unclear criteria awaiting review.')}</p>}
    <ul>{reviews.map(item=><li key={`${item.hospital_key}-${item.step}`}>
      <a href={localHref(`?hospital=${item.hospital_key}#criterion-${item.step}`)}>{item.hospital_name} · {item.step.toUpperCase()} · {t(item.title)}</a>
      <span> · {t('Unclear')} · {t('Last updated')}: {new Date(item.updated_at).toLocaleString(language)}</span>
    </li>)}</ul>
  </section>;
}
