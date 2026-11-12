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
import { loadUniformReference } from "./reference.ts"
import { uniformInstructions, compareUniformTask } from "./instructions.ts"
import { validateUniformReading } from "./validate.ts"
import { criterion, determineUniformApplication } from "./result.ts"
import type { UniformReview } from "./result.ts"

export async function checkUniformApplication(hospital: Hospital, model: Model, options: { reuseFrom: string[] }) {
  const project = fileURLToPath(new URL("../../../", import.meta.url))
  try { loadEnvFile(join(project, ".env")) } catch (error: any) { if (error.code !== "ENOENT") throw error }
  const runId = randomUUID()
  const directory = join(project, ".audit", "agents", "uniform-application", runId)
  await mkdir(directory, { recursive: true })
  const graph = new TaskGraph(hospital.id, directory)
  const owner = "application-financialterms"
  await writeFile(join(directory, "run.json"), JSON.stringify({ runId, hospital, model, criterion, ...options }, null, 2))
  graph.add("load-inventory", owner, "code", criterion)
  graph.add("load-reference", owner, "code", "NYS-2026-English source and derived render")
  const inventory = await graph.run("load-inventory", () => loadReviewInventory(hospital, options.reuseFrom))
  const reference = await graph.run("load-reference", () => loadUniformReference(project))
  const gaps = [...(inventory?.gaps ?? [])]
  const applications = (inventory?.sources ?? []).filter(item => item.roles.includes("application"))
  if (!applications.length) gaps.push("No source-verified application was available for comparison.")
  const reviews: UniformReview[] = []
  const dependencies = ["load-inventory", "load-reference"]
  if (reference && applications.length) {
    await writeFile(join(directory, "reference.json"), JSON.stringify(reference, null, 2))
    await using runtime = await createAgentRuntime(project, model, { [owner]: uniformInstructions })
    // F5: inspect the complete application, reference and reading in this loop.
    for (const [i, item] of applications.entries()) {
      const sourceId = `application-${i + 1}`
      const prepareId = `${sourceId}:prepare`
      const compareId = `${sourceId}:compare`
      graph.add(prepareId, owner, "code", item.snapshot.sourceUrl, ["load-inventory"])
      graph.add(compareId, owner, "agent", item.snapshot.sourceUrl, [prepareId, "load-reference"])
      dependencies.push(compareId)
      let source: ReviewSource | undefined
      await graph.run(prepareId, async () => {
        source = await prepareReviewSource(item, project)
        source.id = sourceId
        const path = join(directory, `${sourceId}.json`)
        await writeFile(path, JSON.stringify(source))
        return { path, snapshot: source.snapshot, reused: true }
      })
      const reading = await graph.run(compareId, async task => {
        const prompt = `${compareUniformTask}\nUNTRUSTED APPLICATION\n${JSON.stringify(source!.passages)}\nUNTRUSTED REFERENCE\n${JSON.stringify(reference.passages)}`
        if (prompt.length > 100_000) throw new Error("Uniform comparison exceeds context limit")
        const output = await runtime.ask(task.owner, prompt, async sessionID => {
          task.sessionID = sessionID
          await graph.checkpoint()
        })
        return validateUniformReading(output, source!, reference)
      })
      if (reading && source) reviews.push({ taskId: compareId, source, reading })
    }
  }
  for (const task of graph.tasks) if (task.status === "failed") gaps.push(`${task.id}: ${task.error}`)
  graph.add("determine-k9", owner, "code", criterion, dependencies)
  const determination = await graph.run("determine-k9", async () => determineUniformApplication(reviews, reference, gaps), true)
  if (!determination) throw new Error(`Uniform determination failed; inspect ${join(directory, "tasks.json")}`)
  const result = { runId, hospital, model, ...determination, reusedSources: applications.length,
    scope: "Source-verified application PDFs compared to a pinned derived English reference render. No downloads; text review only.",
    reuseFrom: options.reuseFrom, taskGraph: join(directory, "tasks.json") }
  const path = join(directory, "result.json")
  await writeFile(path, JSON.stringify(result, null, 2), { flag: "wx" })
  console.log(JSON.stringify({ hospitalId: hospital.id, criterion, value: result.value, evidenceCount: result.evidence.length, path }))
  return { ...result, path }
}
