import { test } from "node:test"
import assert from "node:assert/strict"
import type { ReviewSource } from "../../shared/review-sources.ts"
import { validateIncomeReading } from "./validate.ts"
import { determineIncomeLevels } from "./result.ts"
const quote = "Synthetic Hospital offers assistance for income below 300% of federal poverty guidelines."
const spanish = "El hospital ficticio ofrece asistencia para ingresos inferiores al 300% del nivel federal de pobreza."
const source = { id: "SYN-1", roles: ["policy_summary"], snapshot: { sha256: "synthetic", sourceUrl: "https://example.org/summary.pdf" },
  passages: [{ locator: "PDF page 1", text: `${quote} ${spanish}` }] } as ReviewSource
const level = { basis: "fpl_percent", threshold: "300%", locator: "PDF page 1", quote }
function review(levels: unknown[], limitations: string[] = []) {
  return { taskId: "summary-1:income", source, reading: validateIncomeReading(JSON.stringify({ levels, limitations }), source) }
}
test("income evidence requires numeric thresholds and original source-matched quotations", () => {
  assert.equal(review([level]).reading.levels[0].threshold, "300%")
  assert.equal(review([{ ...level, quote: spanish }]).reading.levels.length, 1)
  assert.throws(() => review([{ ...level, threshold: "400%" }]), /not supported/)
  assert.throws(() => review([{ ...level, threshold: "low income" }]), /numeric/)
  assert.throws(() => review([{ ...level, locator: "PDF page 2" }]), /verification/)
  assert.throws(() => review([level, level]), /Duplicate/)
})
test("every summary requires an income level; silence, failed readings and ambiguity stay unresolved", () => {
  assert.equal(determineIncomeLevels([review([level])], [source], []).value, true)
  assert.equal(determineIncomeLevels([review([])], [source], []).value, null)
  assert.equal(determineIncomeLevels([review([level], ["Unclear eligibility scope"])], [source], []).value, null)
  const other = { ...source, snapshot: { ...source.snapshot, sourceUrl: "https://example.org/spanish.pdf" } }
  const result = determineIncomeLevels([review([level])], [source, other], ["Spanish reading failed"])
  assert.equal(result.value, null)
  assert.equal(result.summaries[1].readingStatus, "unresolved")
  assert.equal(result.summaries[1].sourceUrl, other.snapshot.sourceUrl)
  assert.equal(determineIncomeLevels([], [], []).value, null)
})
test("different income bands can share one contextual quotation", () => {
  const quote = "Synthetic assistance tiers cover incomes below 150% and from 150% to 300% of poverty guidelines."
  const tableSource = { ...source, passages: [{ locator: "PDF page 1", text: quote }] }
  const levels = ["150%", "300%"].map(threshold => ({ ...level, threshold, quote }))
  assert.equal(validateIncomeReading(JSON.stringify({ levels, limitations: [] }), tableSource).levels.length, 2)
})
test("webpage income evidence retains its provenance and cannot replace summary evidence", () => {
  const webpage = { ...source, roles: ["landing_page"], passages: [{ locator: "HTML extracted text", text: quote }] }
  const reading = validateIncomeReading(JSON.stringify({ levels: [{ ...level, locator: "HTML extracted text" }], limitations: [] }), webpage)
  const result = determineIncomeLevels([{ taskId: "website-1:income", source: webpage, reading }], [source, webpage], [])
  assert.equal(result.value, null)
  assert.equal(result.webpages[0].value, true)
  assert.equal(result.evidence[0].sourceKind, "webpage")
  assert.equal(result.evidence[0].locator, "HTML extracted text")
  const failed = determineIncomeLevels([review([level])], [source, webpage], ["Website reading failed"])
  assert.equal(failed.value, true)
  assert.equal(failed.webpages[0].readingStatus, "unresolved")
})
