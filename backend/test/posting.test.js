import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { sha256 } from "../review/identity.js";
import { assistancePages, confirmedDocuments, postingReference } from "../grading/data.js";
import { adaptArtifact } from "../grading/adapter.js";
import { grade } from "../grading/grade.js";

test("posting replay binds facility, role excerpt and saved href, even when labels match", (t) => {
  const root = mkdtempSync(join(tmpdir(), "SYN-posting-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  mkdirSync(join(root, "snapshots"));
  const page = assistancePages.get("362"), url = new URL("/SYN-form.pdf", page).href;
  const stamp = "2026-11-08T12:00:00Z";
  function saved(bytes, role, address, suffix) {
    const hash = sha256(bytes), path = "snapshots/" + hash + suffix;
    writeFileSync(join(root,path), bytes);
    return {snapshot_id:hash, sha256:hash, url:address, artifact_path:path, document_type:role, retrieved_at:stamp, publisher_updated_at:null};
  }
  const landing = saved(Buffer.from('<a href="/SYN-form.pdf">SYN form</a>'),"landing_page",page,".html");
  const pdf = saved(readFileSync(new URL("../audit/fixture/application.pdf",import.meta.url)),"application",url,".pdf");
  const excerpt = "One-person household";
  const pin = {hospital_key:"362",role:"application",sha256:pdf.sha256,locator:"page 1",quote:excerpt,language:"English"};
  confirmedDocuments.push(pin);
  t.after(() => confirmedDocuments.splice(confirmedDocuments.indexOf(pin),1));
  const findings = ["application","policy_summary","policy_statement"].map((role,i) => ({
    measure_id:"posted_materials."+role+"_posted",result:i?"unclear":"yes",reason_code:i?"insufficient_evidence":"condition_met",
    explanation:"SYN bounded public site capture",expected:{document_type:role},observed:{links:i?[]:[url],coverage_gaps:[]},
    evidence:i?[]:[{snapshot_id:landing.snapshot_id,locator:"link "+url,quote:"SYN form"},
      {snapshot_id:pdf.snapshot_id,locator:"page 1",quote:excerpt}],
  }));
  const envelope = {schema_version:"1.0",hospital_key:"362",rubric_version:"wave-one-posting-v1",reference_version:postingReference,
    guideline_year:2026,review_date:stamp.slice(0,10),attempt:{attempt_id:"SYN",attempted_at:stamp,status:"completed"},
    last_successful_assessment_at:stamp,snapshots:[landing,pdf],assessment:{assessment_id:"SYN-postings",completed_at:stamp,findings}};
  const adapt = () => adaptArtifact(Buffer.from(JSON.stringify(envelope)),{root});
  const normalized = adapt();
  assert.equal(normalized.status,"partial",JSON.stringify(normalized.blockers[0]));
  const result = grade(normalized.input,{root});
  assert.deepEqual(result.findings.slice(0,3).map((f) => f.result),["yes","unclear","unclear"]);
  assert.equal(result.final_grade,null);
  const bad = structuredClone(normalized.input);
  bad.findings[0].observed[0].value.search_complete = true;
  assert.throws(() => grade(bad,{root}), /differ/);
  envelope.hospital_key = "1002";
  assert.equal(adapt().status,"blocked");
  envelope.hospital_key = "362";
  findings[0].evidence[1].quote = "household";
  assert.equal(adapt().status,"blocked");
  findings[0].evidence[1].quote = excerpt;
  findings[0].evidence[0].locator += "?other";
  assert.equal(adapt().status,"blocked");
});
