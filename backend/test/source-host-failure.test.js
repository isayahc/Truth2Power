import assert from 'node:assert/strict';
import test from 'node:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { openStore, claim } from '../audit/store.js';
import { enqueuePipeline, failPipeline } from '../audit/pipeline-store.js';
import { sourceInventory } from '../audit/roster-inventory.js';
import { documentAttempts, failureDiagnostic } from '../audit/failure-diagnostic.js';

test('HTTP diagnostics preserve status, remove secrets and distinguish permanent and transient failures', (t) => {
  const root = mkdtempSync(join(tmpdir(), 'SYN-http-'));
  const db = openStore(root);
  t.after(() => { db.close(); rmSync(root, { recursive: true, force: true }); });
  for (const status of [403, 404, 410, 408, 429, 503]) {
    const d = failureDiagnostic('http_error', {http_status: status, source_url: 'https://hospital.example/aid?token=PRIVATE#secret', manifest_id: 'a'.repeat(32)});
    assert.equal(d.source_url, 'https://hospital.example/aid');
    assert.equal(d.retryable, [408,429,503].includes(status));
  }
  const id = enqueuePipeline(db, {root, hospital_key:'798', mode:'full_audit', review_date:'2026-11-10', request_key:'SYN-403'});
  failPipeline(db, claim(db), {code:'http_error', diagnostic:{http_status:403,source_url:'https://hospital.example/aid'}});
  assert.equal(claim(db), null);
  const e = JSON.parse(db.prepare("SELECT detail FROM audit_run_events WHERE job=? AND state='failed'").get(id).detail);
  assert.equal(e.diagnostic.http_status,403);
  assert.equal(e.retry_scheduled,false);
});

test('certificate failures retain a specific diagnostic and do not retry', (t) => {
  const root = mkdtempSync(join(tmpdir(), 'SYN-tls-'));
  const db = openStore(root);
  t.after(() => { db.close(); rmSync(root, { recursive: true, force: true }); });
  const id = enqueuePipeline(db, { root, hospital_key: '379', mode: 'full_audit', review_date: '2026-11-10', request_key: 'SYN-tls' });
  failPipeline(db, claim(db), Object.assign(new Error('private diagnostic'), { code: 'tls_certificate_invalid' }));
  assert.equal(db.prepare('SELECT status FROM jobs WHERE id=?').get(id).status, 'failed');
  assert.equal(claim(db), null);
  const event = db.prepare("SELECT detail FROM audit_run_events WHERE job=? AND state='failed'").get(id);
  assert.equal(JSON.parse(event.detail).error_code, 'tls_certificate_invalid');
});

test('network migration requires a connected redirect chain and keeps campus scope unknown', () => {
  const start = 'https://hospital.example/financial-assistance';
  const end = 'https://network.example/financial-assistance';
  const facility = { hospital_key: '303', landing_url: start };
  const landing = { source_url: start, final_url: end, url: end, status: 'saved', sha256: 'a'.repeat(64), artifact_path: `snapshots/${'a'.repeat(64)}.html`, retrieved_at: '2026-11-10T12:00:00Z', redirects: [{ source_url: start, final_url: end, http_status: 301 }] };
  const collection = { hospital_key: '303', landing_url: start, landing_page: landing, pages: [], documents: [] };
  const inventory = sourceInventory(facility, collection);
  assert.equal(inventory.sources[0].final_url, end);
  assert.equal(inventory.sources[0].campus_applicability, 'unknown');
  assert.throws(() => sourceInventory(facility, { ...collection, landing_page: { ...landing, redirects: [] } }), /provenance/);
  assert.throws(() => sourceInventory(facility, { ...collection, landing_page: { ...landing, redirects: [{ source_url: 'https://unrelated.example/', final_url: end, http_status: 301 }] } }), /provenance/);
  assert.throws(() => sourceInventory(facility, { ...collection, landing_page: { ...landing, redirects: [{ source_url: start, final_url: 'https://127.0.0.1/', http_status: 301 }] } }), /provenance/);
});

