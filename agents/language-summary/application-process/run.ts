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
import { processInstructions, extractProcessTask } from "./instructions.ts"
import { validateProcessReading } from "./validate.ts"
import { criterion, determineApplicationProcess } from "./result.ts"
import type { ProcessReview } from "./result.ts"
import { saveSource } from "../../shared/snapshots.ts"
import { outsideLanguageScope } from "../../shared/language-scope.ts"

export async function checkSummaryApplicationProcess(hospital: Hospital, model: Model, options: { reuseFrom: string[] }) {
  const project = fileURLToPath(new URL("../../../", import.meta.url))
  try { loadEnvFile(join(project, ".env")) } catch (error: any) { if (error.code !== "ENOENT") throw error }
  const runId = randomUUID()
  const directory = join(project, ".audit", "agents", "summary-application-process", runId)
  await mkdir(directory, { recursive: true })
  const graph = new TaskGraph(hospital.id, directory)
  const owner = "language-summary"
  await writeFile(join(directory, "run.json"), JSON.stringify({ runId, hospital, model, criterion, ...options }, null, 2))
  graph.add("load-inventory", owner, "code", criterion)
  const inventory = await graph.run("load-inventory", () => loadReviewInventory(hospital, options.reuseFrom))
  const summaries = (inventory?.sources ?? []).filter(item => item.roles.includes("policy_summary"))
  const gaps = [...(inventory?.gaps ?? [])]
  const reviews: ProcessReview[] = []
  graph.add("fetch-website", owner, "code", hospital.financialAssistanceUrl)
  const websiteSnapshot = await graph.run("fetch-website", async () => {
    if (outsideLanguageScope(hospital.financialAssistanceUrl)) throw new Error("Website excluded by English/Spanish scope")
    const snapshot = await saveSource(directory, hospital.financialAssistanceUrl, "html")
    if (new URL(snapshot.finalUrl).origin !== new URL(hospital.financialAssistanceUrl).origin
        || outsideLanguageScope(snapshot.finalUrl)) throw new Error("Website redirected outside hospital/language scope")
    return snapshot
  })
  const websiteSources = websiteSnapshot ? [{ snapshot: websiteSnapshot, roles: ["landing_page"] }] : []
  const sources = [...summaries, ...websiteSources]
  const dependencies = ["load-inventory", "fetch-website"]
  await using runtime = await createAgentRuntime(project, model, { [owner]: processInstructions })
  // F5: source -> reading.instructions -> per-summary submission routes.
  for (const [i, item] of sources.entries()) {
    const isWebsite = item.roles.includes("landing_page")
    const sourceId = isWebsite ? "website-1" : `summary-${i + 1}`
    const prepareId = `${sourceId}:prepare`
    const readId = `${sourceId}:process`
    graph.add(prepareId, owner, "code", item.snapshot.sourceUrl, [isWebsite ? "fetch-website" : "load-inventory"])
    graph.add(readId, owner, "agent", item.snapshot.sourceUrl, [prepareId])
    dependencies.push(readId)
    let source: ReviewSource | undefined
    await graph.run(prepareId, async () => {
      source = await prepareReviewSource(item, project)
      const path = join(directory, `${sourceId}.json`)
      await writeFile(path, JSON.stringify(source))
      return { path, snapshot: source.snapshot, reused: !isWebsite }
    })
    const reading = await graph.run(readId, async task => {
      const prompt = `${extractProcessTask}\nSource type: ${isWebsite ? "hospital webpage" : "designated summary"}\nUNTRUSTED SOURCE\n${JSON.stringify(source!.passages)}`
      if (prompt.length > 100_000) throw new Error("Summary process source exceeds context limit")
      const output = await runtime.ask(task.owner, prompt, async sessionID => { task.sessionID = sessionID; await graph.checkpoint() })
      return validateProcessReading(output, source!)
    })
    if (reading && source) reviews.push({ taskId: readId, source, reading })
  }
  for (const task of graph.tasks) if (task.status === "failed") gaps.push(`${task.id}: ${task.error}`)
  graph.add("determine-k16", owner, "code", criterion, dependencies)
  const determination = await graph.run("determine-k16", async () => determineApplicationProcess(reviews, summaries.map(s => s.snapshot.sha256), gaps, websiteSources), true)
  if (!determination) throw new Error(`Summary process determination failed; inspect ${join(directory, "tasks.json")}`)
  const result = { runId, hospital, model, ...determination, reusedSources: summaries.length,
    websiteSearch: { pages: websiteSnapshot ? [websiteSnapshot] : [], scope: "Live financial-assistance landing page only; linked pages are not exhaustively reviewed." },
    languageScope: ["en", "es"], reuseFrom: options.reuseFrom, taskGraph: join(directory, "tasks.json") }
  const path = join(directory, "result.json")
  await writeFile(path, JSON.stringify(result, null, 2), { flag: "wx" })
  console.log(JSON.stringify({ hospitalId: hospital.id, criterion, value: result.value, evidenceCount: result.evidence.length, path }))
  return { ...result, path }
}
