import test from "node:test";
import assert from "node:assert/strict";
import { compareCounties, reportingContext } from "../reporting/context.js";
import { handler } from "../src/handler.js";
import { calculate } from "../grading/grade.js";
import { rubric } from "../grading/data.js";

test("both Wave 1 contexts include each document and keep missing language unverified", () => {
  const ellenville = reportingContext("1002"), littleFalls = reportingContext("362");
  assert.equal(ellenville.documents.length, 11);
  assert.equal(littleFalls.documents.length, 7);
  assert.deepEqual(ellenville.documents.filter((d) => d.role === "application").map((d) => d.language), ["English", "Spanish", "Polish", "Ukrainian", "Russian"]);
  assert.equal(ellenville.documents.find((d) => d.language === "Unknown").language_status, "unverified_filename_label");
  assert.deepEqual(littleFalls.documents.filter((d) => d.role === "policy_summary").map((d) => d.language), ["English", "Spanish"]);
  assert.equal(ellenville.psa.reported_counties.length, 7);
  assert.equal(littleFalls.psa.reported_counties, null);
  assert.ok(littleFalls.psa.statements.every((s) => s.geography_type === "places"));
  for (const context of [ellenville, littleFalls]) {
    assert.equal(context.included_in_grade, false);
    assert.equal(context.psa.comparison.status, "pending_review");
    assert.equal(context.psa.comparison.expected_counties, null);
    assert.ok(context.documents.every((d) => d.url.startsWith("https://")));
  }
});

test("synthetic county comparison requires independent, located reference evidence", () => {
  const psa = { statements: [{ geography_type: "counties", reported_counties: ["SYN-A", "SYN-C"], language: "English", evidence: { url: "https://hospital.example/SYN-policy" } }],
    expected_reference: { counties: ["SYN-A", "SYN-B"], independent: false, publisher: "SYN authority", url: "https://authority.example/SYN-counties", locator: "SYN row", quote: "SYN-A and SYN-B", applicability: "SYN hospital and year" } };
  assert.equal(compareCounties(psa).expected_counties, null);
  psa.expected_reference.independent = true;
  const result = compareCounties(psa);
  assert.equal(result.status, "differs_from_reference");
  assert.deepEqual(result.differences[0].missing, ["SYN-B"]);
  assert.deepEqual(result.differences[0].additional, ["SYN-C"]);
  psa.expected_reference.quote = "";
  assert.equal(compareCounties(psa).reference, null);
});

test("context is read-only and unassessed hospitals do not inherit Wave 1 data", async () => {
  const request = (path, method = "GET") => handler({ rawPath: path, requestContext: { http: { method } } });
  assert.equal((await request("/api/hospitals/362/reporting-context")).statusCode, 200);
  assert.equal((await request("/api/hospitals/362/reporting-context", "HEAD")).body, "");
  assert.equal((await request("/api/hospitals/362/reporting-context", "POST")).statusCode, 405);
  assert.equal((await request("/api/hospitals/999999/reporting-context")).statusCode, 404);
});

test("reporting fields add no graded measures; both distinct PSA checks remain counted", () => {
  const findings = rubric.measures.map((m) => ({ measure_id: m.measure_id, result: "yes" }));
  assert.equal(findings.length, 17);
  assert.equal(calculate(findings).verified_errors, 0);
  const psaMeasures = reportingContext("362").graded_checks;
  assert.equal(psaMeasures.length, 2);
  for (const id of psaMeasures) findings.find((f) => f.measure_id === id).result = "no";
  assert.equal(calculate(findings).verified_errors, 2);
  assert.throws(() => calculate([...findings, { measure_id: "reporting.document_languages", result: "no" }]), /17 distinct/);
  assert.throws(() => calculate([...findings, { measure_id: "reporting.psa_counties", result: "no" }]), /17 distinct/);
});
