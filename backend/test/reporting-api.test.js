import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import assert from "node:assert/strict";
import test from "node:test";
import { mkdtempSync, rmSync, existsSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

test("reporting API queues, pages, scopes, reconciles totals and redacts private records", async (t) => {
  const root = mkdtempSync(join(tmpdir(), "SYN-private-path-"));
  process.env.AUDIT_DIR = root;
  process.env.T2P_REVIEW_DIRECTORY = join(root, "live");
  const { handler } = await import("../src/handler.js");
  const { openStore, claim } = await import("../audit/store.js");
  const { runPipeline } = await import("../audit/pipeline.js");
  const { failPipeline } = await import("../audit/pipeline-store.js");
  const { providerEvent } = await import("../audit/usage-ledger.js");
  const call = (suffix, q = {}, body, headers = { "x-review-request": "1" }) =>
    handler({
      rawPath: "/api/pilot/v1" + suffix,
      queryStringParameters: q,
      headers,
      body,
      requestContext: { http: { method: body === undefined ? "GET" : "POST" } },
    });
  const get = async (path, q) => {
    const r = await call(path, q);
    assert.equal(r.statusCode, 200, r.body);
    return JSON.parse(r.body);
  };
  const path = "/hospitals/739/runs",
    input = {
      mode: "replay",
      year: 2026,
      review_date: "2026-11-09",
      request_key: "private-key",
    };
  assert.equal((await get("/summary")).eligible_facilities, 218);
  assert.equal((await get(path)).clocks.last_attempted, null);
  assert.equal(existsSync(join(root, "audit.sqlite")), false);
  assert.equal((await call("/hospitals/999999/runs")).statusCode, 404);
  assert.equal(
    (await call(path, {}, JSON.stringify(input), {})).statusCode,
    403,
  );
  assert.equal((await call(path, {}, "x".repeat(8193))).statusCode, 413);
  assert.equal((await call(path, {}, "{}")).statusCode, 400);
  const queue = async (options) => {
    const r = await call(path, {}, JSON.stringify(options));
    assert.equal(r.statusCode, 202, r.body);
    return JSON.parse(r.body).audit_run_id;
  };
  const id = await queue(input),
    endpoint = "/runs/" + id;
  assert.equal(await queue(input), id);
  assert.equal(
    (await call(path, {}, JSON.stringify({ ...input, mode: "live" })))
      .statusCode,
    409,
  );
  assert.equal((await get(endpoint + "/receipt")).cost_status, "unknown");
  const db = openStore();
  t.after(() => {
    db.close();
    rmSync(root, { recursive: true, force: true });
  });
  const job = claim(db);
  await runPipeline(db, job);
  const run = await get(endpoint);
  assert.equal(run.status, "partial");
  assert.equal((await get(endpoint + "/receipt")).known_billed_usd, 0);
  providerEvent(db, {
    job: job.id,
    attempt: job.token,
    stage: "PRIVATE_STAGE",
    provider: "PRIVATE_PROVIDER",
    region: "local",
    model: "PRIVATE_MODEL",
    usage_id: "PRIVATE_SECRET",
    usage: { input_tokens: 10 },
  });
  const c = await get(endpoint + "/receipt");
  assert.equal(c.known_billed_usd, null);
  assert.equal(c.cost_status, "unknown");
  assert.equal(c.units.input_tokens, 10);
  const csv = await call(endpoint + "/receipt.csv");
  assert.match(csv.headers["Content-Type"], /csv/);
  assert.match(csv.body, /known_billed_usd/);
  const next = await queue({ ...input, request_key: "another-private-key" });
  for (let i = 0; i < 3; i++) {
    const id = Number(next.slice(10));
    db.prepare("UPDATE jobs SET available_at=0 WHERE id=?").run(id);
    failPipeline(db, claim(db));
  }
  const page = await get(path, { limit: "1" });
  assert.equal(page.items[0].status, "failed");
  const last = await get(path, { limit: "1", cursor: page.next_cursor });
  assert.equal(last.items[0].audit_run_id, id);
  assert.equal(last.next_cursor, null);
  assert.equal(page.clocks.last_eligible_assessment, null);
  assert.equal(page.clocks.last_successful_source_retrieval, null);
  assert.ok(page.clocks.last_completed_execution);
  const revision = await get(run.revision.replace("/api/pilot/v1", ""));
  assert.equal(revision.findings.length, 17);
  assert.equal(
    (await call(endpoint + "/revision/" + "0".repeat(64))).statusCode,
    404,
  );
  const timeline = await get(endpoint + "/timeline", { limit: "1" });
  assert.equal(timeline.items[0].state, "queued");
  assert.equal(
    (await get(endpoint + "/timeline", { cursor: timeline.next_cursor }))
      .items[0].state,
    "started",
  );
  const aggregate = await get("/summary", { pfi: "739", mode: "replay" });
  for (let i = 0; i < 105; i++) db.prepare('INSERT INTO audit_run_events(job,attempt,state,at,detail) VALUES(?,?,?,?,?)')
    .run(job.id, job.token, 'stage', new Date().toISOString(), JSON.stringify({ name: 'collect_sources', reason: 'PRIVATE_LOG_SECRET', local_path: root }));
  db.prepare('INSERT INTO audit_run_events(job,attempt,state,at,detail) VALUES(?,?,?,?,?)')
    .run(job.id, job.token, 'failed', new Date().toISOString(), JSON.stringify({error_code:'http_error',retry_scheduled:false,diagnostic:{http_status:403,source_url:'https://hospital.example/aid?secret=PRIVATE_LOG_SECRET',raw:'PRIVATE_LOG_SECRET'}}));
  const download = await call(endpoint + '/log.json');
  assert.equal(download.statusCode, 200);
  assert.match(download.headers['Content-Disposition'], /attachment; filename="audit-run-\d+-log.json"/);
  const log = JSON.parse(download.body);
  assert.equal(log.run.audit_run_id, run.audit_run_id);
  assert.equal(log.timeline.length, db.prepare('SELECT count(*) n FROM audit_run_events WHERE job=?').get(job.id).n);
  assert.ok(log.timeline.length > 100);
  assert.ok(log.attempts.length);
  assert.ok(log.receipt);
  assert.equal(log.timeline.at(-1).diagnostic.http_status, 403);
  assert.equal(log.timeline.at(-1).diagnostic.source_url, 'https://hospital.example/aid');
  assert.equal(log.timeline.at(-1).retry_scheduled, false);
  assert.doesNotMatch(download.body, /PRIVATE_LOG_SECRET|PRIVATE_PROVIDER|PRIVATE_MODEL|PRIVATE_SECRET/);
  assert.equal(download.body.includes(job.token), false);
  assert.equal((await call('/runs/audit-run-999999/log.json')).statusCode, 404);
  assert.equal(aggregate.runs, 2);
  assert.equal(aggregate.facilities_with_runs, 1);
  assert.equal(aggregate.units.input_tokens, 10);
  assert.equal(aggregate.known_billed_usd, null);
  assert.equal(
    (await get("/summary", { status: "partial", evidence: "partial" })).runs,
    1,
  );
  assert.equal((await get("/summary", { from: "2030-01-01" })).runs, 0);
  assert.equal(
    (await get("/summary", { region: "Long Island", pfi: "739" })).runs,
    0,
  );
  assert.equal((await call(path, { limit: "101" })).statusCode, 400);
  const scanned = await queue({
    ...input,
    mode: "discovery_only",
    request_key: "SYN-scan",
  });
  await runPipeline(db, claim(db), (dir, request) =>
    JSON.parse(
      execFileSync(
        process.env.T2P_PYTHON || "python",
        ["backend/test/fixtures/roster-collector.py", dir],
        { input: JSON.stringify(request), encoding: "utf8" },
      ),
    ),
  );
  const scan = await get("/runs/" + scanned);
  const revisionPath = scan.revision.replace("/api/pilot/v1", "");
  const sourcePage = await get(revisionPath, { limit: "1" });
  const source = sourcePage.sources[0];
  assert.ok(sourcePage.next_cursor);
  const file = await call(source.download.replace("/api/pilot/v1", ""));
  assert.equal(file.statusCode, 200);
  assert.equal(file.headers["Content-Security-Policy"], "sandbox");
  assert.equal(
    createHash("sha256").update(Buffer.from(file.body, "base64")).digest("hex"),
    source.sha256,
  );
  assert.equal(
    (await call(revisionPath + "/snapshots/" + "0".repeat(64))).statusCode,
    404,
  );
  const afterScan = await get(path);
  assert.ok(
    afterScan.clocks.last_successful_source_retrieval &&
      afterScan.clocks.next_due_at,
  );
  assert.equal(afterScan.clocks.last_eligible_assessment, null);
  assert.equal((await get(endpoint + "/receipt")).units.input_tokens, 10);
  for (const output of [
    csv.body,
    JSON.stringify([run, c, revision, page, timeline, aggregate]),
  ]) {
    for (const secret of [root, job.token, "private-key", "PRIVATE_"])
      assert.ok(!output.includes(secret));
  }
});
