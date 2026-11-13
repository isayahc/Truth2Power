import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {handler} from '../src/handler.js';
const read=path=>JSON.parse(readFileSync(new URL(path,import.meta.url)));
test('Attachment G assigns all 62 counties and every retained hospital exactly once',async()=>{
  const ref=read('../../references/ny-rating-regions-v1.json');
  const counties=Object.values(ref.regions).flat();
  assert.equal(counties.length,62);assert.equal(new Set(counties).size,62);
  assert.deepEqual(ref.regions['NYC Metro'],['Bronx','Kings','New York','Queens','Richmond']);
  assert.deepEqual(ref.regions.Central,['Cayuga','Chenango','Columbia','Cortland','Delaware','Greene','Madison','Onondaga','Otsego','Schoharie','Tompkins']);
  // Deliberately different from economic-development regions.
  assert.ok(ref.regions['Finger Lakes'].includes('Chautauqua'));
  assert.ok(ref.regions.Western.includes('Monroe'));
  assert.ok(ref.regions['Utica-Adirondack'].includes('Oswego'));
  const roster=read('../../data/maps/hospitals.geojson').features;
  const normalized=s=>s.replaceAll('.','').toLowerCase();
  for(const f of roster){const p=f.properties;
    assert.ok(ref.regions[p.region].some(c=>normalized(c)===normalized(p.county)));
    assert.equal(p.region_number,ref.region_numbers[p.region]);assert.equal(p.region_scheme,ref.scheme);
  }
  const get=async rawPath=>{const r=await handler({rawPath,requestContext:{http:{method:'GET'}}});assert.equal(r.statusCode,200);return JSON.parse(r.body);};
  const overview=await get('/api/overview'),operations=await get('/api/pilot/v1/operations');
  assert.equal(overview.regions.length,9);
  for(const region of overview.regions){
    const expected=roster.filter(f=>f.properties.current_directory!==false && f.properties.region===region.region);
    assert.equal(region.total,expected.length);
    assert.equal(operations.items.filter(h=>h.region===region.region).length,expected.length);
  }
});
