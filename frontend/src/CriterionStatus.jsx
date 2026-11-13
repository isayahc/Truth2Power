import React from 'react';
import {useLocale} from './locale.jsx';

export const statusLabels={met:'Condition met',unmet:'Condition not met',unclear:'Needs evidence review',running:'Running',queued:'Queued',unrun:'Not checked',error:'Technical error — not assessed'};
export function StatusBadge({status,label}){
 const {t}=useLocale();
 return <span className={`criterion-status criterion-status--${status}`}><span className="criterion-dot" aria-hidden="true">{status==='error'?'✕':null}</span>{t(label??statusLabels[status])}</span>;
}
export default function CriterionLegend(){
 const {t}=useLocale();
 return <aside className="criterion-legend" aria-label={t('Status legend')}><strong>{t('Status legend')}</strong><ul>{Object.keys(statusLabels).map(status=><li key={status}><StatusBadge status={status}/></li>)}</ul><p>{t('A red circle means not met. A red X means a technical error, not a hospital failure. Previous valid findings remain available.')}</p></aside>;
}
