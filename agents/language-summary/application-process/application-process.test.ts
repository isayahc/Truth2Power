import { test } from "node:test"
import assert from "node:assert/strict"
import { validateProcessReading } from "./validate.ts"
import { determineApplicationProcess } from "./result.ts"
import type { ReviewSource } from "../../shared/review-sources.ts"
import { htmlEvidence } from "../../shared/review-sources.ts"
const source = { id: "SYN-1", roles: ["policy_summary"], snapshot: { sha256: "synthetic", sourceUrl: "https://example.org/summary.pdf" },
  passages: [{ locator: "PDF page 2", text: "Download a form at www.example.org. Mail completed applications to Synthetic Hospital, 123 Example Way, Fiction NY 00000. Envíe la solicitud completa a Synthetic Hospital, 123 Example Way, Fiction NY 00000." }] } as ReviewSource
const destination = "Synthetic Hospital, 123 Example Way, Fiction NY 00000"
const submit = { action: "submit", route: "postal", destination, locator: "PDF page 2", quote: `Mail completed applications to ${destination}.` }
const obtain = { action: "obtain", route: "online", destination: "www.example.org", locator: "PDF page 2", quote: "Download a form at www.example.org." }
test("live HTML findings retain provenance without satisfying a missing summary", () => {
  const webpage = { ...source, roles: ["landing_page"],
    passages: [{ locator: "HTML extracted text", text: htmlEvidence(`<main><p>${submit.quote}</p></main>`) }] }
  const reading = validateProcessReading(JSON.stringify({ instructions: [{ ...submit, locator: "HTML extracted text" }], limitations: [] }), webpage)
  const result = determineApplicationProcess([{ taskId: "website-1:process", source: webpage, reading }], ["synthetic"], [], [webpage])
  assert.equal(result.value, null)
  assert.equal(result.webpages[0].value, true)
  assert.equal(result.webpages[0].readingStatus, "validated")
  assert.equal(result.evidence[0].sourceKind, "webpage")
  assert.equal(result.evidence[0].taskId, "website-1:process")
  const failed = determineApplicationProcess([], ["synthetic"], ["website-1:process: invalid JSON"], [webpage])
  assert.equal(failed.webpages[0].readingStatus, "unresolved")
  assert.equal(failed.webpages[0].sourceUrl, webpage.snapshot.sourceUrl)
  assert.equal(failed.webpages[0].value, null)
})
function review(instructions: unknown[], limitations: string[] = []) {
  return { taskId: "read", source, reading: validateProcessReading(JSON.stringify({ instructions, limitations }), source) }
}
test("submission instructions require source-matched destinations and original quotations", () => {
  assert.equal(review([submit, obtain]).reading.instructions.length, 2)
  assert.equal(review([{ ...submit, quote: `Envíe la solicitud completa a ${destination}.` }]).reading.instructions.length, 1)
  assert.throws(() => review([{ ...submit, destination: "Invented office" }]), /destination/)
  assert.throws(() => review([{ ...submit, locator: "PDF page 1" }]), /quotation/)
  assert.throws(() => review([submit, submit]), /Duplicate/)
})
test("download, completion and help alone do not establish submission", () => {
  for (const action of ["obtain", "complete", "get_help", "provide_documents"]) {
    assert.equal(determineApplicationProcess([review([{ ...obtain, action }])], ["synthetic"], []).value, null)
  }
  assert.equal(determineApplicationProcess([review([{ ...submit, destination: null }])], ["synthetic"], []).value, null)
  assert.equal(determineApplicationProcess([review([])], ["synthetic"], []).value, null)
})
test("every identified summary needs a route; ambiguity and wrong document roles remain unresolved", () => {
  assert.equal(determineApplicationProcess([review([submit])], ["synthetic"], []).value, true)
  assert.equal(determineApplicationProcess([review([submit])], ["synthetic", "missing"], []).value, null)
  assert.equal(determineApplicationProcess([review([submit], ["Unclear destination"])], ["synthetic"], []).value, null)
  const r = review([submit]); r.source = { ...source, roles: ["application"] }
  assert.equal(determineApplicationProcess([r], ["synthetic"], []).value, null)
  assert.equal(determineApplicationProcess([], [], []).value, null)
})
