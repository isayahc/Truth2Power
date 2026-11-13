import {readFileSync,writeFileSync} from 'node:fs';
import assert from 'node:assert/strict';
const reference=JSON.parse(readFileSync('references/ny-rating-regions-v1.json'));
const key=s=>s.toLowerCase().replaceAll('.','');
const counties=Object.entries(reference.regions).flatMap(([region,names])=>names.map(name=>[key(name),region]));
assert.equal(counties.length,62);assert.equal(new Set(counties.map(([name])=>name)).size,62);
const lookup=new Map(counties);
const path='data/maps/hospitals.geojson', data=JSON.parse(readFileSync(path));
for(const f of data.features){
  const p=f.properties,region=lookup.get(key(p.county));assert.ok(region,`Unmapped county: ${p.county}`);
  Object.assign(p,{region,region_number:reference.region_numbers[region],region_scheme:reference.scheme});
}
writeFileSync(path,JSON.stringify(data,null,2)+'\n');
const escape=v=>{const s=String(v??'');return /[",\n]/.test(s)?'"'+s.replaceAll('"','""')+'"':s;};
const header='hospital_name,pfi,county,latitude,longitude,audit_grade,stars,review_month,coordinate_source,coordinate_match,coordinate_source_url,audit_row_url,hospital_key,region,region_number,region_scheme';
const rows=data.features.filter(f=>f.properties.current_directory!==false).map(f=>{const p=f.properties;return [p.name,p.pfi,p.county,f.geometry.coordinates[1],f.geometry.coordinates[0],p.grade,p.stars,p.review_month,p.coordinate_source,p.coordinate_match,p.coordinate_source_url,p.audit_url,f.id,p.region,p.region_number,p.region_scheme].map(escape).join(',');});
writeFileSync('data/maps/hospital-coordinates.csv',[header,...rows].join('\n')+'\n');
console.log(`Assigned nine rating regions to ${data.features.length} current and historical hospitals.`);
