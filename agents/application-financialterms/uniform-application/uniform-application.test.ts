import { test } from "node:test"
import assert from "node:assert/strict"
import { sectionIds } from "./instructions.ts"
import { validateUniformReading } from "./validate.ts"
import { determineUniformApplication } from "./result.ts"
import type { ReviewSource } from "../../shared/review-sources.ts"
import type { UniformReference } from "./reference.ts"

const application = { id: "SYN-1", roles: ["application"], snapshot: { sourceUrl: "https://example.org/form.pdf", sha256: "synthetic" },
  passages: [{ locator: "PDF page 1", text: "Synthetic application field and required instructions." },
    { locator: "PDF page 2", text: "Synthetic signature and supporting evidence." }] } as ReviewSource
const reference: UniformReference = { version: "SYN-template", sourceUrl: "https://example.org/reference", sourceHash: "synthetic",
  renderHash: "synthetic-render", sourcePath: "synthetic.docx", renderPath: "synthetic.pdf", derived: true,
  passages: [{ locator: "Reference render page 1", text: "Synthetic official field and required instructions." }] }
function response() {
  return { applicationPages: application.passages.map(p => p.locator), referencePages: reference.passages.map(p => p.locator),
    sections: sectionIds.map(id => ({ id, status: "correspondence", explanation: "Synthetic text correspondence",
      application: [{ locator: "PDF page 1", quote: "Synthetic application field" }],
      reference: [{ locator: "Reference render page 1", quote: "Synthetic official field" }] })), limitations: [] }
}
test("whole-form comparisons must account for every page and section", () => {
  assert.equal(validateUniformReading(JSON.stringify(response()), application, reference).sections.length, 6)
  const missingPage = response(); missingPage.applicationPages.pop()
  assert.throws(() => validateUniformReading(JSON.stringify(missingPage), application, reference), /pages/)
  const missingSection = response(); missingSection.sections.pop()
  assert.throws(() => validateUniformReading(JSON.stringify(missingSection), application, reference), /section/)
  const duplicate = response(); duplicate.sections[1] = duplicate.sections[0]
  assert.throws(() => validateUniformReading(JSON.stringify(duplicate), application, reference), /section/)
})
test("paired quotations must match their own sources; absence is only uncertain", () => {
  const wrong = response(); wrong.sections[0].application[0].quote = "Synthetic official field"
  assert.throws(() => validateUniformReading(JSON.stringify(wrong), application, reference), /quotation/)
  const absent = response(); absent.sections[0].application = []
  assert.throws(() => validateUniformReading(JSON.stringify(absent), application, reference), /paired/)
  absent.sections[0].status = "uncertain"
  assert.equal(validateUniformReading(JSON.stringify(absent), application, reference).sections[0].status, "uncertain")
})
test("text correspondence or differences do not replace visual and applicability review", () => {
  for (const status of ["correspondence", "difference"]) {
    const output = response(); output.sections[0].status = status
    const reading = validateUniformReading(JSON.stringify(output), application, reference)
    const result = determineUniformApplication([{ taskId: "compare", source: application, reading }], reference, [])
    assert.equal(result.value, null)
    assert.equal(result.visualReviewComplete, false)
    assert.equal(result.evidence.length, 12)
    assert.equal(result.evidence[1].sha256, reference.renderHash)
  }
  assert.equal(determineUniformApplication([], undefined, ["Missing reference"]).value, null)
})
