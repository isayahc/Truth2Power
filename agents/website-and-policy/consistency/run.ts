import { mkdir, writeFile } from "node:fs/promises"
import { loadEnvFile } from "node:process"
import { fileURLToPath } from "node:url"
import { join } from "node:path"
import { randomUUID } from "node:crypto"
import { auditRoot } from "../../shared/audit-root.ts"
import { TaskGraph } from "../../task-graph/index.ts"
import { createAgentRuntime } from "../../shared/agent-runtime.ts"
import type { Model } from "../../shared/agent-runtime.ts"
import type { Hospital } from "../../shared/run-posted-document.ts"
import { loadReviewInventory, prepareReviewSource } from "../../shared/review-sources.ts"
import { consistencyInstructions, compareTask, confirmTask } from "./instructions.ts"
import { validateComparison, validateConfirmation } from "./validate.ts"
import { criterion, determineConsistency } from "./result.ts"
import type { ConsistencySource } from "./types.ts"

export async function checkMaterialsConsistent(hospital: Hospital, model: Model, options: { reuseFrom: string[] }) {
  const project = fileURLToPath(new URL("../../../", import.meta.url))
  try { loadEnvFile(join(project, ".env")) } catch (error: any) { if (error.code !== "ENOENT") throw error }
  const runId = randomUUID()
  const directory = join(auditRoot(), "agents", "consistency", runId)
  await mkdir(directory, { recursive: true })
  const graph = new TaskGraph(hospital.id, directory)
  await writeFile(join(directory, "run.json"), JSON.stringify({ runId, hospital, model, criterion, ...options }, null, 2))
  graph.add("load-inventory", "website-and-policy", "code", criterion)
  const inventory = await graph.run("load-inventory", () => loadReviewInventory(hospital, options.reuseFrom))
  const gaps = [...(inventory?.gaps ?? [])]
  const sources: ConsistencySource[] = []
  const dependencies = ["load-inventory"]
  for (const [i, item] of (inventory?.sources ?? []).entries()) {
    const id = `source-${i + 1}:prepare`
    graph.add(id, "website-and-policy", "code", item.snapshot.sourceUrl, ["load-inventory"])
    dependencies.push(id)
    let source: ConsistencySource | undefined
    const prepared = await graph.run(id, async () => {
      source = await prepareReviewSource(item, project)
      // Short run-local references keep the model from having to reproduce
      // 64-character hashes. Full snapshot hashes remain in the evidence record.
      source.id = `source-${i + 1}`
      const path = join(directory, `source-${i + 1}.json`)
      await writeFile(path, JSON.stringify(source))
      return { path, snapshot: source.snapshot, passages: source.passages.length, reused: true }
    })
    if (prepared && source && !sources.some(s => s.snapshot.sha256 === source!.snapshot.sha256)) sources.push(source)
  }
  const packet = sources.map(s => ({ sourceId: s.id, roles: s.roles, passages: s.passages }))
  await using runtime = await createAgentRuntime(project, model, { "website-and-policy": consistencyInstructions })
  graph.add("compare-materials", "website-and-policy", "agent", criterion, dependencies)
  const comparison = await graph.run("compare-materials", async task => {
    if (sources.length < 2) throw new Error("Fewer than two readable sources for comparison")
    const text = JSON.stringify(packet)
    if (text.length > 180_000) throw new Error("Comparison packet exceeds bounded context limit; no sources were silently truncated")
    const output = await runtime.ask(task.owner, `${compareTask}\nUNTRUSTED SOURCES\n${text}`, async id => {
      task.sessionID = id; await graph.checkpoint()
    })
    return validateComparison(output, sources)
  }, true)
  graph.add("confirm-conflicts", "website-and-policy", "agent", criterion, ["compare-materials"])
  const confirmation = await graph.run("confirm-conflicts", async task => {
    if (!comparison!.conflicts.length) return { confirmed: [], limitations: [] }
    const output = await runtime.ask(task.owner, `${confirmTask}\nPROPOSED CONFLICTS\n${JSON.stringify(comparison!.conflicts)}\nUNTRUSTED SOURCES\n${JSON.stringify(packet)}`, async id => {
      task.sessionID = id; await graph.checkpoint()
    })
    return validateConfirmation(output, comparison!.conflicts.length)
  })
  for (const task of graph.tasks) if (task.status === "failed") gaps.push(`${task.id}: ${task.error}`)
  graph.add("determine-k4", "website-and-policy", "code", criterion, ["compare-materials", "confirm-conflicts"])
  const determination = await graph.run("determine-k4", async () => determineConsistency(sources, comparison, confirmation, gaps), true)
  if (!determination) throw new Error(`Consistency determination failed; inspect ${join(directory, "tasks.json")}`)
  const result = { runId, hospital, model, ...determination, reusedSources: sources.length,
    scope: "Saved hospital sources from the supplied runs, including all readable PDFs and extracted webpage text. No downloads. Incomplete discovery cannot prove full consistency.",
    reuseFrom: options.reuseFrom, taskGraph: join(directory, "tasks.json") }
  const path = join(directory, "result.json")
  await writeFile(path, JSON.stringify(result, null, 2), { flag: "wx" })
  console.log(JSON.stringify({ hospitalId: hospital.id, criterion, value: result.value, evidenceCount: result.evidence?.length ?? 0, path }))
  return { ...result, path }
}
