import { test } from "node:test"
import assert from "node:assert/strict"
import { validateSummary } from "./validate.ts"
import { determineSummaryPosted } from "./result.ts"
import type { ReviewedSummary } from "./result.ts"

const pages = [{ page: 1, text: "SYNTHETIC Financial Assistance Summary\nYou may qualify for help paying your hospital bill." }]
const reading = { isSummary: true, evidence: [
  { kind: "designation", page: 1, quote: "Financial Assistance Summary" },
  { kind: "assistance_information", page: 1, quote: "You may qualify for help paying your hospital bill." },
] }

test("summary evidence requires designation and assistance content on the claimed pages", () => {
  assert.equal(validateSummary(JSON.stringify(reading), pages).isSummary, true)
  assert.throws(() => validateSummary(JSON.stringify({ ...reading, evidence: [reading.evidence[0]] }), pages))
  assert.throws(() => validateSummary(JSON.stringify({ ...reading, evidence: reading.evidence.map(e => ({ ...e, page: 2 })) }), pages))
  assert.throws(() => validateSummary(JSON.stringify(reading), [{ page: 1, text: "Privacy Notice. Patient Name: ____" }]))
  assert.throws(() => validateSummary('{"isSummary":"true","evidence":[]}', pages))
  assert.throws(() => validateSummary('{"isSummary":true,"evidence":[]}', pages))
})

test("source-language quotations are verified without translation", () => {
  const spanish = [{ page: 1, text: "Resumen de asistencia financiera\nAyuda para pagar su factura" }]
  const evidence = [{ kind: "designation", page: 1, quote: "Resumen de asistencia financiera" },
    { kind: "assistance_information", page: 1, quote: "Ayuda para pagar su factura" }]
  assert.equal(validateSummary(JSON.stringify({ isSummary: true, evidence }), spanish).isSummary, true)
  assert.throws(() => validateSummary(JSON.stringify(reading), spanish))
})

test("k2 returns true with cited summary evidence, otherwise unresolved, never false", () => {
  const doc: ReviewedSummary = {
    taskId: "document-1:identify", reading: validateSummary(JSON.stringify(reading), pages),
    snapshot: { snapshot_id: "synthetic", sha256: "synthetic", sourceUrl: "https://example.org/summary.pdf",
      finalUrl: "https://example.org/summary.pdf", retrievedAt: "2026-11-11T00:00:00Z", httpStatus: 200,
      path: "synthetic.pdf", bytes: 1, kind: "pdf" },
  }
  const result = determineSummaryPosted([doc])
  assert.equal(result.value, true)
  assert.equal(result.criterion, "posted_materials.policy_summary_posted")
  assert.equal(result.evidence.length, 2)
  assert.equal(result.evidence[0].taskId, doc.taskId)
  assert.equal(determineSummaryPosted([]).value, null)
  assert.equal(determineSummaryPosted([{ ...doc, reading: { isSummary: false, evidence: [] } }]).value, null)
  assert.equal(determineSummaryPosted([{ ...doc, reading: { isSummary: null, evidence: [] } }]).value, null)
})
