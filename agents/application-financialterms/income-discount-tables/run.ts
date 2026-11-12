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
import { tableInstructions, extractTablesTask, confirmTablesTask } from "./instructions.ts"
import { validateTablesReading, validateTableDecisions } from "./validate.ts"
import type { TablesReading } from "./validate.ts"
import { criterion, determineIncomeDiscountTables } from "./result.ts"
import type { TablesReview } from "./result.ts"

export async function checkIncomeDiscountTables(hospital: Hospital, model: Model, options: { reuseFrom: string[] }) {
  const project = fileURLToPath(new URL("../../../", import.meta.url))
  try { loadEnvFile(join(project, ".env")) } catch (error: any) { if (error.code !== "ENOENT") throw error }
  const runId = randomUUID()
  const directory = join(project, ".audit", "agents", "income-discount-tables", runId)
  await mkdir(directory, { recursive: true })
  const graph = new TaskGraph(hospital.id, directory)
  const owner = "application-financialterms"
  await writeFile(join(directory, "run.json"), JSON.stringify({ runId, hospital, model, criterion, ...options }, null, 2))
  graph.add("load-inventory", owner, "code", criterion)
  const inventory = await graph.run("load-inventory", () => loadReviewInventory(hospital, options.reuseFrom))
  const gaps = [...(inventory?.gaps ?? [])]
  const applications = (inventory?.sources ?? []).filter(item => item.roles.includes("application"))
  const reviews: TablesReview[] = []
  const dependencies = ["load-inventory"]
  await using runtime = await createAgentRuntime(project, model, { [owner]: tableInstructions })
  // F5: source -> reading.tables -> decisions -> applications verdicts.
  const tableTasks = applications.flatMap((item, i) => ["income", "discount"].map(kind => ({ item, i, kind })))
  for (const { item, i, kind } of tableTasks) {
    const sourceId = `application-${i + 1}-${kind}`
    const prepareId = `${sourceId}:prepare`
    graph.add(prepareId, owner, "code", item.snapshot.sourceUrl, ["load-inventory"])
    let source: ReviewSource | undefined
    await graph.run(prepareId, async () => {
      source = await prepareReviewSource(item, project)
      source.id = sourceId
      const path = join(directory, `${sourceId}.json`)
      await writeFile(path, JSON.stringify(source))
      return { path, snapshot: source.snapshot, reused: true }
    })
    let reading: TablesReading | undefined
    let readingTaskId = `${sourceId}:tables`
    let validationError = ""
    for (let attempt = 0; attempt < 2; attempt++) {
      if (attempt === 1) {
        if (!source || !validationError) break
        readingTaskId = `${sourceId}:repair-tables`
      }
      graph.add(readingTaskId, owner, "agent", item.snapshot.sourceUrl, [prepareId])
      dependencies.push(readingTaskId)
      reading = await graph.run(readingTaskId, async task => {
        const feedback = validationError ? `\nPrevious validation failed: ${validationError}. Copy contiguous source text, not a reconstructed row. Match the exact schema and original-language cells.\n` : ""
        const prompt = `${extractTablesTask}\nFor this task extract ONLY the ${kind} table. Do not return the other table type.${feedback}\nUNTRUSTED APPLICATION\n${JSON.stringify(source!.passages)}`
        if (prompt.length > 100_000) throw new Error("Table source exceeds context limit")
        const output = await runtime.ask(task.owner, prompt, async sessionID => { task.sessionID = sessionID; await graph.checkpoint() })
        try {
          const validated = validateTablesReading(output, source!)
          if (validated.tables.some(table => table.kind !== kind)) throw new Error(`Return only the requested ${kind} table`)
          return validated
        }
        catch (error: any) { validationError = error.message; throw error }
      })
      if (reading) break
    }
    if (!reading || !source) continue
    const review: TablesReview = { taskId: readingTaskId, source, reading, decisions: [], confirmationTaskId: null }
    reviews.push(review)
    if (!reading.tables.length) continue
    const confirmId = `${sourceId}:confirm-tables`
    graph.add(confirmId, owner, "agent", item.snapshot.sourceUrl, [readingTaskId])
    dependencies.push(confirmId)
    const decisions = await graph.run(confirmId, async task => {
      const candidates = reading.tables.map((table, index) => ({ index, ...table }))
      const prompt = `${confirmTablesTask}\nCANDIDATES\n${JSON.stringify(candidates)}\nUNTRUSTED APPLICATION\n${JSON.stringify(source!.passages)}`
      if (prompt.length > 110_000) throw new Error("Table confirmation exceeds context limit")
      const output = await runtime.ask(task.owner, prompt, async sessionID => { task.sessionID = sessionID; await graph.checkpoint() })
      return validateTableDecisions(output, candidates.length)
    })
    review.confirmationTaskId = confirmId
    if (decisions) review.decisions = decisions
  }
  for (const task of graph.tasks) if (task.status === "failed") gaps.push(`${task.id}: ${task.error}`)
  graph.add("determine-k11", owner, "code", criterion, dependencies)
  const determination = await graph.run("determine-k11", async () => determineIncomeDiscountTables(reviews, applications.map(a => a.snapshot.sha256), gaps), true)
  if (!determination) throw new Error(`Table determination failed; inspect ${join(directory, "tasks.json")}`)
  const result = { runId, hospital, model, ...determination, reusedSources: applications.length,
    scope: "Income-threshold and discount-table presence on identified saved applications. No downloads or FPL accuracy grading.",
    reuseFrom: options.reuseFrom, taskGraph: join(directory, "tasks.json") }
  const path = join(directory, "result.json")
  await writeFile(path, JSON.stringify(result, null, 2), { flag: "wx" })
  console.log(JSON.stringify({ hospitalId: hospital.id, criterion, value: result.value, evidenceCount: result.evidence.length, path }))
  return { ...result, path }
}
