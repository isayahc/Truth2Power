import { directory, openStore } from './store.js';
import { installCriteria, criterionHospital, criterionStatus, criterionPlan, enqueueCriterion, validateStep } from './criterion-service.js';

const response = (statusCode, data) => ({ statusCode,
  headers: { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' }, body: JSON.stringify(data) });
export async function criterionRoute(event) {
  const match = /^\/api\/hospitals\/(\d{1,8}|t2p-\d+)\/criteria(?:\/(k\d{1,2})(?:\/(plan))?)?$/.exec(event.rawPath);
  if (!match) return response(404, { error: 'Criterion endpoint not found.' });
  const method = event.requestContext?.http?.method;
  let hospital;
  try { hospital = criterionHospital(match[1]); } catch { return response(404, { error: 'Hospital unavailable.' }); }
  const db = openStore();
  try {
    installCriteria(db);
    if (!match[2] && method === 'GET') return response(200, criterionStatus(db, match[1]));
    if (!match[2]) return response(405, { error: 'Method not allowed.' });
    validateStep(match[2]);
    if (match[3] && method === 'GET') return response(200, await criterionPlan(directory, hospital, match[2]));
    if (!match[3] && method === 'POST') {
      if (event.headers?.['x-review-request'] !== '1') return response(403, { error: 'Request rejected.' });
      if (typeof event.body !== 'string' || Buffer.byteLength(event.body) > 4096) return response(400, { error: 'Invalid request.' });
      let input;
      try { input = JSON.parse(event.body); } catch { return response(400, { error: 'Invalid request.' }); }
      const plan = await criterionPlan(directory, hospital, match[2]);
      return response(202, enqueueCriterion(db, match[1], match[2], input, plan));
    }
    return response(405, { error: 'Method not allowed.' });
  } catch (error) {
    if (!error.status) console.error('criterion_request_failed', error.name);
    return response(error.status ?? 500, { error: error.status ? error.message : 'Criterion request unavailable.' });
  } finally { db.close(); }
}
