// Explicit roster maintenance: fetch public state records, retain existing identities and ratings.
import {readFileSync, writeFileSync} from 'node:fs';
import assert from 'node:assert/strict';
const path='data/maps/hospitals.geojson';
const collection=JSON.parse(readFileSync(path));
const directoryUrl='https://profiles.health.ny.gov/directory/hospitals';
const html=await (await fetch(directoryUrl)).text();
const text=s=>s.replace(/<[^>]+>/g,'').replaceAll('&amp;','&').trim();
const entries=[...html.matchAll(/<div class='listing'>(.*?)<\/div>/gs)].map(m=>{
  const fields=[...m[1].matchAll(/<p>(.*?)<\/p>/gs)].map(x=>text(x[1]));
  return {name:fields[0],address:fields[1],locality:fields[2]};
});
assert.equal(entries.length,218,'Review changed state directory before updating');
const retrievedAt=new Date().toISOString();
const additions=['15709','1315','1723','15897','1473','309','102'];
const sources=[];
for(const id of additions){
  const url=`https://health.data.ny.gov/resource/vn5v-hh5r.json?fac_id=${id}`;
  const response=await fetch(url);assert.ok(response.ok);
  const rows=await response.json();const row=rows[0];assert.equal(row.fac_id,id);
  const parent=collection.features.find(f=>f.id===row.main_site_facid);assert.ok(parent);
  sources.push({url,retrieved_at:retrievedAt,record:row});
  if(collection.features.some(f=>f.id===id))continue;
  collection.features.push({type:'Feature',id,geometry:{type:'Point',coordinates:[Number(row.longitude),Number(row.latitude)]},properties:{
    name:row.facility_name,pfi:id,county:row.county,address:row.address1,city:row.city,
    grade:null,stars:null,application_posted:null,review_month:null,record_path:null,audit_url:null,
    assistance_url:parent.properties.assistance_url,assistance_parent_pfi:parent.id,
    assistance_url_basis:'Parent hospital assistance page; campus applicability requires review',
    coordinate_source:'NYS DOH',coordinate_match:'facility_id',coordinate_source_url:url,
  }});
}
const norm=s=>s.toLowerCase().replace(/[^a-z0-9]/g,'');
const used=new Set(),matches=new Map();
// Address + name first, then unique remaining names/addresses. Never reuse a campus.
for(const mode of ['both','name','address'])for(const [index,row]of entries.entries()){
  if(matches.has(index))continue;
  const candidates=collection.features.filter(f=>!used.has(f.id)&&
    (mode==='address'||norm(f.properties.name)===norm(row.name))&&
    (mode==='name'||norm(f.properties.address)===norm(row.address)));
  if(candidates.length===1){used.add(candidates[0].id);matches.set(index,candidates[0].id);}
}
assert.equal(matches.size,218,'Unmatched/ambiguous directory entries need manual review');
assert.deepEqual(collection.features.filter(f=>!used.has(f.id)).map(f=>f.id),['t2p-0001']);
for(const f of collection.features){f.properties.current_directory=used.has(f.id);}
collection.directory_source=directoryUrl;collection.directory_checked_at=retrievedAt;
collection.name='New York hospital directory with September 2025 historical ratings';
writeFileSync(path,JSON.stringify(collection,null,2)+'\n');
writeFileSync('data/maps/directory-reconciliation.json',JSON.stringify({source:directoryUrl,retrieved_at:retrievedAt,current_count:218,historical_only:['t2p-0001'],added_ids:additions,entries:entries.map((r,i)=>({...r,hospital_key:matches.get(i)})),facility_sources:sources},null,2)+'\n');
const escape=value=>{const s=String(value??'');return /[",\n]/.test(s)?'"'+s.replaceAll('"','""')+'"':s;};
const header='hospital_name,pfi,county,latitude,longitude,audit_grade,stars,review_month,coordinate_source,coordinate_match,coordinate_source_url,audit_row_url,hospital_key';
const csv=collection.features.filter(f=>f.properties.current_directory).map(f=>{const p=f.properties;return [p.name,p.pfi,p.county,f.geometry.coordinates[1],f.geometry.coordinates[0],p.grade,p.stars,p.review_month,p.coordinate_source,p.coordinate_match,p.coordinate_source_url,p.audit_url,f.id].map(escape).join(',');});
writeFileSync('data/maps/hospital-coordinates.csv',[header,...csv].join('\n')+'\n');
console.log('Reconciled 218 current facilities; retained 212 historical ratings and seven unrated additions.');
