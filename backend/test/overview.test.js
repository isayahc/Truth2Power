import test from "node:test";
import assert from "node:assert/strict";
import { overview, summarize, hospitalRow } from "../overview/service.js";
import { hospitalPage, pageInputs } from "../hospital-page/service.js";
import { handler } from "../src/handler.js";

const measure = "application.contact_information";
const asOf = new Date("2026-11-09T12:00:00Z");
function success(id, at, result) {
  return { hospital_key:"362", guideline_year:2026, kind:"application-reviews", scope:"SYN-English",
    scope_label:"SYN English application", record_id:id, status:"completed", checked_at:at,
    findings:[{measure_id:measure, result, explanation:"SYN", evidence:[{quote:"SYN source"}]}] };
}
const report = (records, time = asOf) => overview({inputs:{records,unavailable:[]},asOf:time});
const row = (r) => r.hospitals.find((h) => h.hospital_key === "362");

test("all roster entries contribute once statewide and by region, including never assessed hospitals", () => {
  const r = overview({inputs:pageInputs("/SYN-empty-not-present"),asOf});
  assert.equal(r.statewide.total,212);
  assert.equal(new Set(r.hospitals.map((h) => h.hospital_key)).size,212);
  assert.deepEqual(r.statewide.freshness,{current:2,overdue:0,never:210});
  assert.equal(r.statewide.current_grades.pending,2);
  assert.equal(r.statewide.current_grades.unassessed,210);
  assert.equal(r.regions.length,10);
  assert.equal(r.regions.reduce((n,g) => n+g.total,0),212);
  for (const g of r.regions) assert.deepEqual(summarize(r.hospitals.filter((h) => h.region===g.region)).freshness,g.freshness);
  assert.equal(row(r).region,"Mohawk Valley");
  assert.equal(r.hospitals.find((h) => h.hospital_key === "1002").region,"Mid-Hudson");
});

test("successful revisions move a hospital between finding buckets once; duplicate replays and failed retries preserve counts", () => {
  const a = success("SYN-a","2026-10-01T12:00:00Z","no");
  const b = success("SYN-b","2026-11-09T11:00:00Z","yes");
  const failed = {...b,record_id:"SYN-c",checked_at:"2026-11-09T11:30:00Z",status:"failed",affected_measures:[measure],findings:[],error:"SYN timeout"};
  const first = report([a]), next = report([a,b]), retry = report([a,b,b,failed]);
  assert.equal(row(first).freshness,"overdue");
  assert.equal(row(next).freshness,"current");
  assert.equal(first.statewide.findings.flagged,1);
  assert.equal(next.statewide.findings.flagged,0);
  assert.equal(next.statewide.findings.no_recorded_failure,1);
  assert.deepEqual(next.regions,retry.regions);
  assert.equal(row(retry).last_successful_assessment_at,b.checked_at);
  assert.equal(row(next).revision,hospitalPage("362",{records:[a,b]}).revision);
  assert.notEqual(row(next).revision,row(first).revision);
  assert.equal(row(report([a,failed])).freshness,"overdue");
  assert.equal(row(report([failed])).freshness,"never");
  assert.equal(row(report([b],new Date("2026-12-09T11:00:00Z"))).freshness,"overdue");
});

test("a revised institutional rating moves between grade buckets once without moving the historical count", () => {
  const feature = {id:"362",properties:{name:"SYN",county:"Herkimer",grade:"A"}};
  const page = hospitalPage("362",{records:[success("SYN","2026-11-08T00:00:00Z","yes")]});
  const remaining = report([]).hospitals.filter((h) => h.hospital_key !== "362");
  const initial = summarize([...remaining,hospitalRow(feature,{...page,revision:"SYN-1",current_grade:"B"},asOf)]);
  const revised = summarize([...remaining,hospitalRow(feature,{...page,revision:"SYN-2",current_grade:"C"},asOf)]);
  assert.equal(initial.current_grades.B,1);
  assert.equal(revised.current_grades.B,0);
  assert.equal(revised.current_grades.C,1);
  assert.equal(revised.total,212);
  assert.deepEqual(initial.historical,revised.historical);
});

test("overview and detail share a revision and reject stale drill-down links", async () => {
  const get = (rawPath,queryStringParameters) => handler({rawPath,queryStringParameters,requestContext:{http:{method:"GET"}}});
  const list = await get("/api/overview");
  assert.equal(list.statusCode,200);
  const h = row(JSON.parse(list.body));
  const page = await get("/api/hospitals/362/page",{revision:h.revision});
  assert.equal(JSON.parse(page.body).latest_successful_assessment_at,h.last_successful_assessment_at);
  assert.equal((await get("/api/hospitals/362/page",{revision:"SYN-stale"})).statusCode,409);
  assert.equal((await handler({rawPath:"/api/overview",requestContext:{http:{method:"POST"}}})).statusCode,405);
});
