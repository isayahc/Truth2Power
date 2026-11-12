import { test } from "node:test"
import assert from "node:assert/strict"
import { createHash } from "node:crypto"
import { mkdir, mkdtemp, writeFile, rm } from "node:fs/promises"
import { join } from "node:path"
import { tmpdir } from "node:os"
import { sourceStore } from "./source-reuse.ts"

test("reuse checks hospital identity and file integrity; missing/failed sources never silently refetch", async () => {
  const root = process.platform === "win32" ? join(process.env.LOCALAPPDATA!, "Temp", "opencode") : tmpdir()
  await mkdir(root, { recursive: true })
  const dir = await mkdtemp(join(root, "source-reuse-"))
  try {
    const hospital = { id: "SYN-1", financialAssistanceUrl: "https://example.org/aid" }
    const bytes = Buffer.from("%PDF-1.7 synthetic fixture")
    const hash = createHash("sha256").update(bytes).digest("hex")
    const pdf = join(dir, "source.pdf")
    await writeFile(pdf, bytes)
    const snapshot = { path: pdf, kind: "pdf", sourceUrl: "https://example.org/application.pdf", finalUrl: "https://example.org/application.pdf",
      sha256: hash, snapshot_id: hash, bytes: bytes.length, httpStatus: 200, retrievedAt: "2026-11-11T00:00:00Z" }
    const graphPath = join(dir, "tasks.json")
    const resultPath = join(dir, "result.json")
    await writeFile(graphPath, JSON.stringify({ hospitalId: hospital.id, tasks: [
      { id: "document-1:download", item: snapshot.sourceUrl, status: "succeeded", result: snapshot },
      { id: "document-2:download", item: "https://example.org/old.pdf", status: "failed", error: "HTTP 404" },
    ] }))
    await writeFile(resultPath, JSON.stringify({ hospital, taskGraph: graphPath }))
    const store = await sourceStore(dir, hospital, resultPath)
    const reused = await store.get(snapshot.sourceUrl, "pdf")
    assert.equal(reused.sha256, hash)
    assert.equal(reused.retrievedAt, snapshot.retrievedAt)
    assert.equal(reused.reusedFrom, resultPath)
    await assert.rejects(() => store.get("https://example.org/old.pdf", "pdf"), /Prior source unavailable: HTTP 404/)
    await assert.rejects(() => store.get("https://example.org/missing.pdf", "pdf"), /missing from reused/)
    await assert.rejects(() => sourceStore(dir, { ...hospital, id: "SYN-2" }, resultPath), /different hospital/)
    await writeFile(pdf, "%PDF-1.7 modified")
    await assert.rejects(() => store.get(snapshot.sourceUrl, "pdf"), /integrity verification/)
  } finally { await rm(dir, { recursive: true, force: true }) }
})
