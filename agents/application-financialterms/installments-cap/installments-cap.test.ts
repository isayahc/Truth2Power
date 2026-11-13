import { test } from "node:test"
import assert from "node:assert/strict"
import { validateInstallmentReading } from "./validate.ts"
import { determineInstallmentCap } from "./result.ts"
import type { ReviewSource } from "../../shared/review-sources.ts"
const source = { id: "SYN-1", roles: ["application"], snapshot: { sha256: "synthetic", sourceUrl: "https://example.org/form.pdf" },
  passages: [{ locator: "PDF page 4", text: "Monthly installments shall not exceed 5% of gross monthly income. Interest shall not exceed 2%. Monthly installments may reach 10% of gross monthly income. There is no limit on monthly installments. Monthly payments are capped at 5% of net monthly income. Pagos mensuales no excederán el 5% de los ingresos brutos mensuales." }] } as ReviewSource
const cap = { kind: "payment_cap", percent: 5, basis: "gross_monthly_income", locator: "PDF page 4", quote: "Monthly installments shall not exceed 5% of gross monthly income." }
const interest = { kind: "interest_cap", percent: 2, basis: "not_applicable", locator: "PDF page 4", quote: "Interest shall not exceed 2%." }
const uncapped = { kind: "explicitly_uncapped", percent: null, basis: "not_applicable", locator: "PDF page 4", quote: "There is no limit on monthly installments." }
function review(statements: unknown[], limitations: string[] = []) {
  return { taskId: "read", source, reading: validateInstallmentReading(JSON.stringify({ statements, limitations }), source) }
}
test("cap percentages and original-language quotations must match the cited page", () => {
  assert.equal(review([cap, interest]).reading.statements.length, 2)
  assert.equal(review([{ ...cap, quote: "Pagos mensuales no excederán el 5% de los ingresos brutos mensuales." }]).reading.statements.length, 1)
  assert.throws(() => review([{ ...cap, percent: 2 }]), /percentage/)
  assert.throws(() => review([{ ...cap, locator: "PDF page 1" }]), /quotation/)
  assert.throws(() => review([{ ...cap, percent: null }]), /statement/)
  assert.throws(() => review([cap, cap]), /Duplicate/)
})
test("5% gross monthly cap passes; interest alone and missing applications remain unresolved", () => {
  assert.equal(determineInstallmentCap([review([cap, interest])], ["synthetic"], []).value, true)
  assert.equal(determineInstallmentCap([review([interest])], ["synthetic"], []).value, null)
  assert.equal(determineInstallmentCap([review([cap])], ["synthetic", "missing"], []).value, null)
  assert.equal(determineInstallmentCap([review([])], ["synthetic"], []).value, null)
  assert.equal(determineInstallmentCap([], [], []).value, null)
})
test("net or unspecified income basis does not establish the required gross monthly cap", () => {
  const net = { ...cap, basis: "net_monthly_income", quote: "Monthly payments are capped at 5% of net monthly income." }
  assert.equal(determineInstallmentCap([review([net])], ["synthetic"], []).value, null)
  assert.equal(determineInstallmentCap([review([{ ...cap, basis: "unspecified" }])], ["synthetic"], []).value, null)
})
test("higher or explicit uncapped payments fail; competing clauses require reconciliation", () => {
  const higher = { ...cap, percent: 10, quote: "Monthly installments may reach 10% of gross monthly income." }
  assert.equal(determineInstallmentCap([review([higher])], ["synthetic"], []).value, false)
  assert.equal(determineInstallmentCap([review([uncapped])], ["synthetic"], []).value, false)
  assert.equal(determineInstallmentCap([review([cap, higher])], ["synthetic"], []).value, null)
  assert.equal(determineInstallmentCap([review([cap, uncapped])], ["synthetic"], []).value, null)
  assert.equal(determineInstallmentCap([review([cap], ["Unclear exception"])], ["synthetic"], []).value, null)
})
