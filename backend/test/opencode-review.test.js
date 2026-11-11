import assert from "node:assert/strict";
import test from "node:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { agentReviewConfig, reviewWithAgents } from "../audit/opencode-review.js";
import { invokeAuditAgent } from "../audit/opencode-transport.js";
import { rubric } from "../grading/data.js";
import { openStore, claim } from "../audit/store.js";
import { enqueuePipeline } from "../audit/pipeline-store.js";
import { costReceipt } from "../audit/usage-ledger.js";

const name = "SYN Example General Hospital";
const file = "https://example.test/SYN.pdf", page = "https://example.test/aid";
const criterion = rubric.measures.find(m => m.evaluator === "assets").measure_id;
const free = { runtime: "openrouter", model: "openrouter/free", paid: false };

function inputs(scope) {
  const sources = [[page, "landing_page", "html", "a"], [file, "unclassified", "pdf", "b"]].map(([source_id,role,fmt,hex]) => ({
    source_id, role, language: "en", snapshot: { sha256: hex.repeat(64), artifact_path: "snapshots/" + hex.repeat(64) + "." + fmt },
  }));
  const reviews = {};
  for (const s of sources) reviews[s.source_id] = { source_id: s.source_id, sha256: s.snapshot.sha256,
    observations: {}, campus_applicability: "unknown", campus_mentions: {}, role_candidates: {}, unreadable: [] };
  reviews[file].sample_passages = [
    { locator: "page 1", quote: "SYN financial assistance application." },
    { locator: "page 2", quote: scope || "Our covered hospitals include " + name + "." },
    { locator: "page 3", quote: "SYN no assets are considered." },
  ];
  return { job: { id: 31, context: { agent_review: free, facility: name } }, deadline: Date.now()+30_000,
    input: { sources, hospital_key: "SYN-1", guideline_year: "2026", review_date: "2026-01-01",
      scope: { inventory_status: "partial", gaps: Array.from({ length: 20 }, (_, i) => "SYN gap " + i) } },
    analysis: { sources: { [file]: [], [page]: [{ locator: "body", text: "Financial aid for patients", status: "extracted" }] }, reviews } };
}

function responder(override = {}) {
  return async ({ role, packet }) => {
    if (override[role]) return override[role](packet);
    assert.equal(packet.scope.inventory_status, "partial");
    assert.deepEqual([packet.scope.gaps.length,packet.scope.omitted_gaps], [16,4]);
    if (role === "website") return { selections: [] };
    if (role === "documents") {
      assert.equal(packet.hospital, name);
      const ids = packet.passages.map(p => p.id);
      return { selections: [{ measure_id: criterion, ids: [ids[2]] }], identities: [{ role: "application", role_id: ids[0], campus_id: ids[1] }] };
    }
    return { findings: packet.criteria.map(({measure_id}) => ({
      measure_id, result: measure_id === criterion ? "yes" : "unclear", explanation: "SYN limited review.",
      ids: packet.selections[measure_id] ?? [],
    })) };
  };
}

test("website and PDF agents run independently; the coordinator grounds drafts in original quotes and facility scope", async () => {
  let both;
  const gate = new Promise(resolve => { both = resolve; });
  const roles = new Set();
  const result = await reviewWithAgents({ ...inputs(), invoke: async args => {
    roles.add(args.role);
    if (args.role === "website") await gate;
    if (args.role === "documents") both();
    return responder()(args);
  } });
  assert.deepEqual([...roles], ["website","documents","coordinator"]);
  assert.equal(result.findings.length, 17);
  assert.equal(result.status, "completed");
  const draft = result.findings.find(f => f.measure_id === criterion);
  assert.equal(draft.result, "yes");
  assert.deepEqual(draft.evidence, [{ source_id: file, sha256: "b".repeat(64), locator: "page 3", quote: "SYN no assets are considered." }]);
  assert.equal(draft.identity_basis[0].evidence[1].locator, "page 2");
});

test("an exclusion or another campus cannot confer applicability, and invented passage IDs fail closed", async () => {
  for (const scope of ["These terms exclude " + name, "Only covers SYN Other Hospital."]) {
    const result = await reviewWithAgents({ ...inputs(scope), invoke: responder() });
    assert.equal(result.findings.find(f => f.measure_id === criterion).result, "unclear");
  }
  const wrong = await reviewWithAgents({ ...inputs(), invoke: responder({
    documents: () => ({ selections: [{ measure_id: criterion, ids: [99999] }] }),
  }) });
  assert.equal(wrong.agents.documents.reason, "invalid_output");
  assert.equal(wrong.status, "partial");
  assert.ok(wrong.findings.every(f => f.result === "unclear"));
});