test('blocked source host stops after one attempt and records a safe diagnostic', (t) => {
  const root = mkdtempSync(join(tmpdir(), 'SYN-source-host-'));
  const db = openStore(root);
  t.after(() => { db.close(); rmSync(root, { recursive: true, force: true }); });
  const id = enqueuePipeline(db, { root, hospital_key: '303', mode: 'full_audit', review_date: '2026-11-10', request_key: 'SYN-host-blocked' });
  const job = claim(db);
  failPipeline(db, job, Object.assign(new Error('untrusted content must not appear'), { code: 'source_host_blocked' }));
  const saved = db.prepare('SELECT status,attempts,error FROM jobs WHERE id=?').get(id);
  assert.equal(saved.status, 'failed');
  assert.equal(saved.attempts, 1);
  assert.match(saved.error, /discovery scope/);
  assert.doesNotMatch(saved.error, /untrusted content/);
  assert.equal(claim(db), null);
  const events = db.prepare('SELECT state,detail FROM audit_run_events WHERE job=?').all(id);
  assert.equal(events.some(e => e.state === 'retrying'), false);
  assert.equal(JSON.parse(events.find(e => e.state === 'failed').detail).error_code, 'source_host_blocked');
});

test('historical CDN rejections retain the cause while removing query strings and raw exception text', () => {
  const parent_url = 'https://hospital.example/aid';
  const doc = {status:'failed', parent_url, source_url:'https://files.example/application.pdf?token=PRIVATE',
    error_code:'source_host_blocked', reason:"Document or redirect is outside the roster site's HTTPS host", redirects:[]};
  assert.deepEqual(documentAttempts({documents:[doc]}), [{source_url:'https://files.example/application.pdf',
    parent_url, status:'failed', reason:'off_host_document_blocked', http_status:null, sha256:null}]);
});

test('document diagnostics retain known limits across manifest and run log projections', () => {
  const failure = {status: 'failed', source_url: 'https://hospital.example/form.pdf', error_code: 'resource_limit'};
  const attempts = documentAttempts({documents: [
    {...failure, limit: 'seconds'}, {...failure, limit: 'documents'}, failure,
    {...failure, limit: 'SYN-private-detail'}, {...failure, error_code: 'http_error', limit: 'seconds'},
  ]});
  assert.deepEqual(attempts.map(a => a.limit), ['seconds', 'documents', undefined, undefined, undefined]);
  assert.deepEqual(documentAttempts({documents: attempts}), attempts);
});

test('document timings survive run log export and missing measurements stay unknown', () => {
  const docs = [
    {status: 'saved', source_url: 'https://hospital.example/fast.pdf?token=SYN', elapsed_ms: 0, size_bytes: 6},
    {status: 'failed', error_code: 'retrieval_timeout', elapsed_ms: 19999, download_attempted: true},
    {status: 'failed', error_code: 'resource_limit', limit: 'depth', download_attempted: false},
    {status: 'saved', elapsed_ms: -1, size_bytes: -3},
    {status: 'failed', elapsed_ms: '5000', size_bytes: 92},
    {status: 'saved', elapsed_ms: 0.7, size_bytes: '44000'},
  ];
  const attempts = documentAttempts({documents: docs});
  assert.deepEqual(attempts.map(d => d.elapsed_ms), [0, 19999, undefined, undefined, undefined, undefined]);
  assert.deepEqual(attempts.map(d => d.download_attempted), [undefined, true, false, undefined, undefined, undefined]);
  assert.deepEqual(attempts.map(d => d.size_bytes), [6, undefined, undefined, undefined, undefined, undefined]);
  assert.equal(attempts[0].source_url, 'https://hospital.example/fast.pdf');
  assert.deepEqual(documentAttempts({documents: attempts}), attempts);
});
