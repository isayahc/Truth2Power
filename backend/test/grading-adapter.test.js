import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { languageFixture, reviewFixture } from "./review-fixture.js";
import { createReviewService } from "../review/service.js";
import { adaptArtifact } from "../grading/adapter.js";
import { grade } from "../grading/grade.js";
import { sha256 } from "../review/identity.js";

function temp(t) {
  const root = mkdtempSync(join(tmpdir(),"SYN-adapter-"));
  t.after(() => rmSync(root,{recursive:true,force:true}));
  return root;
}
test("selected application replays numeric text, preserving independent source review, language gaps and exact hash", (t) => {
  const root = temp(t);
  const second = languageFixture(root,"Spanish",1);
  const first = languageFixture(root,"English",2,{ eligibility:true,otherUrls:[second.result.snapshots[0].url] });
  const service = createReviewService(root);
  const selected = service.list({language:"en"}).items[0];
  service.decide(selected.id,{action:"confirm",revision:0,reviewer_role:"SYN tester",notes:"SYN exact original only"});
  const a = adaptArtifact(readFileSync(first.path),{root});
  assert.equal(a.status,"partial",JSON.stringify(a.blockers[0]));
  const id = "application.maximum_fpl";
  assert.equal(a.provenance.identity.group, selected.logical_review_id);
  assert.equal(a.input.origin.finding_review[id].status,"approve");
  assert.equal(a.provenance.decisions.length,1);
  assert.equal(a.provenance.artifact_sha256, selected.result_sha256);
  const r = grade(a.input,{root}), f = r.findings.find((m) => m.measure_id === id);
  assert.equal(f.submitted_result,"yes");
  assert.equal(f.result,"unclear");
  assert.deepEqual(f.document_results,[{source_id:first.result.snapshots[0].url, language:"en",result:"yes"}]);
  assert.equal(f.human_review,"pending");
  assert.ok(f.coverage_gaps.some((g) => g.includes(second.result.snapshots[0].url)));
  assert.equal(r.final_grade,null);
  const revised = languageFixture(root,"English",3,{eligibility:true,version:2});
  assert.deepEqual(adaptArtifact(readFileSync(revised.path),{root}).provenance.decisions,[]);
});
test("full-review model interpretations stay blocked, including an exactly approved original; fake and stale decisions excluded", (t) => {
  const root = temp(t), fixture = reviewFixture(root);
  const a = fixture.result;
  a.findings[0].result = "yes";
  writeFileSync(fixture.path,JSON.stringify(a));
  const raw = readFileSync(fixture.path), dir = join(root,"full-reviews",a.review_id,"human-decisions");
  mkdirSync(dir);
  for (const [n,hash] of [sha256(raw),"0".repeat(64)].entries()) {
    writeFileSync(join(dir,(n+1).toString(16).repeat(32)+".json"),JSON.stringify({result_id:a.result_id,result_sha256:hash,
      decision:"approve",reviewer_role:"SYN role",notes:"SYN terminal approval",recorded_at:a.checked_at}));
  }
  const missing = adaptArtifact(raw,{root});
  assert.equal(missing.input,null);
  assert.match(missing.blockers[0].action,/actual review date/);
  const normalized = adaptArtifact(raw,{root,reviewDate:"2026-11-08"});
  assert.equal(normalized.status,"partial",JSON.stringify(normalized.blockers[0]));
  assert.equal(normalized.provenance.decisions.length,1);
  assert.deepEqual(normalized.provenance.original.source_reviews,a.source_reviews);
  assert.equal(normalized.input.findings.find((f) => f.measure_id === a.findings[0].measure_id).result,"unclear");
  assert.ok(normalized.blockers.some((b) => b.code === "needs_structured_observation"));
  assert.equal(grade(normalized.input,{root}).final_grade,null);
});
test("failed v1 recheck produces no new assessment and preserves the explicitly supplied prior assessment", (t) => {
  const root = temp(t);
  const exampleDir = new URL("../../docs/audit-format/examples/", import.meta.url);
  const worker = JSON.parse(readFileSync(new URL("completed.json",exampleDir)));
  worker.assessment.findings = worker.assessment.findings.slice(0,1);
  writeFileSync(join(root,"application.txt"), readFileSync(new URL("application.txt",exampleDir)));
  const prior = adaptArtifact(Buffer.from(JSON.stringify(worker)),{root,reviewDate:"2026-11-06"}).input;
  assert.ok(prior);
  const failed = {schema_version:"1.0",hospital_key:prior.hospital_key,rubric_version:"demo-v1",reference_version:"hhs-2026-contiguous-us",
    guideline_year:2026,attempt:{status:"failed",attempt_id:"SYN-attempt",attempted_at:"2026-11-09T09:00:00Z",error:"SYN timeout"},
    last_successful_assessment_at:prior.last_successful_assessment_at,snapshots:[],assessment:null};
  const r = adaptArtifact(Buffer.from(JSON.stringify(failed)),{root,previous:prior});
  assert.equal(r.status,"failed_recheck"); assert.equal(r.input,null);
  assert.deepEqual(r.retained_assessment,prior);
  failed.hospital_key="1002";
  assert.equal(adaptArtifact(Buffer.from(JSON.stringify(failed)),{root,previous:prior}).status,"blocked");
});
test("invalid producer reference, fabricated citation, duplicate measure and incompatible rubric return actionable blockers", (t) => {
  const root = temp(t), {result:a} = languageFixture(root,"English",1,{eligibility:true});
  for (const mutate of [(v) => v.reference_sha256="0".repeat(64),(v) => v.findings[0].evidence[0].quote="SYN invented",
    (v) => v.findings.push(v.findings[0]),(v) => v.rubric_version="unmapped"]) {
    const v=structuredClone(a);mutate(v);
    const r=adaptArtifact(Buffer.from(JSON.stringify(v)),{root});
    assert.equal(r.status,"blocked");assert.equal(r.input,null);assert.ok(r.blockers[0].action);
  }
});
