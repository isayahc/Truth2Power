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
import { assetInstructions, extractAssetTask, confirmAssetTask } from "./instructions.ts"
import { validateAssetReading, validateAssetDecisions } from "./validate.ts"
import { criterion, determineAssetChecks } from "./result.ts"
import type { AssetReview, AssetConfirmation } from "./result.ts"

export async function checkAssetChecks(hospital: Hospital, model: Model, options: { reuseFrom: string[] }) {
  const project = fileURLToPath(new URL("../../../", import.meta.url))
  try { loadEnvFile(join(project, ".env")) } catch (error: any) { if (error.code !== "ENOENT") throw error }
  const runId = randomUUID()
  const directory = join(project, ".audit", "agents", "asset-checks", runId)
  await mkdir(directory, { recursive: true })
  const graph = new TaskGraph(hospital.id, directory)
  await writeFile(join(directory, "run.json"), JSON.stringify({ runId, hospital, model, criterion, ...options }, null, 2))
  graph.add("load-inventory", "website-and-policy", "code", criterion)
  const inventory = await graph.run("load-inventory", () => loadReviewInventory(hospital, options.reuseFrom))
  const gaps = [...(inventory?.gaps ?? [])]
  const reviews: AssetReview[] = []
  const confirmations: AssetConfirmation[] = []
  const dependencies = ["load-inventory"]
  await using runtime = await createAgentRuntime(project, model, { "website-and-policy": assetInstructions })

  // Break here to inspect each source; then step into validation and determination.
  for (const [i, item] of (inventory?.sources ?? []).entries()) {
    const sourceId = `source-${i + 1}`
    const prepareTaskId = `${sourceId}:prepare`
    const reviewTaskId = `${sourceId}:assets`
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
      if (sourceText.length > 100_000) throw new Error("Asset source exceeds context limit")
      const output = await runtime.ask(task.owner, `${extractAssetTask}\nUNTRUSTED SOURCE\n${sourceText}`, async sessionID => {
        task.sessionID = sessionID
        await graph.checkpoint()
      })
      return validateAssetReading(output, source!)
    })
    if (!reading || !source) continue
    reviews.push({ taskId: reviewTaskId, source, reading })

    const candidates = reading.statements.map((statement, index) => ({ index, ...statement }))
      .filter(statement => statement.kind !== "ambiguous")
    if (!candidates.length) continue
    const confirmationTaskId = `${sourceId}:confirm-assets`
    graph.add(confirmationTaskId, "website-and-policy", "agent", item.snapshot.sourceUrl, [reviewTaskId])
    dependencies.push(confirmationTaskId)
    const decisions = await graph.run(confirmationTaskId, async task => {
      const prompt = `${confirmAssetTask}\nCANDIDATES\n${JSON.stringify(candidates)}\nUNTRUSTED SOURCE\n${JSON.stringify(source!.passages)}`
      if (prompt.length > 110_000) throw new Error("Asset confirmation exceeds context limit")
      const output = await runtime.ask(task.owner, prompt, async sessionID => {
        task.sessionID = sessionID
        await graph.checkpoint()
      })
      return validateAssetDecisions(output, candidates.map(candidate => candidate.index))
    })
    if (decisions) confirmations.push({ reviewTaskId, taskId: confirmationTaskId, decisions })
  }

  for (const task of graph.tasks) if (task.status === "failed") gaps.push(`${task.id}: ${task.error}`)
  graph.add("determine-k7", "website-and-policy", "code", criterion, dependencies)
  const determination = await graph.run("determine-k7", async () => determineAssetChecks(reviews, confirmations, gaps), true)
  if (!determination) throw new Error(`Asset determination failed; inspect ${join(directory, "tasks.json")}`)
  const result = { runId, hospital, model, ...determination, reusedSources: inventory?.sources.length ?? 0,
    scope: "Saved website/PDF evidence in all supplied languages; asset eligibility conditions, not income verification. Bounded coverage; no downloads.",
    reuseFrom: options.reuseFrom, taskGraph: join(directory, "tasks.json") }
  const path = join(directory, "result.json")
  await writeFile(path, JSON.stringify(result, null, 2), { flag: "wx" })
  console.log(JSON.stringify({ hospitalId: hospital.id, criterion, value: result.value, evidenceCount: result.evidence.length, path }))
  return { ...result, path }
}
