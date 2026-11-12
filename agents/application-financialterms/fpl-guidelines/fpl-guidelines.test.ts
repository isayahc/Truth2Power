import { test } from "node:test"
import assert from "node:assert/strict"
import { validateFplReading, usd } from "./validate.ts"
import { determineFplGuidelines } from "./result.ts"
import type { ReviewSource } from "../../shared/review-sources.ts"
import type { FplReference } from "./reference.ts"
const source = { id: "SYN-1", roles: ["application"], snapshot: { sha256: "synthetic", sourceUrl: "https://example.org/form.pdf" },
  passages: [{ locator: "PDF page 4", text: "Federal Poverty Guidelines (2024)\n200% 300% 400%\n1 $30,120 $45,180 $60,240" }] } as ReviewSource
const ref = { year: 2026, amounts: [15960,21640,27320,33000,38680,44360,50040,55720] } as FplReference
const c = (quote: string) => ({ locator: "PDF page 4", quote })
function response() { return { year: { value: 2024, ...c("Federal Poverty Guidelines (2024)") },
  header: c("200% 300% 400%"), rows: [{ household: 1, ...c("1 $30,120 $45,180 $60,240"), amounts: ["$30,120", "$45,180", "$60,240"] }], limitations: [] } }
test("source-verified year and dollar mismatches are compared deterministically", () => {
  const reading = validateFplReading(JSON.stringify(response()), source)
  const result = determineFplGuidelines([{ taskId: "read", source, reading }], ["synthetic"], ref, [])
  assert.equal(result.value, false)
  assert.equal(result.applications[0].outdated, true)
  assert.equal(result.applications[0].cells[2].expected, 63840)
  assert.equal(result.applications[0].cells[2].observed, 60240)
})
test("bad rows are withheld without discarding a separately verified year", () => {
  const out = response(); out.rows[0].amounts[2] = "$99,999"
  const reading = validateFplReading(JSON.stringify(out), source)
  assert.equal(reading.rows.length, 0)
  assert.equal(reading.year?.value, 2024)
  assert.ok(reading.limitations.some(s => s.includes("Rejected")))
  const duplicate = response(); duplicate.rows.push(duplicate.rows[0])
  assert.equal(validateFplReading(JSON.stringify(duplicate), source).rows.length, 0)
})
test("invented years, missing column context, swapped cells and ambiguous currencies cannot pass", () => {
  const wrong = response(); wrong.year.value = 2026
  assert.throws(() => validateFplReading(JSON.stringify(wrong), source), /year/)
  const swapped = response(); swapped.rows[0].amounts.reverse()
  assert.equal(validateFplReading(JSON.stringify(swapped), source).rows.length, 0)
  const reading = validateFplReading(JSON.stringify({ ...response(), header: null, year: null }), source)
  assert.equal(determineFplGuidelines([{ taskId: "read", source, reading }], ["synthetic"], ref, []).value, null)
  assert.equal(usd("$63,840"), 63840)
  assert.throws(() => usd("63.840,00"))
  assert.equal(determineFplGuidelines([], [], undefined, []).value, null)
})
test("a pass requires all 24 verified cells and the assessment year", () => {
  const rows = ref.amounts.map((base, i) => ({ household: i+1, locator: "PDF page 4", quote: "Synthetic verified row", amounts: [], dollars: [base*2,base*3,base*4] }))
  const reading = { year: { value: 2026, ...c("Synthetic 2026 table") }, header: c("200% 300% 400%"), rows, limitations: [] }
  assert.equal(determineFplGuidelines([{ taskId: "read", source, reading }], ["synthetic"], ref, []).value, true)
  reading.rows.pop()
  assert.equal(determineFplGuidelines([{ taskId: "read", source, reading }], ["synthetic"], ref, []).value, null)
})
