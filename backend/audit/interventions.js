import { openStore } from './store.js';
import { pipelineRoot, immutable, enqueuePipeline } from './pipeline-store.js';
import { facilityFor } from './roster-inventory.js';
import { failureDiagnostic } from './failure-diagnostic.js';
import { sha256 } from '../review/identity.js';
import { event } from './run-history.js';
import { spawnSync } from 'node:child_process';

const response = (statusCode, value) => ({ statusCode, headers: {'Content-Type':'application/json','Cache-Control':'no-store'}, body:JSON.stringify(value) });
const fail = (status, code) => { throw Object.assign(Error(code), {status, code}); };

export function interventionFor(db, job) {
  const e = db.prepare("SELECT detail,at FROM audit_run_events WHERE job=? AND json_extract(detail,'$.error_code')='website_verification_required' ORDER BY seq DESC LIMIT 1").get(job.id);
  if (!e) return null;
  const resumed = db.prepare("SELECT detail FROM audit_run_events WHERE job=? AND state='human_resumed' ORDER BY seq DESC LIMIT 1").get(job.id);
  const detail = JSON.parse(e.detail);
  const docs = db.prepare("SELECT detail FROM audit_run_events WHERE job=? AND state='human_document_imported' ORDER BY seq").all(job.id).map(r=>JSON.parse(r.detail));
  return {audit_run_id:`audit-run-${job.id}`, hospital_key:job.hospital, hospital_name:facilityFor(job.hospital).name,
    status:resumed ? 'resumed' : 'needs_human', blocked_at:e.at,
    source_url:failureDiagnostic('website_verification_required', detail.diagnostic)?.source_url,
    documents:docs, resumed_run_id:resumed ? JSON.parse(resumed.detail).audit_run_id : null};
}

export function interventionRoute(request) {
  const path = request.rawPath;
  const match = /^\/api\/pilot\/v1\/runs\/audit-run-([1-9]\d*)\/intervention(?:\/(documents|resume))?$/.exec(path);
  if (path !== '/api/pilot/v1/interventions' && !match) return null;
  let db;
  try {
    const method = request.requestContext?.http?.method;
    if (!['GET','POST'].includes(method)) fail(405,'method_not_allowed');
    if (method === 'POST' && request.headers?.['x-review-request'] !== '1') fail(403,'forbidden');
    db = openStore();
    if (!match) {
      if (method !== 'GET') fail(405,'method_not_allowed');
      const jobs = db.prepare("SELECT id,hospital FROM jobs WHERE rule='css-17-v1' AND json_extract(context,'$.root')=? AND EXISTS(SELECT 1 FROM audit_run_events e WHERE e.job=jobs.id AND json_extract(e.detail,'$.error_code')='website_verification_required') ORDER BY id DESC").all(pipelineRoot());
      return response(200,{items:jobs.map(j=>interventionFor(db,j)).filter(t=>t.status==='needs_human')});
    }
    const id=Number(match[1]);
    if (!Number.isSafeInteger(id)) fail(400,'invalid_run');
    const job=db.prepare("SELECT * FROM jobs WHERE id=? AND rule='css-17-v1' AND json_extract(context,'$.root')=?").get(id,pipelineRoot());
    if (!job) fail(404,'unknown_run');
    const t=interventionFor(db,job);
    if (!t) fail(404,'no_intervention');
    if (method==='GET' && !match[2]) return response(200,t);
    if (method!=='POST' || !match[2]) fail(405,'method_not_allowed');
    if (typeof request.body !== 'string' || Buffer.byteLength(request.body)>6*1024*1024) fail(413,'body_too_large');
    const body=JSON.parse(request.body);
    if (match[2]==='documents') {
      if (t.status!=='needs_human') fail(409,'already_resumed');
      if (body.public_document!==true || Object.keys(body).some(k=>!['public_document','source_url','retrieved_at','language','bytes'].includes(k))) fail(400,'public_document_confirmation_required');
      const source=failureDiagnostic('http_error',{source_url:body.source_url})?.source_url;
      if (!source || source!==body.source_url || !['en','es','und'].includes(body.language) || typeof body.retrieved_at!=='string' || !/^\d{4}-\d\d-\d\dT.*(?:Z|[+-]\d\d:\d\d)$/.test(body.retrieved_at) || !Number.isFinite(Date.parse(body.retrieved_at)) || Date.parse(body.retrieved_at)>Date.now()) fail(400,'invalid_document_metadata');
      if (typeof body.bytes!=='string' || !/^[A-Za-z0-9+/]*={0,2}$/.test(body.bytes)) fail(400,'invalid_pdf');
      const bytes=Buffer.from(body.bytes,'base64');
      if (bytes.length<8 || bytes.length>4*1024*1024 || bytes.toString('base64')!==body.bytes || !bytes.subarray(0,5).equals(Buffer.from('%PDF-'))) fail(400,'invalid_pdf');
      const validation=spawnSync(process.env.T2P_PYTHON||'python',['-c',"import sys,io;from pypdf import PdfReader;r=PdfReader(io.BytesIO(sys.stdin.buffer.read()));assert not r.is_encrypted;assert 0<len(r.pages)<=200"],{input:bytes,timeout:15000,maxBuffer:8192,windowsHide:true});
      if(validation.error || validation.status!==0) fail(400,'invalid_or_unreadable_pdf');
      const digest=sha256(bytes);
      const existing=t.documents.find(d=>d.source_url===source);
      if (existing) {
        if (existing.sha256!==digest || existing.retrieved_at!==body.retrieved_at || existing.language!==body.language) fail(409,'source_already_imported');
        return response(200,existing);
      }
      if (t.documents.length>=20) fail(400,'document_limit');
      const doc={source_url:source,sha256:digest,artifact_path:`snapshots/${digest}.pdf`,retrieved_at:body.retrieved_at,
        imported_at:new Date().toISOString(),language:body.language,capture_method:'human_import',retrieval_attestation:'local_operator',public_document:true};
      immutable(pipelineRoot(),doc.artifact_path,bytes);
      event(db,id,null,'human_document_imported',doc);
      return response(201,doc);
    }
    if (Object.keys(body).some(k=>k!=='confirm') || body.confirm!==true) fail(400,'confirmation_required');
    if (t.status==='resumed') return response(200,{audit_run_id:t.resumed_run_id});
    if (!t.documents.length) fail(400,'documents_required');
    const bytes=Buffer.from(JSON.stringify({schema_version:'human-import-v1',hospital_key:job.hospital,parent_run_id:id,documents:t.documents}));
    const digest=sha256(bytes);
    immutable(pipelineRoot(),`human-imports/${digest}.json`,bytes);
    const child=enqueuePipeline(db,{hospital_key:job.hospital,year:job.year,review_date:job.review_date,mode:'replay',manual_import:digest,request_key:`human-resume-${id}-${digest}`});
    event(db,id,null,'human_resumed',{audit_run_id:`audit-run-${child}`,manifest_sha256:digest});
    event(db,child,null,'human_import_linked',{parent_run_id:`audit-run-${id}`,manifest_sha256:digest});
    return response(202,{audit_run_id:`audit-run-${child}`});
  } catch(e) { return response(e.status??400,{error:e.code??'invalid_intervention_request'}); }
  finally { db?.close(); }
}
