import React from 'react';
import {useLocale} from './locale.jsx';
import reference from '../../references/ny-rating-regions-v1.json';

export const regionsFromUrl=()=>[...new Set(new URLSearchParams(location.search).getAll('region'))].filter(value=>Object.hasOwn(reference.regions,value));
export default function RegionPicker({values,onChange}){
 const {t}=useLocale();
 return <div className="atlas-region-control region-picker" role="group" aria-label={t('Regions')}>
  <span>{t('Regions')}</span>
  {!!values.length&&<div className="region-chips">{values.map(value=><span className="region-chip" key={value}><span className="region-chip-name" title={t(value)}>{t(value)}</span><button type="button" aria-label={`${t('Remove region')}: ${t(value)}`} onClick={()=>onChange(values.filter(v=>v!==value))}>×</button></span>)}</div>}
  <details className="region-picker-menu"><summary>{values.length?t('+ Add'):t('All regions')} ▾</summary>
   <div className="region-picker-options">
    <label><input type="checkbox" checked={!values.length} onChange={()=>onChange([])}/>{t('All regions')}</label>
    {Object.keys(reference.regions).map(value=><label key={value}><input type="checkbox" checked={values.includes(value)} onChange={e=>onChange(e.target.checked?[...values,value]:values.filter(v=>v!==value))}/>{t(value)}</label>)}
   </div>
  </details>
 </div>;
}
