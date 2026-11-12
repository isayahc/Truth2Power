import { mkdir, writeFile } from "node:fs/promises"
import { loadEnvFile } from "node:process"
import { fileURLToPath } from "node:url"
import { join } from "node:path"
import { randomUUID } from "node:crypto"
import { TaskGraph } from "../../task-graph/index.ts"
import { createAgentRuntime } from "../../shared/agent-runtime.ts"
import type { Model } from "../../shared/agent-runtime.ts"
import type { Hospital } from "../../shared/run-posted-document.ts"
import { loadReviewInventory, prepareReviewSource } from "../../shared/review-sources.ts"
import type { ReviewSource } from "../../shared/review-sources.ts"
import { serviceAreaInstructions } from "./instructions.ts"
import { validateServiceArea } from "./validate.ts"
import { loadServiceAreaReference } from "./reference.ts"
import { criterion, determineServiceArea } from "./result.ts"
import type { GeographicReading } from "./result.ts"

export async function checkServiceArea(hospital: Hospital, model: Model,
  options: { reuseFrom: string[]; reviewDate: string; referencePath?: string }) {
  const project = fileURLToPath(new URL("../../../", import.meta.url))
  try { loadEnvFile(join(project, ".env")) } catch (error: any) { if (error.code !== "ENOENT") throw error }
  const runId = randomUUID()
  const directory = join(project, ".audit", "agents", "service-area", runId)
  await mkdir(directory, { recursive: true })
  const graph = new TaskGraph(hospital.id, directory)
  await writeFile(join(directory, "run.json"), JSON.stringify({ runId, hospital, model, criterion, ...options }, null, 2))
  graph.add("load-inventory", "website-and-policy", "code", criterion)
  graph.add("resolve-authority", "website-and-policy", "code", options.referencePath ?? "Missing facility-specific service-area reference")
  const inventory = await graph.run("load-inventory", () => loadReviewInventory(hospital, options.reuseFrom))
  const reference = await graph.run("resolve-authority", () => loadServiceAreaReference(hospital, options.reviewDate, project, options.referencePath))
  const gaps = [...(inventory?.gaps ?? [])]
  const readings: GeographicReading[] = []
  const dependencies = ["load-inventory", "resolve-authority"]
  await using runtime = await createAgentRuntime(project, model, { "website-and-policy": serviceAreaInstructions })
  for (const [i, item] of (inventory?.sources ?? []).entries()) {
    const id = `source-${i + 1}`
    graph.add(`${id}:prepare`, "website-and-policy", "code", item.snapshot.sourceUrl, ["load-inventory"])
    graph.add(`${id}:geography`, "website-and-policy", "agent", item.snapshot.sourceUrl, [`${id}:prepare`])
    dependencies.push(`${id}:geography`)
    let source: ReviewSource | undefined
    await graph.run(`${id}:prepare`, async () => {
      source = await prepareReviewSource(item, project)
      source.id = id
      const path = join(directory, `${id}.json`)
      await writeFile(path, JSON.stringify(source))
      return { path, snapshot: source.snapshot, reused: true }
    })
    const reading = await graph.run(`${id}:geography`, async task => {
      const text = JSON.stringify({ sourceId: id, passages: source!.passages })
      if (text.length > 100_000) throw new Error("Geographic evidence exceeds context limit")
      const output = await runtime.ask(task.owner, text, async id => { task.sessionID = id; await graph.checkpoint() })
      return validateServiceArea(output, source!)
    })
    if (reading && source) readings.push({ taskId: `${id}:geography`, source, reading })
  }
  for (const task of graph.tasks) if (task.status === "failed") gaps.push(`${task.id}: ${task.error}`)
  graph.add("determine-k5", "website-and-policy", "code", criterion, dependencies)
  const determination = await graph.run("determine-k5", async () => determineServiceArea(readings, reference, gaps), true)
  if (!determination) throw new Error(`Service-area determination failed; inspect ${join(directory, "tasks.json")}`)
  const result = { runId, hospital, model, reviewDate: options.reviewDate, ...determination,
    scope: "Saved hospital sources; geographic observations are not an approved boundary-compliance finding. No downloads.",
    reuseFrom: options.reuseFrom, taskGraph: join(directory, "tasks.json") }
  const path = join(directory, "result.json")
  await writeFile(path, JSON.stringify(result, null, 2), { flag: "wx" })
  console.log(JSON.stringify({ hospitalId: hospital.id, criterion, value: result.value, evidenceCount: result.evidence.length, path }))
  return { ...result, path }
}
