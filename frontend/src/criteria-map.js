export const criterionColors={met:'#15803d',unmet:'#b91c1c',unclear:'#2563eb',running:'#7e22ce',queued:'#6b7280',unrun:'#6b7280',error:'#b91c1c'};
export function criteriaMapState(row,requirement='all'){
 const items=(row?.items??[]).filter(i=>requirement==='all'||i.id===requirement);
 const total=requirement==='all'?17:1;
 const counts={met:0,unmet:0,unclear:0,error:0,unrun:total-items.length};
 for(const item of items)counts[item.effective]++;
 const assessed=counts.met+counts.unmet;
 const active=items.some(i=>row?.active?.progress?.[i.id]?.status==='running'||row?.active?.requested?.includes(i.id)&&!['succeeded','reused'].includes(row.active.progress?.[i.id]?.status));
 const hasError=items.some(i=>i.technical_error||i.effective==='error');
 const state=active?row.active.status:counts.unmet?'unmet':counts.error?'error':counts.unclear?'unclear':counts.met===total?'met':'unrun';
 return {counts,total,assessed,percent:assessed?Math.round(counts.met/assessed*100):null,state,hasError,
  updated:items.map(i=>i.updated_at).filter(Boolean).sort().at(-1)??null};
}
