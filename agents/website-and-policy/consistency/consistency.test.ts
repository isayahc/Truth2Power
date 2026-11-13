import { test } from "node:test"
import assert from "node:assert/strict"
import { validateComparison, validateConfirmation } from "./validate.ts"
import { determineConsistency } from "./result.ts"
import { htmlEvidence } from "../../shared/review-sources.ts"
import type { ConsistencySource } from "./types.ts"

const sources: ConsistencySource[] = [300, 400].map((limit, index) => ({
  id: `SYN-${index}`, roles: [index ? "policy_statement" : "policy_summary"],
  snapshot: { snapshot_id: `SYN-${index}`, sha256: `SYN-${index}`, sourceUrl: `https://example.org/${index}.pdf`,
    finalUrl: `https://example.org/${index}.pdf`, path: "synthetic.pdf", kind: "pdf", bytes: 1, httpStatus: 200,
    retrievedAt: "2026-11-11T00:00:00Z" },
  passages: [{ locator: "PDF page 1", text: `For all patients, the maximum eligible income is ${limit}% of FPL.` }],
}))
const proposed = { comparedSourceIds: sources.map(s => s.id), limitations: [], conflicts: [{
  topic: "Maximum eligible income", explanation: "Both state different maximums for all patients.",
  evidence: sources.map(s => ({ sourceId: s.id, locator: "PDF page 1", quote: s.passages[0].text })),
}] }

test("consistency conflicts must cite two actual sources and cover the complete supplied inventory", () => {
  assert.equal(validateComparison(JSON.stringify(proposed), sources).conflicts.length, 1)
  assert.throws(() => validateComparison(JSON.stringify({ ...proposed, comparedSourceIds: [sources[0].id] }), sources))
  const invented = structuredClone(proposed)
  invented.conflicts[0].evidence[1].quote = "Patients can never apply for aid."
  assert.throws(() => validateComparison(JSON.stringify(invented), sources), /source verification/)
  const sameSource = structuredClone(proposed)
  sameSource.conflicts[0].evidence[1] = sameSource.conflicts[0].evidence[0]
  assert.throws(() => validateComparison(JSON.stringify(sameSource), sources), /two different/)
  const wrongPage = structuredClone(proposed)
  wrongPage.conflicts[0].evidence[0].locator = "PDF page 99"
  assert.throws(() => validateComparison(JSON.stringify(wrongPage), sources), /source verification/)
})

test("false requires a confirmed cited contradiction; missing evidence never becomes false or true", () => {
  const comparison = validateComparison(JSON.stringify(proposed), sources)
  assert.equal(determineConsistency(sources, comparison, undefined, []).value, null)
  assert.equal(determineConsistency(sources, comparison, { confirmed: [], limitations: ["Ambiguous"] }, []).value, null)
  assert.equal(determineConsistency([], undefined, undefined, ["Download failed"]).value, null)
  assert.equal(determineConsistency(sources, { ...comparison, conflicts: [] }, { confirmed: [], limitations: [] }, []).value, null)
  const result = determineConsistency(sources, comparison, { confirmed: [0], limitations: [] }, ["Another document is missing"])
  assert.equal(result.value, false)
  assert.equal(result.evidence.length, 2)
  assert.equal(result.evidence[1].sourceUrl, sources[1].snapshot.sourceUrl)
})

test("confirmation cannot invent or duplicate candidate indexes", () => {
  assert.deepEqual(validateConfirmation('{"confirmed":[0],"limitations":[]}', 1).confirmed, [0])
  assert.throws(() => validateConfirmation('{"confirmed":[1],"limitations":[]}', 1))
  assert.throws(() => validateConfirmation('{"confirmed":[0,0],"limitations":[]}', 1))
  assert.throws(() => validateConfirmation('{"confirmed":["0"],"limitations":[]}', 1))
})

test("webpage evidence excludes script, style, and comments and decodes text", () => {
  assert.equal(htmlEvidence('<p>Financial &amp; assistance</p><script>fake policy</script><!-- fake -->'), 'Financial & assistance')
})
