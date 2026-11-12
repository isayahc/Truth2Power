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
import type { ReviewSource } from "../../shared/review-sources.ts"
import { fplInstructions, extractFplTask } from "./instructions.ts"
import { validateFplReading } from "./validate.ts"
import { loadFplReference } from "./reference.ts"
import { criterion, determineFplGuidelines } from "./result.ts"
import type { FplReview } from "./result.ts"

export async function checkFplGuidelines(hospital: Hospital, model: Model, options: { reuseFrom: string[]; assessmentYear?: number }) {
  const project = fileURLToPath(new URL("../../../", import.meta.url))
  try { loadEnvFile(join(project, ".env")) } catch (error: any) { if (error.code !== "ENOENT") throw error }
  const assessmentYear = options.assessmentYear ?? new Date().getUTCFullYear()
  const runId = randomUUID()
  const directory = join(auditRoot(), "agents", "fpl-guidelines", runId)
  await mkdir(directory, { recursive: true })
  const graph = new TaskGraph(hospital.id, directory)
  const owner = "application-financialterms"
  await writeFile(join(directory, "run.json"), JSON.stringify({ runId, hospital, model, criterion, ...options, assessmentYear }, null, 2))
  graph.add("load-inventory", owner, "code", criterion)
  graph.add("load-reference", owner, "code", String(assessmentYear))
  const inventory = await graph.run("load-inventory", () => loadReviewInventory(hospital, options.reuseFrom))
  const reference = await graph.run("load-reference", () => loadFplReference(project, assessmentYear))
  const applications = (inventory?.sources ?? []).filter(item => item.roles.includes("application"))
  const gaps = [...(inventory?.gaps ?? [])]
  const reviews: FplReview[] = []
  const dependencies = ["load-inventory", "load-reference"]
  // No paid work when reference loading fails; one extraction per application, no retries.
  if (reference && applications.length) {
    await using runtime = await createAgentRuntime(project, model, { [owner]: fplInstructions })
    for (const [i, item] of applications.entries()) {
      const sourceId = `application-${i + 1}`
      const prepareId = `${sourceId}:prepare`
      const readId = `${sourceId}:fpl`
      graph.add(prepareId, owner, "code", item.snapshot.sourceUrl, ["load-inventory"])
      graph.add(readId, owner, "agent", item.snapshot.sourceUrl, [prepareId, "load-reference"])
      dependencies.push(readId)
      let source: ReviewSource | undefined
      await graph.run(prepareId, async () => {
        source = await prepareReviewSource(item, project)
        const path = join(directory, `${sourceId}.json`)
        await writeFile(path, JSON.stringify(source))
        return { path, snapshot: source.snapshot, reused: true }
      })
      const reading = await graph.run(readId, async task => {
        const prompt = `${extractFplTask}\nUNTRUSTED APPLICATION\n${JSON.stringify(source!.passages)}`
        if (prompt.length > 100_000) throw new Error("FPL source exceeds context limit")
        const output = await runtime.ask(task.owner, prompt, async sessionID => { task.sessionID = sessionID; await graph.checkpoint() })
        return validateFplReading(output, source!)
      })
      if (reading && source) reviews.push({ taskId: readId, source, reading })
    }
  }
  for (const task of graph.tasks) if (task.status === "failed") gaps.push(`${task.id}: ${task.error}`)
  graph.add("determine-k12", owner, "code", criterion, dependencies)
  const determination = await graph.run("determine-k12", async () => determineFplGuidelines(reviews, applications.map(a => a.snapshot.sha256), reference, gaps), true)
  if (!determination) throw new Error(`FPL determination failed; inspect ${join(directory, "tasks.json")}`)
  const result = { runId, hospital, model, assessmentYear, ...determination, reusedSources: applications.length,
    languageScope: ["en", "es"], reuseFrom: options.reuseFrom, taskGraph: join(directory, "tasks.json") }
  const path = join(directory, "result.json")
  await writeFile(path, JSON.stringify(result, null, 2), { flag: "wx" })
  console.log(JSON.stringify({ hospitalId: hospital.id, criterion, value: result.value, evidenceCount: result.evidence.length, path }))
  return { ...result, path }
}
