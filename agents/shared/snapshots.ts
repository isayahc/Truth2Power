import { createHash } from "node:crypto"
import { readFile, writeFile } from "node:fs/promises"
import { join } from "node:path"
import { fetchPublicSource } from "./http.ts"

export async function saveSource(directory: string, sourceUrl: string, kind: "html" | "pdf") {
  const source = await fetchPublicSource(sourceUrl, kind === "html" ? 2 * 1024 * 1024 : 25 * 1024 * 1024)
  if (kind === "html" && !source.contentType.includes("text/html")) throw new Error("Expected an HTML landing page")
  if (kind === "pdf" && source.bytes.subarray(0, 5).toString("ascii") !== "%PDF-") throw new Error("Response is not PDF content")
  const sha256 = createHash("sha256").update(source.bytes).digest("hex")
  const path = join(directory, `${sha256}.${kind}`)
  await writeFile(path, source.bytes)
  if (createHash("sha256").update(await readFile(path)).digest("hex") !== sha256) throw new Error("Saved source hash mismatch")
  return { snapshot_id: sha256, sha256, sourceUrl, finalUrl: source.url,
    retrievedAt: source.retrievedAt, httpStatus: source.status, bytes: source.bytes.length, path, kind }
}

export type Snapshot = Awaited<ReturnType<typeof saveSource>>
