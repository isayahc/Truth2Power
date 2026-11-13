import test from 'node:test';
import assert from 'node:assert/strict';
import {criteriaMapState} from '../../frontend/src/criteria-map.js';
import {steps} from '../../agents/steps.ts';
import {readFileSync} from 'node:fs';
test('current-map percentage excludes unchecked, unclear and technical failures',()=>{
 const outcomes=[...Array(8).fill('met'),...Array(2).fill('unmet'),'unclear','error',...Array(5).fill('unrun')];
 const row={items:outcomes.map((effective,i)=>({id:`k${i+1}`,effective}))};
 const result=criteriaMapState(row);
 assert.equal(result.percent,80);assert.equal(result.assessed,10);assert.equal(result.total,17);
 assert.equal(result.counts.met,8);assert.equal(result.state,'unmet');
 assert.equal(criteriaMapState(row,'k12').percent,null);assert.equal(criteriaMapState(row,'k12').state,'error');
 assert.equal(criteriaMapState(null).percent,null);assert.equal(criteriaMapState(null).state,'unrun');
});
test('failed retry retains the valid criterion color with a separate error indicator',()=>{
 for(const effective of ['met','unmet']){
  const row={items:[{id:'k1',effective,technical_error:true}]};
  assert.equal(criteriaMapState(row,'k1').state,effective);assert.equal(criteriaMapState(row,'k1').hasError,true);
 }
 const row={items:[{id:'k1',effective:'met'},{id:'k2',effective:'unrun'}],active:{status:'running',requested:['k2'],progress:{k2:{status:'running'}}}};
 assert.equal(criteriaMapState(row,'k1').state,'met');assert.equal(criteriaMapState(row,'k2').state,'running');
 assert.equal(criteriaMapState({items:[{id:'k1',effective:'met'}]}).state,'unrun');
});
test('requirement dropdown ordering matches canonical agent K1-K17 definitions',()=>{
 const rubric=JSON.parse(readFileSync(new URL('../../rubrics/css-17-v1.json',import.meta.url)));
 assert.deepEqual(rubric.measures.map(m=>m.measure_id),Object.values(steps).map(s=>s.criterion));
});
