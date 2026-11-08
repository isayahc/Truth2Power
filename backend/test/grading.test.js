import test from "node:test";
import assert from "node:assert/strict";
import { cpSync, mkdtempSync, readFileSync, rmSync, writeFileSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { execFileSync } from "node:child_process";
import { sha256 } from "../review/identity.js";
import { rubric, validateSchema } from "../grading/data.js";
import { calculate, grade } from "../grading/grade.js";
import { reviewSubject } from "../grading/evidence.js";
import { evaluateMeasure, fplComparison } from "../grading/measures.js";

const examples = fileURLToPath(new URL("../../docs/grading/examples/", import.meta.url));
const load = (name = "SYN-2026") => JSON.parse(readFileSync(join(examples, name + ".json")));
const run = (input) => grade(input, { root: examples });
const measure = (col) => rubric.measures.find((m) => m.css_column === col);
const at = (input, col) => input.findings.find((f) => f.measure_id === measure(col).measure_id);
const iso = "2026-11-08T12:00:00Z";
const ratings = () => rubric.measures.map((m) => ({ measure_id: m.measure_id, result: "yes" }));
function temp(t) {
  const root = mkdtempSync(join(tmpdir(), "SYN-css-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  return root;
}

test("rubric validates and spans exactly the 17 distinct CSS columns", () => {
  validateSchema(rubric, "grading-rubric-v1.schema.json");
  assert.equal(rubric.measures.map((m) => m.css_column).join(" "), "R S T U V W Y Z AD AE AG AH AI AJ AL AM AN");
  assert.equal(new Set(rubric.measures.map((m) => m.measure_id)).size, 17);
});
test("grade boundaries use each verified failure exactly once", () => {
  for (const [n, grade] of [[0,"A"],[1,"B"],[3,"B"],[4,"C"],[6,"C"],[7,"D"],[9,"D"],[10,"F"],[14,"F"],[17,"F"]]) {
    const f = ratings();
    const sorted = [...f.filter((v) => !rubric.overrides.some((o) => o.measure_id === v.measure_id)),
      ...f.filter((v) => rubric.overrides.some((o) => o.measure_id === v.measure_id))];
    sorted.slice(0,n).forEach((x) => x.result = "no");
    const score = calculate(f);
    assert.equal(score.calculated_grade, grade);
    assert.equal(score.failed_measures.length, n);
  }
});
test("applicable automatic Fs outrank the bands and a disputed override never picks a favorable grade", () => {
  for (const col of ["R", "AD"]) {
    const f = ratings();
    at({ findings: f }, col).result = "no";
    at({ findings: f }, "T").result = "no";
    assert.equal(calculate(f).calculated_grade, "F");
    assert.equal(calculate(f).policy_can_change_grade, false);
    f[3].result = "unclear";
    assert.deepEqual(calculate(f).possible_grades, ["F"]);
    assert.equal(calculate(f).calculated_grade, null);
  }
  const f = ratings();
  f[2].result = "no";
  assert.deepEqual(calculate(f).possible_grades, ["B", "F"]);
  assert.equal(calculate(f).policy_can_change_grade, true);
  assert.equal(calculate(f).calculated_grade, null);
  for (const i of [1,3,4,5,6,7,9,10,11]) f[i].result = "no";
  assert.deepEqual(calculate(f).possible_grades, ["F"]);
  assert.equal(calculate(f).policy_can_change_grade, false);
  f[2].result = "unclear";
  assert.equal(calculate(f).policy_can_change_grade, false);
});
test("fixed application bytes pass 2025 dollars and fail 2026 while eligibility passes in both", () => {
  const historical = run(load("SYN-2025")), live = run(load());
  assert.deepEqual([historical.calculated_grade, live.calculated_grade], ["A", "B"]);
  assert.equal(at(historical,"AH").result, "yes");
  assert.equal(at(live,"AH").result, "no");
  assert.equal(at(live,"AH").comparisons[0].cells[2].expected, 63840);
  assert.equal(at(historical,"AH").evidence[0].sha256, at(live,"AH").evidence[0].sha256);
  for (const r of [historical, live]) {
    assert.equal(at(r,"AI").result, "yes");
    assert.equal(r.final_grade, null);
    assert.match(r.reasons.join(" "), /#67/);
    assert.equal(r.human_review_status, "pending");
  }
  assert.deepEqual(live.failed_measures, [measure("AH").measure_id]);
  assert.equal(live.refresh_status, "overdue");
});
test("malformed inputs cannot import missing evidence, foreign decisions or mixed contexts", () => {
  const mutations = [
    (i) => i.findings.pop(), (i) => i.findings.push(i.findings[0]),
    (i) => i.findings[1] = i.findings[0], (i) => i.findings[0].measure_id = "SYN-mystery",
    (i) => i.findings[0].hospital_key = "362", (i) => i.findings[0].assessment_id += "-other",
    (i) => i.findings[0].guideline_year--, (i) => i.findings[0].scope_id = "SYN-other",
    (i) => i.findings[0].reference_version = "SYN-other", (i) => i.rubric_version = "SYN-other",
    (i) => i.findings[0].review_date = "2024-02-32", (i) => i.findings[0].evidence = [],
    (i) => at(i,"AE").evidence = at(i,"AL").evidence, (i) => i.sources[0].hospital_key = "362",
    (i) => i.findings[0].evidence[0].sha256 = "0".repeat(64), (i) => i.findings[0].evidence[0].locator = "/fields/eligibility",
    (i) => i.findings[0].evidence[0].quote += " invented", (i) => at(i,"AH").result = "yes",
    (i) => at(i,"AI").observed[0].value.percent = 100, (i) => i.sources[0].snapshot.artifact_path = "../README.md",
    (i) => i.scope.required_sources.pop(), (i) => i.findings[0].expected = "pass everything",
  ];
  for (const mutate of mutations) {
    const item = load(); mutate(item);
    assert.throws(() => run(item), undefined, String(mutate));
  }
});
test("changing exact source bytes invalidates all attached observations", (t) => {
  const root = temp(t); cpSync(join(examples,"sources"), join(root,"sources"), {recursive:true});
  const input = load();
  writeFileSync(join(root,input.sources[0].snapshot.artifact_path), "SYN altered");
  assert.throws(() => grade(input,{root}), /SHA-256/);
});
test("unclear and N/A are pending; an input's approval label cannot authorize itself", () => {
  const input = load();
  const f = at(input,"AI");
  f.result = "unclear"; f.unresolved_evidence = ["SYN translation unresolved."];
  f.human_review = "approved";
  let r = run(input);
  assert.equal(at(r,"AI").result, "unclear");
  assert.match(at(r,"AI").reason, /independent decisions/);
  assert.equal(r.human_review_status, "pending");
  f.result = "n_a"; f.unresolved_evidence = ["SYN proposed exemption."];
  r = run(input);
  assert.equal(at(r,"AI").result, "n_a");
  assert.equal(r.calculated_grade, null);
  assert.deepEqual(r.unresolved_measures, [f.measure_id]);
});
test("exact synthetic observation decisions remain separate from institutional authority and later revisions", (t) => {
  const input = load("SYN-2025"), dir = temp(t);
  for (const f of input.findings) {
    const hash = reviewSubject(input, f);
    mkdirSync(join(dir, hash));
    writeFileSync(join(dir, hash, "SYN.json"), JSON.stringify({subject_sha256:hash,decision:"approved",
      recorded_at:iso,reviewer_role:"SYN test role",reason:"SYN simulated observation review"}));
  }
  const r = grade(input, {root:examples, decisions:dir});
  assert.equal(r.human_review_status, "complete");
  assert.equal(r.authority.format_subject_matter, "pending");
  assert.equal(r.final_grade, null);
  input.scope_id += "-revision";
  input.findings.forEach((f) => f.scope_id = input.scope_id);
  assert.equal(grade(input,{root:examples,decisions:dir}).human_review_status,"pending");
});
test("missing applicability, stale guideline and failed recheck preserve dated evidence", () => {
  const input = load();
  const before = run(input), previous = structuredClone(input);
  input.attempt = { attempt_id:"SYN-recheck",attempted_at:iso,status:"failed",error:"SYN timeout" };
  assert.throws(() => run(input),/retained completed/);
  const r = grade(input,{root:examples,previous});
  assert.equal(r.last_successful_assessment_at, before.last_successful_assessment_at);
  assert.equal(r.last_attempt.status, "failed");
  assert.deepEqual(r.findings, before.findings);
  const altered = structuredClone(input); altered.findings[0].result = "no";
  assert.throws(() => grade(altered,{root:examples,previous}),/cannot replace/);
  input.attempt = previous.attempt;
  input.review_date = "2027-01-01"; input.findings.forEach((f) => f.review_date = input.review_date);
  assert.equal(at(run(input),"AH").result, "unclear");
  input.synthetic = false;
  assert.throws(() => run(input), /Synthetic source/);
  for (const column of ["V","AD"]) {
    const f = at(input,column);
    const facts = new Map(f.observed.map((o) => [f.evidence[o.evidence_index].source_id, o.value]));
    assert.equal(evaluateMeasure(measure(column),input,facts).result,"unclear");
  }
});
test("every measure evaluates adverse observations in its own applicable document scope", () => {
  const input = load("SYN-2025");
  const adverse = {
    deadline:{application_submission:"time_limit"}, assets:{eligibility_asset_test:"assets_tested"},
    immigration:{immigration_eligibility:"status_restricts_eligibility"}, contact:{complete:true,channels:[]},
    tables:{complete:true,income_table:true,discount_table:false}, maximum:{percent:300,hard_ceiling:true},
    installments:{percent:6,basis:"gross_monthly_income"}, summary_area:{complete:true,areas:[]},
    summary_process:{complete:true,application_instructions:[]}, summary_income:{complete:true,fpl_levels:[]},
  };
  for (const m of rubric.measures) {
    const copy = structuredClone(input), f = at(copy,m.css_column);
    const facts = new Map(f.observed.map((o) => [f.evidence[o.evidence_index].source_id, o.value]));
    if (m.evaluator === "posting") {
      copy.sources = copy.sources.filter((d) => !m.roles.includes(d.role) || d.role === "landing_page");
      for (const fact of facts.values()) fact.links = [];
    } else if (m.evaluator === "consistency") {
      facts.get(copy.sources.find((d) => d.role === "policy_statement").source_id).terms.eligibility_percent = 300;
    } else if (m.evaluator === "uniform" || m.evaluator === "service_area") {
      for (const v of facts.values()) { if (v.present_sections) v.present_sections = []; if (v.published_counties) v.published_counties = []; }
    } else if (m.evaluator === "fpl") for (const v of facts.values()) v.cells[0].amount++;
    else for (const key of facts.keys()) facts.set(key, adverse[m.evaluator]);
    assert.equal(evaluateMeasure(m,copy,facts).result,"no", m.measure_id);
  }
});
test("an inaccessible page, unmatched partial dollars, non-gross installment and lower band cannot prove a failure", () => {
  const input = load("SYN-2025"), landing = input.sources[0];
  landing.status = "unavailable";
  assert.equal(evaluateMeasure(measure("R"),input,new Map([[landing.source_id,{links:[],search_complete:false}]])).result,"unclear");
  const row = { published_year:null,currency:"USD",period:"annual",cells:[{household_size:1,fpl_percent:400,amount:62600}] };
  assert.equal(fplComparison(row,2025).result,"unclear");
  assert.equal(fplComparison(row,2026).result,"no");
  const app = input.sources.find((d) => d.role === "application");
  assert.equal(evaluateMeasure(measure("AI"),input,new Map([[app.source_id,{percent:300,hard_ceiling:false}]])).result,"unclear");
  assert.equal(evaluateMeasure(measure("AJ"),input,new Map([[app.source_id,{percent:2,basis:"interest_rate"}]])).result,"unclear");
});
test("CLI output reproduces the checked-in multilingual report across processes without a network or map writes", () => {
  const cli = fileURLToPath(new URL("../grading/cli.js", import.meta.url));
  const history = fileURLToPath(new URL("../../data/maps/hospitals.geojson", import.meta.url));
  const original = sha256(readFileSync(history));
  const cmd = () => execFileSync(process.execPath,[cli,"grade",join(examples,"SYN-multilingual.json")],{
    env:{...process.env,HTTP_PROXY:"http://127.0.0.1:1",HTTPS_PROXY:"http://127.0.0.1:1"} });
  const output = cmd();
  assert.deepEqual(output, cmd());
  assert.deepEqual(output, readFileSync(join(examples,"SYN-multilingual.expected.json")));
  const r = JSON.parse(output);
  validateSchema(r,"grading-report-v1.schema.json");
  assert.equal(r.grade_status,"pending");
  assert.equal(at(r,"AI").result,"unclear");
  assert.deepEqual(at(r,"AI").document_results.map((d) => d.language),["en","es"]);
  assert.ok(at(r,"AI").coverage_gaps.some((g) => g.includes("[pl]")));
  assert.equal(sha256(readFileSync(history)),original);
});

test("qualitative coding needs located text and an independent decision on this exact observation", (t) => {
  const root = temp(t), decisions = temp(t);
  cpSync(join(examples,"sources"),join(root,"sources"),{recursive:true});
  const input = load("SYN-2025"), f = at(input,"AL");
  const doc = input.sources.find((s) => s.role === "policy_summary");
  const citation = f.evidence[0], quote = "SYN assistance covers SYN County.";
  // Keep other measures unresolved rather than borrowing structured fields from the replaced summary.
  for (const other of input.findings.filter((other) => other !== f && other.evidence.some((e) => e.source_id === doc.source_id))) {
    Object.assign(other,{result:"unclear",observed:[],evidence:[],unresolved_evidence:["SYN summary revision requires review."]});
  }
  writeFileSync(join(root,"summary.txt"),quote);
  Object.assign(doc.snapshot,{sha256:sha256(quote),snapshot_id:sha256(quote),artifact_path:"summary.txt"});
  Object.assign(citation,{sha256:sha256(quote),snapshot_id:sha256(quote),locator:"line 1",quote});
  f.observed[0].method="human_coded";
  assert.equal(at(grade(input,{root,decisions}),"AL").result,"unclear");
  const hash=reviewSubject(input,f);
  mkdirSync(join(decisions,hash));
  writeFileSync(join(decisions,hash,"SYN.json"),JSON.stringify({subject_sha256:hash,decision:"approved",
    reviewer_role:"SYN reviewer",reason:"SYN check of cited county",recorded_at:iso}));
  assert.equal(at(grade(input,{root,decisions}),"AL").result,"yes");
  f.observed[0].value.areas = ["SYN different county"];
  assert.equal(at(grade(input,{root,decisions}),"AL").result,"unclear");
});
