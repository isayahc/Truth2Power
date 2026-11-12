import { test } from "node:test"
import assert from "node:assert/strict"
import { mkdtemp, readFile, rm } from "node:fs/promises"
import { join } from "node:path"
import { tmpdir } from "node:os"
import { TaskGraph } from "../../task-graph/index.ts"
import { validateApplication } from "./validate.ts"
import { determineApplicationPosted } from "./result.ts"
import type { ReviewedDocument } from "./result.ts"

const pages = [{ page: 1, text: "SYNTHETIC Financial Assistance Application\nApplicant name: ______" }]
const reading = { isApplication: true, evidence: [
  { kind: "heading", page: 1, quote: "Financial Assistance Application" },
  { kind: "form_field", page: 1, quote: "Applicant name:" },
] }

test("positive identification needs actual heading and form field on cited pages", () => {
  assert.equal(validateApplication(JSON.stringify(reading), pages).isApplication, true)
  assert.throws(() => validateApplication(JSON.stringify({ ...reading, evidence: [reading.evidence[0]] }), pages))
  assert.throws(() => validateApplication(JSON.stringify({ ...reading, evidence: reading.evidence.map(e => ({ ...e, page: 2 })) }), pages))
  assert.throws(() => validateApplication(JSON.stringify(reading), [{ page: 1, text: "Privacy notice" }]))
  assert.throws(() => validateApplication('{"isApplication":"true","evidence":[]}', pages))
})

test("absence of a positive reading is unresolved, not false", () => {
  assert.equal(determineApplicationPosted([]).value, null)
  const doc: ReviewedDocument = {
    taskId: "document-1:identify", reading: validateApplication(JSON.stringify(reading), pages),
    snapshot: { snapshot_id: "synthetic", sha256: "synthetic", sourceUrl: "https://example.org/form.pdf",
      finalUrl: "https://example.org/form.pdf", retrievedAt: "2026-11-11T00:00:00Z", httpStatus: 200,
      path: "synthetic.pdf", bytes: 1, kind: "pdf" },
  }
  assert.equal(determineApplicationPosted([doc]).value, true)
  assert.equal(determineApplicationPosted([doc]).evidence[0].taskId, doc.taskId)
  assert.equal(determineApplicationPosted([{ ...doc, reading: { isApplication: false, evidence: [] } }]).value, null)
})

test("graph enforces dependencies, records executor and blocks downstream work after failure", async () => {
  const directory = await mkdtemp(join(tmpdir(), "hospital-graph-test-"))
  try {
    const graph = new TaskGraph("SYN-HOSPITAL", directory)
    graph.add("download", "website-and-policy", "code", "SYN-DOC")
    graph.add("read", "website-and-policy", "agent", "SYN-DOC", ["download"])
    await assert.rejects(() => graph.run("read", async () => true), /Dependencies/)
    await graph.run("download", async () => { throw new Error("HTTP 404") })
    let called = false
    await graph.run("read", async () => { called = true })
    assert.equal(called, false)
    graph.add("decide", "website-and-policy", "code", "k1", ["read"])
    const result = await graph.run("decide", async () => determineApplicationPosted([]), true)
    assert.equal(result?.value, null)
    const saved = JSON.parse(await readFile(join(directory, "tasks.json"), "utf8"))
    assert.deepEqual(saved.tasks.map((t: any) => t.status), ["failed", "blocked", "succeeded"])
    assert.equal(saved.tasks[1].owner, "website-and-policy")
    assert.equal(saved.tasks[1].hospitalId, "SYN-HOSPITAL")
  } finally { await rm(directory, { recursive: true, force: true }) }
})
