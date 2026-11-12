import { test } from "node:test"
import assert from "node:assert/strict"
import { validateContactReading, validateContactDecisions, contactKey } from "./validate.ts"
import { determineContactInformation } from "./result.ts"
import { contactPageLinks } from "./website.ts"
import type { ContactReview } from "./result.ts"
import type { ReviewSource } from "../../shared/review-sources.ts"

const quote = "For help with your financial assistance application call our office at (212) 555-0100."
const source = { id: "SYN-1", roles: ["application"], snapshot: { sha256: "synthetic", sourceUrl: "https://example.org/form.pdf", retrievedAt: "2026-11-11T00:00:00Z" },
  passages: [{ locator: "PDF page 3", text: quote }] } as ReviewSource
const contact = { type: "telephone", value: "(212) 555-0100", organization: "hospital", locator: "PDF page 3", quote, explanation: "Explicit application help" }
function review(confirmed = true): ContactReview {
  return { taskId: "source-1:contacts", source,
    reading: validateContactReading(JSON.stringify({ contacts: [contact], limitations: [] }), source),
    confirmationTaskId: "confirm", decisions: [{ index: 0, confirmed, explanation: "Synthetic interpretation" }] }
}
test("contacts must have source-matched context, number and page", () => {
  assert.equal(review().reading.contacts.length, 1)
  // Extraction commentary is optional; source evidence and independent purpose
  // confirmation remain mandatory for a positive determination.
  const { explanation, ...withoutCommentary } = contact
  assert.equal(validateContactReading(JSON.stringify({ contacts: [withoutCommentary], limitations: [] }), source).contacts.length, 1)
  for (const bad of [{ ...contact, value: "(212) 555-0199" }, { ...contact, locator: "PDF page 2" }, { ...contact, quote: "Call this hospital for help." }]) {
    assert.throws(() => validateContactReading(JSON.stringify({ contacts: [bad], limitations: [] }), source), /verification/)
  }
  const invalid = { ...contact, value: "555", quote: "For application help call 555." }
  assert.throws(() => validateContactReading(JSON.stringify({ contacts: [invalid], limitations: [] }), {
    ...source, passages: [{ locator: "PDF page 3", text: invalid.quote }],
  }), /telephone/)
})
test("confirmation indexes cannot be invented, omitted or duplicated", () => {
  const d = { index: 0, confirmed: true, explanation: "Explicit application help" }
  assert.equal(validateContactDecisions(JSON.stringify({ decisions: [d] }), 1).length, 1)
  assert.throws(() => validateContactDecisions('{"decisions":[]}', 1), /omitted/)
  assert.throws(() => validateContactDecisions(JSON.stringify({ decisions: [d, d] }), 1))
  assert.throws(() => validateContactDecisions(JSON.stringify({ decisions: [{ ...d, index: 2 }] }), 1))
})
test("website-only and rejected contacts cannot satisfy an application", () => {
  const website = { ...review(), source: { ...source, roles: ["website_corroboration"] } }
  assert.equal(determineContactInformation([website], ["synthetic"], []).value, null)
  assert.equal(determineContactInformation([review(false)], ["synthetic"], []).value, null)
  assert.equal(determineContactInformation([], [], []).value, null)
  assert.equal(determineContactInformation([review()], ["synthetic", "missing-language"], []).value, null)
})
test("confirmed contacts on every identified application establish scoped presence despite web failure", () => {
  const result = determineContactInformation([review()], ["synthetic"], ["Website unavailable"])
  assert.equal(result.value, true)
  assert.equal(result.evidence[0].role, "application")
  assert.ok(result.limitations.includes("Website unavailable"))
  const website = { ...review(), taskId: "web", source: { ...source, roles: ["website_corroboration"] } }
  assert.deepEqual(determineContactInformation([review(), website], ["synthetic"], []).corroboration[0].websiteTaskIds, ["web"])
})
test("phone matching retains extensions and tolerates punctuation", () => {
  assert.equal(contactKey({ type: "telephone", value: "(212) 555-0100" }), contactKey({ type: "telephone", value: "212.555.0100" }))
  assert.notEqual(contactKey({ type: "telephone", value: "212-555-0100 ext. 322" }), contactKey({ type: "telephone", value: "212-555-0100" }))
})
test("contact crawl follows only relevant same-origin page links", () => {
  assert.deepEqual(contactPageLinks(`<a href="/contact-us/">Contact</a><a href="/patient-guests/paying-for-your-care/">Billing</a>
    <a href="https://other.example/contact-us/">Contact</a><a href="/form.pdf">Financial assistance</a>
    <a href="mailto:help@example.org">Contact us</a><a href="(212) 555-0100">Patient Finance</a><a href="/jobs/">Jobs</a>`, "https://example.org/aid/"),
    ["https://example.org/contact-us/", "https://example.org/patient-guests/paying-for-your-care/"])
})
