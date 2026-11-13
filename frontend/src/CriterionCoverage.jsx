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
  const groups=Map.groupBy(reviews,item=>item.hospital_key);
  return <section className="criterion-review-inbox" lang={language} aria-labelledby="criterion-review-heading">
    <div className="criterion-review-heading"><h2 id="criterion-review-heading">{t('Requirements needing review')}</h2><span className="criterion-review-total">{reviews.length}</span></div>
    {error && <p role="alert">{t('Criterion coverage unavailable.')}</p>}
    {!data && !error && <p role="status">{t('Loading criterion coverage…')}</p>}
    {data && !reviews.length && <p className="criterion-review-empty">{t('No unclear criteria awaiting review.')}</p>}
    {!!reviews.length && <ul className="criterion-review-groups">{[...groups].map(([key,items])=><li className="criterion-review-group" key={key}>
      <h3>{items[0].hospital_name}</h3>
      <ul className="criterion-review-rows">{items.map(item=><li className="criterion-review-row" key={item.step}>
        <div className="criterion-review-content">
          <div className="criterion-review-title"><span className="criterion-review-code">{item.step.toUpperCase()}</span><span>{t(item.title)}</span></div>
          <div className="criterion-review-meta"><span className="criterion-review-badge">{t('Unclear')}</span><span>{t('Last updated')}: <time dateTime={item.updated_at}>{new Date(item.updated_at).toLocaleString(language)}</time></span></div>
        </div>
        <a className="criterion-review-action" href={localHref(`?hospital=${item.hospital_key}#criterion-${item.step}`)} aria-label={`${t('Review requirement')} ${item.step.toUpperCase()} · ${t(item.title)} · ${item.hospital_name}`}>{t('Review →')}</a>
      </li>)}</ul>
    </li>)}</ul>}
  </section>;
}
