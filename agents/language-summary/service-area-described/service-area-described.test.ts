import { test } from "node:test"
import assert from "node:assert/strict"
import { validateSummaryArea } from "./validate.ts"
import { determineSummaryArea } from "./result.ts"
import type { ReviewSource } from "../../shared/review-sources.ts"
const source = { id: "SYN-1", roles: ["policy_summary"], snapshot: { sha256: "synthetic", sourceUrl: "https://example.org/summary.pdf" },
  passages: [{ locator: "PDF page 1", text: "Emergency aid covers New York residents. For other necessary services our primary service area includes Alpha and Beta counties. El área de servicio incluye los condados de Alpha y Beta." }] } as ReviewSource
const area = { scope: "primary_service_area", areas: ["Alpha", "Beta"], locator: "PDF page 1", quote: "For other necessary services our primary service area includes Alpha and Beta counties." }
const emergency = { scope: "emergency_only", areas: ["New York"], locator: "PDF page 1", quote: "Emergency aid covers New York residents." }
function review(descriptions: unknown[], limitations: string[] = []) {
  return { taskId: "read", source, reading: validateSummaryArea(JSON.stringify({ descriptions, limitations }), source) }
}
test("area descriptions require actual named geography and original-language quotations", () => {
  assert.equal(review([area, emergency]).reading.descriptions.length, 2)
  assert.equal(review([{ ...area, quote: "El área de servicio incluye los condados de Alpha y Beta." }]).reading.descriptions.length, 1)
  assert.throws(() => review([{ ...area, areas: ["Gamma"] }]), /Area name/)
  assert.throws(() => review([{ ...area, locator: "PDF page 2" }]), /quotation/)
  assert.throws(() => review([{ ...area, areas: ["Alpha", "Alpha"] }]), /Duplicate/)
})
test("emergency-only geography and silence cannot establish the primary service area", () => {
  assert.equal(determineSummaryArea([review([emergency])], ["synthetic"], []).value, null)
  assert.equal(determineSummaryArea([review([])], ["synthetic"], []).value, null)
  assert.equal(determineSummaryArea([], [], []).value, null)
})
test("each designated summary needs a supported area; unrelated policy evidence does not substitute", () => {
  const result = determineSummaryArea([review([area, emergency])], ["synthetic"], [])
  assert.equal(result.value, true)
  assert.equal(result.evidence.length, 2)
  assert.equal(result.summaries[0].descriptions[1].scope, "emergency_only")
  assert.equal(determineSummaryArea([review([area])], ["synthetic", "missing"], []).value, null)
  const r = review([area]); r.source = { ...source, roles: ["policy_statement"] }
  assert.equal(determineSummaryArea([r], ["synthetic"], []).value, null)
  assert.equal(determineSummaryArea([review([area], ["Unclear service scope"])], ["synthetic"], []).value, null)
})
