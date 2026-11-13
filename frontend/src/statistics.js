export function requirementStats(hospitals,id){
 const counts={total:hospitals.length,met:0,unmet:0,unclear:0,errors:0,unfinished:0,updated:null};
 for(const hospital of hospitals){
  const item=hospital.items.find(i=>i.id===id);
  if(['met','unmet','unclear'].includes(item?.agent_outcome))counts[item.agent_outcome]++;
  else counts.unfinished++;
  if(item?.technical_error)counts.errors++;
  if(item?.agent_updated_at&&(!counts.updated||item.agent_updated_at>counts.updated))counts.updated=item.agent_updated_at;
 }
 counts.checked=counts.met+counts.unmet+counts.unclear;
 counts.clear=counts.met+counts.unmet;
 return counts;
}
