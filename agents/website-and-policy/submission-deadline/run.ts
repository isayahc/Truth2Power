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
import { deadlineInstructions, extractDeadlineTask, confirmDeadlineTask } from "./instructions.ts"
import { validateDeadline, validateDeadlineConfirmation } from "./validate.ts"
import { criterion, determineSubmissionDeadline } from "./result.ts"
import type { TimingReview, ConfirmedTiming } from "./result.ts"

export async function checkSubmissionDeadline(hospital: Hospital, model: Model, options: { reuseFrom: string[] }) {
  const project = fileURLToPath(new URL("../../../", import.meta.url))
  try { loadEnvFile(join(project, ".env")) } catch (error: any) { if (error.code !== "ENOENT") throw error }
  const runId = randomUUID()
  const directory = join(auditRoot(), "agents", "submission-deadline", runId)
  await mkdir(directory, { recursive: true })
  const graph = new TaskGraph(hospital.id, directory)
  await writeFile(join(directory, "run.json"), JSON.stringify({ runId, hospital, model, criterion, ...options }, null, 2))
  graph.add("load-inventory", "website-and-policy", "code", criterion)
  const inventory = await graph.run("load-inventory", () => loadReviewInventory(hospital, options.reuseFrom))
  const gaps = [...(inventory?.gaps ?? [])]
  const reviews: TimingReview[] = []
  const confirmations: ConfirmedTiming[] = []
  const dependencies = ["load-inventory"]
  await using runtime = await createAgentRuntime(project, model, { "website-and-policy": deadlineInstructions })
  for (const [i, item] of (inventory?.sources ?? []).entries()) {
    const id = `source-${i + 1}`
    graph.add(`${id}:prepare`, "website-and-policy", "code", item.snapshot.sourceUrl, ["load-inventory"])
    graph.add(`${id}:timing`, "website-and-policy", "agent", item.snapshot.sourceUrl, [`${id}:prepare`])
    dependencies.push(`${id}:timing`)
    let source: ReviewSource | undefined
    await graph.run(`${id}:prepare`, async () => {
      source = await prepareReviewSource(item, project)
      source.id = id
      const path = join(directory, `${id}.json`)
      await writeFile(path, JSON.stringify(source))
      return { path, snapshot: source.snapshot, reused: true }
    })
    const reading = await graph.run(`${id}:timing`, async task => {
      const text = JSON.stringify({ sourceId: id, passages: source!.passages })
      if (text.length > 100_000) throw new Error("Application-timing source exceeds context limit")
      const output = await runtime.ask(task.owner, `${extractDeadlineTask}\nUNTRUSTED SOURCE\n${text}`, async sessionID => {
        task.sessionID = sessionID; await graph.checkpoint()
      })
      return validateDeadline(output, source!)
    })
    if (!reading || !source) continue
    reviews.push({ taskId: `${id}:timing`, source, reading })
    for (const [statementIndex, statement] of reading.statements.entries()) {
      if (statement.kind !== "submission_deadline") continue
      const taskId = `${id}:confirm-${statementIndex + 1}`
      graph.add(taskId, "website-and-policy", "agent", item.snapshot.sourceUrl, [`${id}:timing`])
      dependencies.push(taskId)
      const confirmation = await graph.run(taskId, async task => {
        const output = await runtime.ask(task.owner, `${confirmDeadlineTask}\nCANDIDATE\n${JSON.stringify(statement)}\nUNTRUSTED SOURCE\n${JSON.stringify(source!.passages)}`, async sessionID => {
          task.sessionID = sessionID; await graph.checkpoint()
        })
        return validateDeadlineConfirmation(output)
      })
      if (confirmation) confirmations.push({ reviewTaskId: `${id}:timing`, statementIndex, taskId, result: confirmation })
    }
  }
  for (const task of graph.tasks) if (task.status === "failed") gaps.push(`${task.id}: ${task.error}`)
  graph.add("determine-k6", "website-and-policy", "code", criterion, dependencies)
  const determination = await graph.run("determine-k6", async () => determineSubmissionDeadline(reviews, confirmations, gaps), true)
  if (!determination) throw new Error(`Deadline determination failed; inspect ${join(directory, "tasks.json")}`)
  const result = { runId, hospital, model, ...determination, reusedSources: inventory?.sources.length ?? 0,
    scope: "Saved website/PDF evidence, all supplied languages; submission timing only, not appeals or processing. Bounded coverage remains unresolved; no downloads.",
    reuseFrom: options.reuseFrom, taskGraph: join(directory, "tasks.json") }
  const path = join(directory, "result.json")
  await writeFile(path, JSON.stringify(result, null, 2), { flag: "wx" })
  console.log(JSON.stringify({ hospitalId: hospital.id, criterion, value: result.value, evidenceCount: result.evidence.length, path }))
  return { ...result, path }
}
