import { test } from "node:test"
import assert from "node:assert/strict"
import { validateAssetReading, validateAssetDecisions } from "./validate.ts"
import { determineAssetChecks } from "./result.ts"
import type { AssetReview, AssetConfirmation } from "./result.ts"
import type { ReviewSource } from "../../shared/review-sources.ts"

const source: ReviewSource = {
  id: "SYN-1", roles: ["policy_statement"],
  snapshot: { snapshot_id: "synthetic", sha256: "synthetic", sourceUrl: "https://example.org/policy.pdf",
    finalUrl: "https://example.org/policy.pdf", path: "synthetic.pdf", kind: "pdf", bytes: 1, httpStatus: 200,
    retrievedAt: "2026-11-11T00:00:00Z" },
  passages: [{ locator: "PDF page 1", text: "Assets such as a house or car are not considered for eligibility. Savings must be below $500 to qualify. After personal resources have been exhausted, assistance is available. Bank statements verify income only." }],
}
const favorable = { kind: "no_asset_test", locator: "PDF page 1", quote: "Assets such as a house or car are not considered for eligibility.", explanation: "Explicit exclusion" }
const restriction = { kind: "asset_test", locator: "PDF page 1", quote: "Savings must be below $500 to qualify.", explanation: "Savings eligibility threshold" }
const ambiguous = { kind: "ambiguous", locator: "PDF page 1", quote: "After personal resources have been exhausted, assistance is available.", explanation: "Unclear whether resources means assets" }
function review(statements: unknown[]): AssetReview {
  return { taskId: "source-1:assets", source, reading: validateAssetReading(JSON.stringify({ statements, limitations: [] }), source) }
}
function confirmation(confirmed: boolean, index = 0): AssetConfirmation[] {
  return [{ reviewTaskId: "source-1:assets", taskId: "source-1:confirm-assets", decisions: [{ index, confirmed, explanation: "Synthetic independent interpretation" }] }]
}

test("asset quotations require original text, correct page and unique citations", () => {
  assert.equal(review([favorable, restriction, ambiguous]).reading.statements.length, 3)
  assert.throws(() => review([{ ...favorable, locator: "PDF page 2" }]), /source verification/)
  assert.throws(() => review([{ ...restriction, quote: "Savings must be below $900 to qualify." }]), /source verification/)
  assert.throws(() => review([favorable, favorable]), /Duplicate/)
})

test("confirmation cannot omit, invent or duplicate candidate indexes", () => {
  const decision = { index: 1, confirmed: true, explanation: "Explicit condition" }
  assert.equal(validateAssetDecisions(JSON.stringify({ decisions: [decision] }), [1]).length, 1)
  assert.throws(() => validateAssetDecisions(JSON.stringify({ decisions: [decision] }), [0]))
  assert.throws(() => validateAssetDecisions(JSON.stringify({ decisions: [decision, decision] }), [1]))
  assert.throws(() => validateAssetDecisions('{"decisions":[]}', [1]), /omitted/)
  assert.throws(() => validateAssetDecisions(JSON.stringify({ decisions: [{ ...decision, confirmed: "true" }] }), [1]))
})

test("favorable findings require confirmation and complete coverage; silence is unresolved", () => {
  assert.equal(determineAssetChecks([], [], []).value, null)
  assert.equal(determineAssetChecks([review([])], [], []).value, null)
  assert.equal(determineAssetChecks([review([favorable])], [], []).value, null)
  assert.equal(determineAssetChecks([review([favorable])], confirmation(false), []).value, null)
  assert.equal(determineAssetChecks([review([favorable])], confirmation(true), []).value, true)
  assert.equal(determineAssetChecks([review([favorable])], confirmation(true), ["Unavailable policy"]).value, null)
  assert.equal(determineAssetChecks([review([favorable, ambiguous])], confirmation(true), []).value, null)
})

test("false requires a confirmed restriction in a recognized source role", () => {
  const r = review([restriction])
  assert.equal(determineAssetChecks([r], [], []).value, null)
  assert.equal(determineAssetChecks([r], confirmation(false), []).value, null)
  const result = determineAssetChecks([r], confirmation(true), ["Other source missing"])
  assert.equal(result.value, false)
  assert.equal(result.evidence[0].confirmationTaskId, "source-1:confirm-assets")
  assert.equal(determineAssetChecks([{ ...r, source: { ...source, roles: [] } }], confirmation(true), []).value, null)
  const both = determineAssetChecks([review([favorable, restriction])], confirmation(true, 1), [])
  assert.equal(both.value, false)
})

test("income documentation misclassified by first reader cannot fail after confirmation rejects it", () => {
  const r = review([{ kind: "asset_test", locator: "PDF page 1", quote: "Bank statements verify income only.", explanation: "Incorrect first interpretation" }])
  const result = determineAssetChecks([r], confirmation(false), [])
  assert.equal(result.value, null)
  assert.equal(result.evidence[0].interpretationConfirmed, false)
})
