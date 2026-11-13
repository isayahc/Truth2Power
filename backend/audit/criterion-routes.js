import { directory, openStore } from './store.js';
import { installCriteria, criterionHospital, criterionStatus, criterionPlan, enqueueCriterion, validateStep, missingCriteriaPlan, decideCriterion, criterionOverview } from './criterion-service.js';
import {installRegional,regionalStats,previewRegional,startRegional,cancelRegional,regionalBatch} from './regional-criteria.js';

const response = (statusCode, data) => ({ statusCode,
  headers: { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' }, body: JSON.stringify(data) });
export async function criterionRoute(event) {
  if(event.rawPath.startsWith('/api/criteria/regions')){
    const method=event.requestContext?.http?.method;
    const match=/^\/api\/criteria\/regions(?:\/(preview|[a-f0-9-]{36})(?:\/(start|cancel))?)?$/.exec(event.rawPath);
    if(!match)return response(404,{error:'Regional endpoint not found.'});
    const db=openStore();
    try{
      installCriteria(db);installRegional(db);
      if(method==='GET'&&!match[1])return response(200,regionalStats(db));
      if(method==='GET'&&match[1]!=='preview'&&!match[2])return response(200,regionalBatch(db,match[1]));
      if(method!=='POST')return response(405,{error:'Method not allowed.'});
      if(event.headers?.['x-review-request']!=='1')return response(403,{error:'Request rejected.'});
      if(typeof event.body!=='string'||Buffer.byteLength(event.body)>8192)return response(400,{error:'Invalid request.'});
      let input;try{input=JSON.parse(event.body);}catch{return response(400,{error:'Invalid request.'});}
      if(match[1]==='preview'&&!match[2])return response(200,await previewRegional(db,directory,input));
      if(match[2]==='start'&&input?.confirm===true)return response(202,await startRegional(db,directory,match[1]));
      if(match[2]==='cancel')return response(200,cancelRegional(db,match[1]));
      return response(400,{error:'Explicit confirmation required.'});
    }catch(error){return response(error.status??500,{error:error.status?error.message:'Regional checks unavailable.'});}
    finally{db.close();}
  }
  if (event.rawPath === '/api/criteria/summary') {
    if (event.requestContext?.http?.method !== 'GET') return response(405,{error:'Method not allowed.'});
    const db = openStore();
    try { installCriteria(db); return response(200,criterionOverview(db)); }
    catch { return response(500,{error:'Criterion summary unavailable.'}); }
    finally { db.close(); }
  }
  const match = /^\/api\/hospitals\/(\d{1,8}|t2p-\d+)\/criteria(?:\/(k\d{1,2}|all)(?:\/(plan|decisions))?)?$/.exec(event.rawPath);
  if (!match) return response(404, { error: 'Criterion endpoint not found.' });
  const method = event.requestContext?.http?.method;
  let hospital;
  try { hospital = criterionHospital(match[1]); } catch { return response(404, { error: 'Hospital unavailable.' }); }
  const db = openStore();
  try {
    installCriteria(db);
    if (!match[2] && method === 'GET') return response(200, criterionStatus(db, match[1]));
    if (!match[2]) return response(405, { error: 'Method not allowed.' });
    if (match[2] !== 'all') validateStep(match[2]);
    const planFor = () => match[2] === 'all' ? missingCriteriaPlan(db,directory,hospital,match[1]) : criterionPlan(directory,hospital,match[2]);
    if (match[3] === 'plan' && method === 'GET') return response(200, await planFor());
    if ((!match[3] || match[3] === 'decisions') && method === 'POST') {
      if (event.headers?.['x-review-request'] !== '1') return response(403, { error: 'Request rejected.' });
      if (typeof event.body !== 'string' || Buffer.byteLength(event.body) > 8192) return response(400, { error: 'Invalid request.' });
      let input;
      try { input = JSON.parse(event.body); } catch { return response(400, { error: 'Invalid request.' }); }
      if (match[3] === 'decisions') return response(201, decideCriterion(db,match[1],match[2],input));
      const plan = await planFor();
      return response(202, enqueueCriterion(db, match[1], match[2], input, plan));
    }
    return response(405, { error: 'Method not allowed.' });
  } catch (error) {
    if (!error.status) console.error('criterion_request_failed', error.name);
    return response(error.status ?? 500, { error: error.status ? error.message : 'Criterion request unavailable.' });
  } finally { db.close(); }
}
