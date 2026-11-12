import { test } from "node:test"
import assert from "node:assert/strict"
import { validateDeadline, validateDeadlineConfirmation } from "./validate.ts"
import { determineSubmissionDeadline } from "./result.ts"
import type { TimingReview } from "./result.ts"
import type { ReviewSource } from "../../shared/review-sources.ts"

const source: ReviewSource = {
  id: "SYN-1", roles: ["policy_statement"],
  snapshot: { snapshot_id: "synthetic", sha256: "synthetic", sourceUrl: "https://example.org/policy.pdf",
    finalUrl: "https://example.org/policy.pdf", path: "synthetic.pdf", kind: "pdf", bytes: 1, httpStatus: 200,
    retrievedAt: "2026-11-11T00:00:00Z" },
  passages: [{ locator: "PDF page 1", text: "Patients may apply at any time, including during collections. The hospital decides within 30 days. Complete the application in a timely manner. Applications must be submitted within 60 days of the bill." }],
}
const permissive = { kind: "any_time", locator: "PDF page 1", quote: "Patients may apply at any time, including during collections.", explanation: "Explicit unrestricted submission." }
const cutoff = { kind: "submission_deadline", locator: "PDF page 1", quote: "Applications must be submitted within 60 days of the bill.", explanation: "Explicit filing cutoff." }

function review(statements: unknown[]): TimingReview {
  return { taskId: "source-1:timing", source, reading: validateDeadline(JSON.stringify({ statements, limitations: [] }), source) }
}

test("submission timing evidence must match source pages and retain favorable and ambiguous wording", () => {
  const ambiguous = { kind: "ambiguous", locator: "PDF page 1", quote: "Complete the application in a timely manner.", explanation: "No fixed cutoff; meaning is unclear." }
  const reading = review([permissive, ambiguous]).reading
  assert.equal(reading.statements.length, 2)
  assert.throws(() => review([{ ...permissive, locator: "PDF page 2" }]), /source verification/)
  assert.throws(() => review([{ ...permissive, quote: "Applications are forbidden after 90 days." }]), /source verification/)
  assert.throws(() => review([permissive, permissive]), /Duplicate/)
  assert.throws(() => review([{ ...permissive, kind: "pass" }]))
})

test("no finding, failed coverage and ambiguous wording remain unresolved", () => {
  assert.equal(determineSubmissionDeadline([], [], []).value, null)
  assert.equal(determineSubmissionDeadline([review([])], [], []).value, null)
  assert.equal(determineSubmissionDeadline([review([permissive])], [], ["Missing document"]).value, null)
  const ambiguous = { kind: "ambiguous", locator: "PDF page 1", quote: "Complete the application in a timely manner.", explanation: "Unclear restriction" }
  assert.equal(determineSubmissionDeadline([review([permissive, ambiguous])], [], []).value, null)
  assert.equal(determineSubmissionDeadline([review([permissive])], [], []).value, true)
})

test("a restriction needs separate confirmation and a recognized source role", () => {
  const r = review([cutoff])
  assert.equal(determineSubmissionDeadline([r], [], []).value, null)
  const rejected = [{ reviewTaskId: r.taskId, statementIndex: 0, taskId: "confirm-1", result: { confirmed: false, explanation: "Not an initial application cutoff" } }]
  assert.equal(determineSubmissionDeadline([r], rejected, []).value, null)
  const confirmed = [{ ...rejected[0], result: { confirmed: true, explanation: "Explicit initial application cutoff" } }]
  const result = determineSubmissionDeadline([r], confirmed, ["Other source missing"])
  assert.equal(result.value, false)
  assert.equal(result.evidence[0].confirmationTaskId, "confirm-1")
  assert.equal(determineSubmissionDeadline([{ ...r, source: { ...source, roles: [] } }], confirmed, []).value, null)
  assert.throws(() => validateDeadlineConfirmation('{"confirmed":"true","explanation":"reason"}'))
})

test("processing time misclassified by an initial reader does not fail k6 when confirmation rejects it", () => {
  const r = review([{ kind: "submission_deadline", locator: "PDF page 1", quote: "The hospital decides within 30 days.", explanation: "Initial model interpretation" }])
  const rejected = [{ reviewTaskId: r.taskId, statementIndex: 0, taskId: "confirm-processing", result: validateDeadlineConfirmation(
    '{"confirmed":false,"explanation":"The hospital decision period is not a patient filing deadline."}') }]
  assert.equal(determineSubmissionDeadline([r], rejected, []).value, null)
})
