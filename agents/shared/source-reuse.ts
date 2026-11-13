import { createHash } from "node:crypto"
import { readFile } from "node:fs/promises"
import type { Snapshot } from "./snapshots.ts"
import { saveSource } from "./snapshots.ts"

// Reuse a prior criterion's source inventory for the SAME hospital assessment.
// Do not silently refresh it: preserve its original retrieval timestamps.
export async function sourceStore(directory: string, hospital: { id: string; financialAssistanceUrl: string }, reuseFrom?: string, allowNewSources = false) {
  const snapshots = new Map<string, Snapshot>()
  const failures = new Map<string, string>()
  if (reuseFrom) {
    const result = JSON.parse(await readFile(reuseFrom, "utf8"))
    if (result.hospital?.id !== hospital.id || result.hospital?.financialAssistanceUrl !== hospital.financialAssistanceUrl) {
      throw new Error("Cannot reuse sources from a different hospital or landing page")
    }
    const graph = JSON.parse(await readFile(result.taskGraph, "utf8"))
    if (graph.hospitalId !== hospital.id || !Array.isArray(graph.tasks)) throw new Error("Invalid reused task graph")
    for (const task of graph.tasks) {
      if (task.id !== "fetch-page" && !task.id.endsWith(":download")) continue
      if (task.status === "succeeded" && task.result?.sourceUrl === task.item) snapshots.set(task.item, task.result)
      if (task.status === "failed") failures.set(task.item, task.error)
    }
  }
  return {
    async get(url: string, kind: "html" | "pdf") {
      const previous = snapshots.get(url)
      if (previous) {
        const bytes = await readFile(previous.path)
        if (previous.kind !== kind || createHash("sha256").update(bytes).digest("hex") !== previous.sha256
            || previous.snapshot_id !== previous.sha256 || bytes.length !== previous.bytes
            || (kind === "pdf" && bytes.subarray(0, 5).toString("ascii") !== "%PDF-")) {
          throw new Error("Reused source failed integrity verification")
        }
        return { ...previous, reusedFrom: reuseFrom! }
      }
      if (reuseFrom && (failures.has(url) || !allowNewSources)) {
        throw new Error(failures.has(url) ? `Prior source unavailable: ${failures.get(url)}` : "Source missing from reused assessment inventory")
      }
      return saveSource(directory, url, kind)
    },
  }
}
