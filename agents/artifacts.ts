import { readdir, readFile, stat } from "node:fs/promises"
import { createHash } from "node:crypto"
import { join } from "node:path"
import type { Hospital } from "./shared/run-posted-document.ts"
import type { Step } from "./steps.ts"

export type Artifact = { path: string; retrievedAt: string[] }

// Also discovers criterion runs made before the CLI existed. Broken or unrelated
// artifacts are ignored, never mistaken for usable prerequisite inventories.
export async function findArtifact(root: string, hospital: Hospital, step: Step): Promise<Artifact | undefined> {
  const directory = join(root, "agents", step.key)
  let entries
  try { entries = await readdir(directory, { withFileTypes: true }) }
  catch (error: any) { if (error.code === "ENOENT") return; throw error }
  const candidates: { path: string; time: number }[] = []
  for (const entry of entries.filter(e => e.isDirectory())) {
    const path = join(directory, entry.name, "result.json")
    try { candidates.push({ path, time: (await stat(path)).mtimeMs }) } catch { /* unfinished run */ }
  }
  for (const candidate of candidates.sort((a, b) => b.time - a.time)) {
    try {
      const result = JSON.parse(await readFile(candidate.path, "utf8"))
      if (result.hospital?.id !== hospital.id || result.hospital?.financialAssistanceUrl !== hospital.financialAssistanceUrl
          || result.criterion !== step.criterion || ![true, false, null].includes(result.value)) continue
      const graph = JSON.parse(await readFile(result.taskGraph, "utf8"))
      if (graph.hospitalId !== hospital.id || !Array.isArray(graph.tasks)) continue
      const snapshots = graph.tasks.filter((t: any) => t.status === "succeeded"
        && (t.id === "fetch-page" || t.id.endsWith(":download"))).map((t: any) => t.result)
      snapshots.push(...(result.websiteSearch?.pages ?? []))
      if (!snapshots.length) continue
      const dates = new Set<string>()
      for (const s of snapshots) {
        const bytes = await readFile(s.path)
        if (!["html", "pdf"].includes(s.kind) || s.snapshot_id !== s.sha256 || bytes.length !== s.bytes
            || createHash("sha256").update(bytes).digest("hex") !== s.sha256
            || !Number.isFinite(Date.parse(s.retrievedAt))
            || (s.kind === "pdf" && bytes.subarray(0, 5).toString() !== "%PDF-")) throw new Error("Invalid snapshot")
        dates.add(s.retrievedAt)
      }
      return { path: candidate.path, retrievedAt: [...dates].sort() }
    } catch { /* Try the next completed, intact inventory. */ }
  }
}