test("a master agent cannot cite an unselected passage or silently omit criteria", async () => {
  const options = inputs();
  const result = await reviewWithAgents({ ...options, invoke: responder({ coordinator: () => ({
    findings: [{ measure_id: criterion, result: "yes", explanation: "SYN hallucination.", ids: [999] }],
  }) }) });
  assert.equal(result.agents.coordinator.reason, "invalid_output");
  assert.equal(result.findings.length, 17);
  assert.ok(result.findings.every(f => f.result === "unclear"));
  delete options.job.context.agent_review;
  assert.equal((await reviewWithAgents({ ...options, invoke: () => assert.fail("old run called an agent") })).status, "not_configured");
});

test("runtime configuration never upgrades a free request to a paid provider", () => {
  assert.equal(agentReviewConfig({}).runtime, "offline");
  assert.deepEqual(agentReviewConfig({ OPENROUTER_API_KEY: "synthetic" }), free);
  assert.equal(agentReviewConfig({ T2P_OPENROUTER_MODEL: "org/model:free" }).paid, false);
  assert.equal(agentReviewConfig({ T2P_OPENROUTER_MODEL: "org/model" }).paid, true);
  assert.equal(agentReviewConfig({ T2P_OPENCODE_LOCAL_MODEL: "qwen3:8b" }).runtime, "opencode");
  assert.throws(() => agentReviewConfig({ T2P_OPENROUTER_MODEL: "bad\nmodel" }));
});

test("free router uses a zero-price ceiling; paid reservations precede exactly one send and bind provider usage", async t => {
  const root = mkdtempSync(join(tmpdir(),"SYN-model-"));
  const db = openStore(root);
  const keys = ["T2P_BUDGET_FILE","T2P_RATE_CARD","OPENROUTER_API_KEY","T2P_OPENROUTER_MODEL","T2P_OPENCODE_LOCAL_MODEL"];
  const original = Object.fromEntries(keys.map(key => [key, process.env[key]]));
  t.after(() => {
    for (const key of keys) { if (original[key] === undefined) delete process.env[key]; else process.env[key] = original[key]; }
    db.close(); rmSync(root, {recursive:true,force:true});
  });
  const model = "SYN/model";
  process.env.T2P_OPENROUTER_MODEL = model;
  delete process.env.T2P_OPENCODE_LOCAL_MODEL;
  process.env.OPENROUTER_API_KEY = "SYN-dummy";
  process.env.T2P_BUDGET_FILE = join(root,"limits.json");
  process.env.T2P_RATE_CARD = join(root,"rates.json");
  writeFileSync(process.env.T2P_BUDGET_FILE, JSON.stringify({paid_requests:3, paid_tokens:50000, paid_usd_micros:100000}));
  writeFileSync(process.env.T2P_RATE_CARD, JSON.stringify({version:"SYN", currency:"USD",effective_date:"2026-01-01",local:{},
    models:{ ["openrouter/global/" + model]: {input_tokens:0.000001, output_tokens:0.000001} }}));
  const id = enqueuePipeline(db, { hospital_key:"739",mode:"full_audit",review_date:"2026-01-01",request_key:"SYN-agent",root,allow_paid:true });
  const job = claim(db);
  const args = { job, db, packet: { synthetic: true }, role:"website", deadline: Date.now()+10_000 };
  const policies = [];
  t.mock.method(globalThis, "fetch", async (url, options) => {
    assert.equal(url, "https://openrouter.ai/api/v1/chat/completions");
    const body = JSON.parse(options.body);
    if (body.model === model) assert.equal(db.prepare("SELECT count(*) n FROM paid_reservations").get().n, 1);
    policies.push(body.provider.max_price);
    return Response.json({ choices:[{message:{content:'{"selections":[]}'}}], usage: { prompt_tokens:11, completion_tokens:3, cost:0.000014 } });
  });
  assert.deepEqual(await invokeAuditAgent({ ...args, config:free }), {selections:[]});
  const paid = { runtime:"openrouter", model, paid:true };
  await assert.rejects(invokeAuditAgent({ ...args, job:{...job, context:{budget:{paid:false}}}, config:paid }), /paid_disabled/);
  assert.deepEqual(await invokeAuditAgent({ ...args, config:paid }), {selections:[]});
  await assert.rejects(invokeAuditAgent({ ...args, config:paid }), /already_reserved/);
  assert.deepEqual(policies, [{prompt:0,completion:0,request:0}, {prompt:1,completion:1,request:0}]);
  const receipt = costReceipt(db, id);
  assert.equal(receipt.actual_billed.USD, 0.000014);
  assert.equal(receipt.stages.model_review.units.paid_model_calls, 1);
});
