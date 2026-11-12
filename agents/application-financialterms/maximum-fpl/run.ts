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
import { maximumInstructions, extractMaximumTask } from "./instructions.ts"
import { validateMaximumReading } from "./validate.ts"
import { criterion, determineMaximumFpl } from "./result.ts"
import type { MaximumReview } from "./result.ts"

export async function checkMaximumFpl(hospital: Hospital, model: Model, options: { reuseFrom: string[] }) {
  const project = fileURLToPath(new URL("../../../", import.meta.url))
  try { loadEnvFile(join(project, ".env")) } catch (error: any) { if (error.code !== "ENOENT") throw error }
  const runId = randomUUID()
  const directory = join(project, ".audit", "agents", "maximum-fpl", runId)
  await mkdir(directory, { recursive: true })
  const graph = new TaskGraph(hospital.id, directory)
  const owner = "application-financialterms"
  await writeFile(join(directory, "run.json"), JSON.stringify({ runId, hospital, model, criterion, ...options }, null, 2))
  graph.add("load-inventory", owner, "code", criterion)
  const inventory = await graph.run("load-inventory", () => loadReviewInventory(hospital, options.reuseFrom))
  const applications = (inventory?.sources ?? []).filter(item => item.roles.includes("application"))
  const gaps = [...(inventory?.gaps ?? [])]
  const reviews: MaximumReview[] = []
  const dependencies = ["load-inventory"]
  await using runtime = await createAgentRuntime(project, model, { [owner]: maximumInstructions })
  // One paid reading per application. Inspect source and reading here in F5.
  for (const [i, item] of applications.entries()) {
    const sourceId = `application-${i + 1}`
    const prepareId = `${sourceId}:prepare`
    const readId = `${sourceId}:eligibility`
    graph.add(prepareId, owner, "code", item.snapshot.sourceUrl, ["load-inventory"])
    graph.add(readId, owner, "agent", item.snapshot.sourceUrl, [prepareId])
    dependencies.push(readId)
    let source: ReviewSource | undefined
    await graph.run(prepareId, async () => {
      source = await prepareReviewSource(item, project)
      const path = join(directory, `${sourceId}.json`)
      await writeFile(path, JSON.stringify(source))
      return { path, snapshot: source.snapshot, reused: true }
    })
    const reading = await graph.run(readId, async task => {
      const prompt = `${extractMaximumTask}\nUNTRUSTED APPLICATION\n${JSON.stringify(source!.passages)}`
      if (prompt.length > 100_000) throw new Error("Eligibility source exceeds context limit")
      const output = await runtime.ask(task.owner, prompt, async sessionID => { task.sessionID = sessionID; await graph.checkpoint() })
      return validateMaximumReading(output, source!)
    })
    if (reading && source) reviews.push({ taskId: readId, source, reading })
  }
  for (const task of graph.tasks) if (task.status === "failed") gaps.push(`${task.id}: ${task.error}`)
  graph.add("determine-k13", owner, "code", criterion, dependencies)
  const determination = await graph.run("determine-k13", async () => determineMaximumFpl(reviews, applications.map(a => a.snapshot.sha256), gaps), true)
  if (!determination) throw new Error(`Eligibility determination failed; inspect ${join(directory, "tasks.json")}`)
  const result = { runId, hospital, model, ...determination, reusedSources: applications.length,
    languageScope: ["en", "es"], reuseFrom: options.reuseFrom, taskGraph: join(directory, "tasks.json") }
  const path = join(directory, "result.json")
  await writeFile(path, JSON.stringify(result, null, 2), { flag: "wx" })
  console.log(JSON.stringify({ hospitalId: hospital.id, criterion, value: result.value, evidenceCount: result.evidence.length, path }))
  return { ...result, path }
}
