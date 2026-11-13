import { test } from "node:test"
import assert from "node:assert/strict"
import { validateImmigrationReading, validateImmigrationDecisions } from "./validate.ts"
import { determineImmigrationBarrier } from "./result.ts"
import type { ImmigrationReview, ImmigrationConfirmation } from "./result.ts"
import type { ReviewSource } from "../../shared/review-sources.ts"

const source: ReviewSource = {
  id: "SYN-1", roles: ["policy_statement"],
  snapshot: { snapshot_id: "synthetic", sha256: "synthetic", sourceUrl: "https://example.org/policy.pdf",
    finalUrl: "https://example.org/policy.pdf", path: "synthetic.pdf", kind: "pdf", bytes: 1, httpStatus: 200,
    retrievedAt: "2026-11-11T00:00:00Z" },
  passages: [{ locator: "PDF page 1", text: "Financial assistance is available regardless of immigration status. Only citizens qualify for financial assistance. Applicants must provide a Medicaid denial letter. Citizenship field (optional). Emergency treatment is available regardless of immigration status. La ayuda económica está disponible sin importar su situación migratoria." }],
}
const favorable = { kind: "regardless_of_status", locator: "PDF page 1", quote: "Financial assistance is available regardless of immigration status.", explanation: "Explicit financial-aid eligibility" }
const barrier = { kind: "status_barrier", locator: "PDF page 1", quote: "Only citizens qualify for financial assistance.", explanation: "Explicit citizenship condition" }
const ambiguous = { kind: "ambiguous", locator: "PDF page 1", quote: "Applicants must provide a Medicaid denial letter.", explanation: "No immigration-ineligibility exception stated" }
function review(statements: unknown[]): ImmigrationReview {
  return { taskId: "source-1:immigration", source, reading: validateImmigrationReading(JSON.stringify({ statements, limitations: [] }), source) }
}
function confirmation(confirmed: boolean, index = 0): ImmigrationConfirmation[] {
  return [{ reviewTaskId: "source-1:immigration", taskId: "source-1:confirm-immigration", decisions: [{ index, confirmed, explanation: "Synthetic independent review" }] }]
}

test("immigration evidence preserves source-language quotes and rejects invented text or pages", () => {
  assert.equal(review([favorable, barrier, ambiguous]).reading.statements.length, 3)
  assert.equal(review([{ ...favorable, quote: "La ayuda económica está disponible sin importar su situación migratoria." }]).reading.statements.length, 1)
  assert.throws(() => review([{ ...favorable, locator: "PDF page 2" }]), /source verification/)
  assert.throws(() => review([{ ...barrier, quote: "Only lawful residents qualify for financial assistance." }]), /source verification/)
  assert.throws(() => review([favorable, favorable]), /Duplicate/)
  assert.throws(() => review([{ ...favorable, kind: "pass" }]))
})

test("confirmation requires exact candidate coverage with unique indexes", () => {
  const decision = { index: 1, confirmed: true, explanation: "Explicit condition" }
  assert.equal(validateImmigrationDecisions(JSON.stringify({ decisions: [decision] }), [1]).length, 1)
  assert.throws(() => validateImmigrationDecisions(JSON.stringify({ decisions: [decision] }), [0]))
  assert.throws(() => validateImmigrationDecisions(JSON.stringify({ decisions: [decision, decision] }), [1]))
  assert.throws(() => validateImmigrationDecisions('{"decisions":[]}', [1]), /omitted/)
  assert.throws(() => validateImmigrationDecisions(JSON.stringify({ decisions: [{ ...decision, confirmed: "true" }] }), [1]))
})

test("silence, gaps, unconfirmed protections and unclear Medicaid prerequisites remain unresolved", () => {
  assert.equal(determineImmigrationBarrier([], [], []).value, null)
  assert.equal(determineImmigrationBarrier([review([])], [], []).value, null)
  assert.equal(determineImmigrationBarrier([review([favorable])], [], []).value, null)
  assert.equal(determineImmigrationBarrier([review([favorable])], confirmation(false), []).value, null)
  assert.equal(determineImmigrationBarrier([review([favorable])], confirmation(true), []).value, true)
  assert.equal(determineImmigrationBarrier([review([favorable])], confirmation(true), ["Missing policy"]).value, null)
  assert.equal(determineImmigrationBarrier([review([favorable, ambiguous])], confirmation(true), []).value, null)
})

test("a citizenship restriction requires confirmation and a recognized source role", () => {
  const r = review([barrier])
  assert.equal(determineImmigrationBarrier([r], [], []).value, null)
  assert.equal(determineImmigrationBarrier([r], confirmation(false), []).value, null)
  const result = determineImmigrationBarrier([r], confirmation(true), ["Other source missing"])
  assert.equal(result.value, false)
  assert.equal(result.evidence[0].confirmationTaskId, "source-1:confirm-immigration")
  assert.equal(determineImmigrationBarrier([{ ...r, source: { ...source, roles: [] } }], confirmation(true), []).value, null)
  assert.equal(determineImmigrationBarrier([review([favorable, barrier])], confirmation(true, 1), []).value, false)
})

test("rejected optional-field and treatment-access interpretations cannot decide eligibility", () => {
  for (const statement of [
    { ...barrier, quote: "Citizenship field (optional)." },
    { ...favorable, quote: "Emergency treatment is available regardless of immigration status." },
  ]) {
    const result = determineImmigrationBarrier([review([statement])], confirmation(false), [])
    assert.equal(result.value, null)
    assert.equal(result.evidence[0].interpretationConfirmed, false)
  }
})
