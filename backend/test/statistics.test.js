import test from 'node:test';
import assert from 'node:assert/strict';
import {requirementStats} from '../../frontend/src/statistics.js';
test('agent clarity excludes missing findings and human overrides, preserving valid answers after errors',()=>{
 const hospitals=[
  {items:[{id:'k1',agent_outcome:'met',effective:'unmet',technical_error:true,agent_updated_at:'2026-11-01'}]},
  {items:[{id:'k1',agent_outcome:'unmet'}]},
  {items:[{id:'k1',agent_outcome:'unclear',effective:'met'}]},
  {items:[{id:'k1',agent_outcome:null,technical_error:true}]},
  {items:[]}
 ];
 assert.deepEqual(requirementStats(hospitals,'k1'),{total:5,met:1,unmet:1,unclear:1,errors:2,unfinished:2,updated:'2026-11-01',checked:3,clear:2});
 assert.equal(requirementStats(hospitals,'k2').checked,0);
});
