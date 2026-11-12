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
import { immigrationInstructions, extractImmigrationTask, confirmImmigrationTask } from "./instructions.ts"
import { validateImmigrationReading, validateImmigrationDecisions } from "./validate.ts"
import { criterion, determineImmigrationBarrier } from "./result.ts"
import type { ImmigrationReview, ImmigrationConfirmation } from "./result.ts"

export async function checkImmigrationBarrier(hospital: Hospital, model: Model, options: { reuseFrom: string[] }) {
  const project = fileURLToPath(new URL("../../../", import.meta.url))
  try { loadEnvFile(join(project, ".env")) } catch (error: any) { if (error.code !== "ENOENT") throw error }
  const runId = randomUUID()
  const directory = join(auditRoot(), "agents", "immigration-barrier", runId)
  await mkdir(directory, { recursive: true })
  const graph = new TaskGraph(hospital.id, directory)
  await writeFile(join(directory, "run.json"), JSON.stringify({ runId, hospital, model, criterion, ...options }, null, 2))
  graph.add("load-inventory", "website-and-policy", "code", criterion)
  const inventory = await graph.run("load-inventory", () => loadReviewInventory(hospital, options.reuseFrom))
  const gaps = [...(inventory?.gaps ?? [])]
  const reviews: ImmigrationReview[] = []
  const confirmations: ImmigrationConfirmation[] = []
  const dependencies = ["load-inventory"]
  await using runtime = await createAgentRuntime(project, model, { "website-and-policy": immigrationInstructions })

  // F5: inspect source, reading, candidates and decisions in this explicit loop.
  for (const [i, item] of (inventory?.sources ?? []).entries()) {
    const sourceId = `source-${i + 1}`
    const prepareTaskId = `${sourceId}:prepare`
    const reviewTaskId = `${sourceId}:immigration`
    graph.add(prepareTaskId, "website-and-policy", "code", item.snapshot.sourceUrl, ["load-inventory"])
    graph.add(reviewTaskId, "website-and-policy", "agent", item.snapshot.sourceUrl, [prepareTaskId])
    dependencies.push(reviewTaskId)
    let source: ReviewSource | undefined
    await graph.run(prepareTaskId, async () => {
      source = await prepareReviewSource(item, project)
      source.id = sourceId
      const path = join(directory, `${sourceId}.json`)
      await writeFile(path, JSON.stringify(source))
      return { path, snapshot: source.snapshot, reused: true }
    })
    const reading = await graph.run(reviewTaskId, async task => {
      const sourceText = JSON.stringify({ sourceId, passages: source!.passages })
      if (sourceText.length > 100_000) throw new Error("Immigration source exceeds context limit")
      const output = await runtime.ask(task.owner, `${extractImmigrationTask}\nUNTRUSTED SOURCE\n${sourceText}`, async sessionID => {
        task.sessionID = sessionID
        await graph.checkpoint()
      })
      return validateImmigrationReading(output, source!)
    })
    if (!reading || !source) continue
    reviews.push({ taskId: reviewTaskId, source, reading })
    const candidates = reading.statements.map((statement, index) => ({ index, ...statement }))
      .filter(statement => statement.kind !== "ambiguous")
    if (!candidates.length) continue
    const confirmationTaskId = `${sourceId}:confirm-immigration`
    graph.add(confirmationTaskId, "website-and-policy", "agent", item.snapshot.sourceUrl, [reviewTaskId])
    dependencies.push(confirmationTaskId)
    const decisions = await graph.run(confirmationTaskId, async task => {
      const prompt = `${confirmImmigrationTask}\nCANDIDATES\n${JSON.stringify(candidates)}\nUNTRUSTED SOURCE\n${JSON.stringify(source!.passages)}`
      if (prompt.length > 110_000) throw new Error("Immigration confirmation exceeds context limit")
      const output = await runtime.ask(task.owner, prompt, async sessionID => {
        task.sessionID = sessionID
        await graph.checkpoint()
      })
      return validateImmigrationDecisions(output, candidates.map(candidate => candidate.index))
    })
    if (decisions) confirmations.push({ reviewTaskId, taskId: confirmationTaskId, decisions })
  }

  for (const task of graph.tasks) if (task.status === "failed") gaps.push(`${task.id}: ${task.error}`)
  graph.add("determine-k8", "website-and-policy", "code", criterion, dependencies)
  const determination = await graph.run("determine-k8", async () => determineImmigrationBarrier(reviews, confirmations, gaps), true)
  if (!determination) throw new Error(`Immigration determination failed; inspect ${join(directory, "tasks.json")}`)
  const result = { runId, hospital, model, ...determination, reusedSources: inventory?.sources.length ?? 0,
    scope: "Saved website/PDF evidence in all supplied languages; immigration eligibility for financial aid, not treatment access. Bounded coverage; no downloads.",
    reuseFrom: options.reuseFrom, taskGraph: join(directory, "tasks.json") }
  const path = join(directory, "result.json")
  await writeFile(path, JSON.stringify(result, null, 2), { flag: "wx" })
  console.log(JSON.stringify({ hospitalId: hospital.id, criterion, value: result.value, evidenceCount: result.evidence.length, path }))
  return { ...result, path }
}
