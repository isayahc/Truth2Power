import { test } from "node:test"
import assert from "node:assert/strict"
import { validateTablesReading, validateTableDecisions } from "./validate.ts"
import { determineIncomeDiscountTables } from "./result.ts"
import type { TablesReview } from "./result.ts"
import type { ReviewSource } from "../../shared/review-sources.ts"

const source = { id: "SYN-1", roles: ["application"], snapshot: { sha256: "synthetic", sourceUrl: "https://example.org/form.pdf" },
  passages: [{ locator: "PDF page 4", text: "Household income thresholds (2024)\n1 person $10,000 $20,000\n2 persons $15,000 $30,000\nMinimum discount rates\nBelow 200% No charge\n200% to 300% 10% of charges" }] } as ReviewSource
const citation = (quote: string) => ({ locator: "PDF page 4", quote })
const income = { kind: "income", header: citation("Household income thresholds (2024)"), rows: [
  { ...citation("1 person $10,000 $20,000"), values: ["$10,000", "$20,000"] },
  { ...citation("2 persons $15,000 $30,000"), values: ["$15,000", "$30,000"] },
] }
const discount = { kind: "discount", header: citation("Minimum discount rates"), rows: [
  { ...citation("Below 200% No charge"), values: ["No charge"] },
  { ...citation("200% to 300% 10% of charges"), values: ["10% of charges"] },
] }
function reading(tables: unknown[]) { return validateTablesReading(JSON.stringify({ tables, limitations: [] }), source) }
function review(tables: unknown[] = [income, discount], confirmed = true): TablesReview {
  return { taskId: "tables", source, reading: reading(tables), confirmationTaskId: "confirm",
    decisions: tables.map((_, index) => ({ index, confirmed, explanation: "Synthetic independent review" })) }
}
test("table evidence requires headers, distinct rows and source-matched cells", () => {
  assert.equal(reading([income, discount]).tables.length, 2)
  assert.throws(() => reading([{ ...income, header: { ...income.header, locator: "PDF page 3" } }]), /quotation/)
  assert.throws(() => reading([{ ...income, rows: [income.rows[0], income.rows[0]] }]), /distinct/)
  assert.throws(() => reading([{ ...income, rows: [income.rows[0], { ...income.rows[1], values: ["$15,000", "$99,999"] }] }]), /support/)
  assert.throws(() => reading([income, income]), /duplicate/)
})
test("confirmation indexes must exactly cover extracted tables", () => {
  const d = { index: 0, confirmed: true, explanation: "Synthetic confirmation" }
  assert.equal(validateTableDecisions(JSON.stringify({ decisions: [d] }), 1).length, 1)
  assert.throws(() => validateTableDecisions(JSON.stringify({ decisions: [d, d] }), 1))
  assert.throws(() => validateTableDecisions(JSON.stringify({ decisions: [{ ...d, index: 2 }] }), 1))
  assert.throws(() => validateTableDecisions('{"decisions":[]}', 1), /omitted/)
})
test("both tables must be confirmed on each application; silence or failures are not absence", () => {
  assert.equal(determineIncomeDiscountTables([review()], ["synthetic"], []).value, true)
  assert.equal(determineIncomeDiscountTables([review([income])], ["synthetic"], []).value, null)
  assert.equal(determineIncomeDiscountTables([review([], false)], ["synthetic"], []).value, null)
  assert.equal(determineIncomeDiscountTables([review(undefined, false)], ["synthetic"], []).value, null)
  assert.equal(determineIncomeDiscountTables([review()], ["synthetic", "failed-language"], []).value, null)
  assert.equal(determineIncomeDiscountTables([], [], []).value, null)
  const wrongRole = { ...review(), source: { ...source, roles: ["policy_summary"] } }
  assert.equal(determineIncomeDiscountTables([wrongRole], ["synthetic"], []).value, null)
})
test("old table years do not fail table-presence checks; provenance is retained", () => {
  const result = determineIncomeDiscountTables([review()], ["synthetic"], ["Other source missing"])
  assert.equal(result.value, true)
  assert.equal(result.evidence.length, 6)
  assert.equal(result.evidence[0].quote, "Household income thresholds (2024)")
  assert.equal(result.evidence[0].confirmationTaskId, "confirm")
})
