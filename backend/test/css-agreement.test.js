import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { compareCell, comparison, historicalResult, markdown, summarize } from "../../scripts/compare-wave-one.js";

test("replay matches the saved report, keeps 17 CSS columns and counts each facility once per column", () => {
  const report = comparison();
  const saved = readFileSync(new URL("../../docs/validation/wave-one-css-agreement.md", import.meta.url), "utf8");
  assert.equal(markdown(report), saved);
  assert.deepEqual(report.rows.map((r) => r.column), "R S T U V W Y Z AD AE AG AH AI AJ AL AM AN".split(" "));
  for (const row of report.rows) {
    assert.deepEqual(row.pairs.map((p) => p.hospital_key), ["1002", "362"]);
    assert.equal(row.comparable + row.excluded, 2);
    for (const [index, pair] of row.pairs.entries()) {
      assert.ok(pair.baseline_cell.endsWith("range=" + row.column + [40, 78][index]));
      if (pair.outcome === "agree") assert.ok(pair.scopes.every((s) => s.assessed_at && s.record_id && s.citations.length));
    }
  }
  assert.deepEqual(report.totals, {agree:16, differ:0, comparable:16, excluded:18, total:34});
  const al = report.rows.find((r) => r.column === "AL");
  assert.deepEqual(al.pairs.map((p) => p.baseline_result), ["yes", "no"]);
  assert.equal(al.agree, 2);
  assert.equal(report.rows.find((r) => r.column === "AH").comparable, 0);
});

test("convert only explicit booleans or, for AI, explicit percentages", () => {
  assert.equal(historicalResult("R", false), "no");
  assert.equal(historicalResult("R", null), null);
  assert.equal(historicalResult("R", "false"), null);
  for (const value of ["no", "", "N/A", "3", null]) assert.equal(historicalResult("AI", value), null);
  assert.equal(historicalResult("AI", "300%"), "no");
  assert.equal(historicalResult("AI", "400%"), "yes");
});

test("count a dated disagreement once and keep unresolved, unsupported and inapplicable pairs outside the denominator", () => {
  const measure = {result:"no", versions:[{finding:{evidence:[{url:"https://example.org",sha256:"a".repeat(64),locator:"page 1",quote:"SYN"}]}}]};
  assert.equal(compareCell("AL", "yes", measure, 2026), "differ");
  assert.equal(compareCell("AH", "no", measure, 2026), "different FPL reference years");
  for (const result of ["unclear", "n_a"]) assert.equal(compareCell("AL", "yes", {...measure,result}, 2026),"unresolved draft");
  assert.equal(compareCell("AL", null, measure, 2026),"baseline unavailable");
  assert.equal(compareCell("AL", "yes", {...measure,versions:[]}, 2026),"no completed finding");
  measure.versions[0].finding.evidence = [];
  assert.equal(compareCell("AL", "yes", measure, 2026),"missing citation");
  assert.deepEqual(summarize([{outcome:"agree"},{outcome:"differ"},{outcome:"unresolved draft"}]),
    {agree:1,differ:1,comparable:2,excluded:1,total:3});
});
