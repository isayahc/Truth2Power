import { test } from "node:test"
import assert from "node:assert/strict"
import { validatePolicy } from "./validate.ts"
import { determinePolicyPosted } from "./result.ts"
import type { ReviewedPolicy } from "./result.ts"
import { relatedFinancialPages } from "../../document-discovery/website-search.ts"

const pages = [
  { page: 1, text: "SYNTHETIC Hospital Financial Assistance Policy and Procedure" },
  { page: 2, text: "The financial counselor shall review each application for eligibility." },
]
const reading = { isPolicy: true, evidence: [
  { kind: "policy_identity", page: 1, quote: "Financial Assistance Policy and Procedure" },
  { kind: "governing_provision", page: 2, quote: "The financial counselor shall review each application for eligibility." },
] }

test("policy proof needs identity and governing provisions at verified page locations", () => {
  assert.equal(validatePolicy(JSON.stringify(reading), pages).isPolicy, true)
  assert.throws(() => validatePolicy(JSON.stringify({ ...reading, evidence: [reading.evidence[0]] }), pages))
  assert.throws(() => validatePolicy(JSON.stringify({ ...reading, evidence: reading.evidence.map(e => ({ ...e, page: 7 })) }), pages))
  assert.throws(() => validatePolicy(JSON.stringify(reading), [{ page: 1, text: "Financial Assistance Summary" }]))
  assert.throws(() => validatePolicy('{"isPolicy":"true","evidence":[]}', pages))
})

test("policy determination is true with source-backed readings, otherwise unresolved", () => {
  const doc: ReviewedPolicy = {
    taskId: "document-1:identify", reading: validatePolicy(JSON.stringify(reading), pages),
    snapshot: { snapshot_id: "synthetic", sha256: "synthetic", sourceUrl: "https://example.org/policy.pdf",
      finalUrl: "https://example.org/policy.pdf", retrievedAt: "2026-11-11T00:00:00Z", httpStatus: 200,
      path: "synthetic.pdf", bytes: 1, kind: "pdf" },
  }
  const result = determinePolicyPosted([doc])
  assert.equal(result.value, true)
  assert.equal(result.criterion, "posted_materials.policy_statement_posted")
  assert.equal(result.evidence[1].locator, "PDF page 2")
  assert.equal(result.evidence[0].taskId, doc.taskId)
  assert.equal(determinePolicyPosted([]).value, null)
  assert.equal(determinePolicyPosted([{ ...doc, reading: { isPolicy: false, evidence: [] } }]).value, null)
})

test("website search follows only relevant same-origin HTML links", () => {
  const html = `<a href="/financial-assistance#contact">Financial Assistance</a>
    <a href="/financial-assistance">Duplicate</a>
    <a href="/patient-aid">Charity care</a>
    <a href="https://other.example/financial-assistance">External</a>
    <a href="/financial-assistance.pdf">Policy PDF</a>
    <a href="/privacy">Privacy notice</a>
    <a href="http://example.org/financial-assistance">Insecure</a>
    <script><a href="/fake">Financial assistance</a></script>`
  assert.deepEqual(relatedFinancialPages(html, "https://example.org/aid"), [
    "https://example.org/financial-assistance", "https://example.org/patient-aid",
  ])
})
