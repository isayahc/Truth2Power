import { test } from "node:test"
import assert from "node:assert/strict"
import { validateMaximumReading } from "./validate.ts"
import { determineMaximumFpl } from "./result.ts"
import type { ReviewSource } from "../../shared/review-sources.ts"
const source = { id: "SYN-1", roles: ["application"], snapshot: { sha256: "synthetic", sourceUrl: "https://example.org/form.pdf" },
  passages: [{ locator: "PDF page 3", text: "Individuals up to 400% of the federal poverty level are eligible for financial assistance. No financial assistance is available above 300% FPL. We may offer aid up to 500% FPL at our discretion. Uninsured patients qualify. Ayuda disponible hasta el 400% del nivel federal de pobreza." }] } as ReviewSource
const favorable = { kind: "eligibility", percent: 400, scope: "general", locator: "PDF page 3", quote: "Individuals up to 400% of the federal poverty level are eligible for financial assistance." }
const ceiling = { kind: "hard_ceiling", percent: 300, scope: "general", locator: "PDF page 3", quote: "No financial assistance is available above 300% FPL." }
function review(limits: unknown[], limitations: string[] = []) {
  return { taskId: "read", source, reading: validateMaximumReading(JSON.stringify({ limits, conditions: [], limitations }), source) }
}
test("eligibility quotes and printed percentages must match, including source-language evidence", () => {
  assert.equal(review([favorable]).reading.limits.length, 1)
  assert.equal(review([{ ...favorable, quote: "Ayuda disponible hasta el 400% del nivel federal de pobreza." }]).reading.limits.length, 1)
  assert.throws(() => review([{ ...favorable, percent: 500 }]), /percentage/)
  assert.throws(() => review([{ ...favorable, locator: "PDF page 1" }]), /quotation/)
  assert.throws(() => review([favorable, favorable]), /Duplicate/)
})
test("explicit 400% eligibility passes each identified application but missing readings remain unresolved", () => {
  assert.equal(determineMaximumFpl([review([favorable])], ["synthetic"], []).value, true)
  assert.equal(determineMaximumFpl([review([favorable])], ["synthetic", "missing"], []).value, null)
  assert.equal(determineMaximumFpl([review([])], ["synthetic"], []).value, null)
  assert.equal(determineMaximumFpl([], [], []).value, null)
  const r = review([favorable]); r.source = { ...source, roles: ["policy_summary"] }
  assert.equal(determineMaximumFpl([r], ["synthetic"], []).value, null)
})
test("general hard ceilings fail; contradictory or subgroup provisions need reconciliation", () => {
  assert.equal(determineMaximumFpl([review([ceiling])], ["synthetic"], []).value, false)
  assert.equal(determineMaximumFpl([review([favorable, ceiling])], ["synthetic"], []).value, null)
  assert.equal(determineMaximumFpl([review([{ ...ceiling, scope: "subgroup" }])], ["synthetic"], []).value, null)
  assert.equal(determineMaximumFpl([review([{ ...ceiling, kind: "eligibility" }])], ["synthetic"], []).value, null)
  assert.equal(determineMaximumFpl([review([favorable], ["Unclear exclusion"])], ["synthetic"], []).value, null)
})
test("discretion above 400% alone is not guaranteed eligibility", () => {
  const discretionary = { kind: "discretionary", percent: 500, scope: "general", locator: "PDF page 3", quote: "We may offer aid up to 500% FPL at our discretion." }
  assert.equal(determineMaximumFpl([review([discretionary])], ["synthetic"], []).value, null)
  assert.equal(determineMaximumFpl([review([favorable, discretionary])], ["synthetic"], []).value, true)
})
