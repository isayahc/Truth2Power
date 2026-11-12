import { readFile } from "node:fs/promises"
import { auditAgents } from "../registry.ts"
import type { AuditAgent } from "../registry.ts"
import type { Measure } from "./types.ts"

export async function loadAgentCriteria() {
  const rubric = JSON.parse(await readFile(new URL("../../rubrics/css-17-v1.json", import.meta.url), "utf8"))
  const measures = rubric.measures as Measure[]
  const assigned = new Set<string>()
  const groups = {} as Record<AuditAgent, Measure[]>
  for (const [id, group] of Object.entries(auditAgents)) {
    const selected = measures.filter(measure => measure.measure_id.startsWith(group.prefix))
    if (selected.length !== group.count) throw new Error(`Unexpected rubric coverage for ${id}`)
    for (const measure of selected) {
      if (assigned.has(measure.measure_id)) throw new Error(`Duplicate measure: ${measure.measure_id}`)
      assigned.add(measure.measure_id)
    }
    groups[id as AuditAgent] = selected
  }
  if (assigned.size !== measures.length) throw new Error("Rubric has unassigned measures")
  return { rubricVersion: rubric.version as string, referenceVersion: rubric.reference_version as string, groups }
}
