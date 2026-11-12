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
import { contactInstructions, extractContactTask, confirmContactTask } from "./instructions.ts"
import { validateContactReading, validateContactDecisions } from "./validate.ts"
import type { ContactReading } from "./validate.ts"
import { searchContactWebsite } from "./website.ts"
import { criterion, determineContactInformation } from "./result.ts"
import type { ContactReview } from "./result.ts"

export async function checkContactInformation(hospital: Hospital, model: Model, options: { reuseFrom: string[] }) {
  const project = fileURLToPath(new URL("../../../", import.meta.url))
  try { loadEnvFile(join(project, ".env")) } catch (error: any) { if (error.code !== "ENOENT") throw error }
  const runId = randomUUID()
  const directory = join(project, ".audit", "agents", "contact-information", runId)
  await mkdir(directory, { recursive: true })
  const graph = new TaskGraph(hospital.id, directory)
  const owner = "application-financialterms"
  await writeFile(join(directory, "run.json"), JSON.stringify({ runId, hospital, model, criterion, ...options }, null, 2))
  graph.add("load-inventory", owner, "code", criterion)
  graph.add("search-contact-website", "document-discovery", "code", hospital.financialAssistanceUrl)
  const inventory = await graph.run("load-inventory", () => loadReviewInventory(hospital, options.reuseFrom))
  const websiteSearch = await graph.run("search-contact-website", () => searchContactWebsite(hospital.financialAssistanceUrl, directory))
  const gaps = [...(inventory?.gaps ?? []), ...(websiteSearch?.gaps ?? [])]
  const applications = (inventory?.sources ?? []).filter(item => item.roles.includes("application"))
  const sources = [...applications, ...(websiteSearch?.pages ?? []).map(snapshot => ({ snapshot, roles: ["website_corroboration"] }))]
  const reviews: ContactReview[] = []
  const dependencies = ["load-inventory", "search-contact-website"]
  await using runtime = await createAgentRuntime(project, model, { [owner]: contactInstructions })
  // F5: source -> reading -> decisions -> per-application verdict.
  for (const [i, item] of sources.entries()) {
    const sourceId = `source-${i + 1}`
    const prepareId = `${sourceId}:prepare`
    const reviewId = `${sourceId}:contacts`
    graph.add(prepareId, owner, "code", item.snapshot.sourceUrl, [item.roles.includes("application") ? "load-inventory" : "search-contact-website"])
    graph.add(reviewId, owner, "agent", item.snapshot.sourceUrl, [prepareId])
    dependencies.push(reviewId)
    let source: ReviewSource | undefined
    await graph.run(prepareId, async () => {
      source = await prepareReviewSource(item, project)
      source.id = sourceId
      const path = join(directory, `${sourceId}.json`)
      await writeFile(path, JSON.stringify(source))
      return { path, snapshot: source.snapshot, reused: item.roles.includes("application") }
    })
    let reading: ContactReading | undefined
    let readingTaskId = reviewId
    let validationError = ""
    // One repair attempt for schema/quotation errors. Never relax the validator.
    for (let attempt = 0; attempt < 2; attempt++) {
      if (attempt === 1) {
        if (!source || !validationError) break
        readingTaskId = `${sourceId}:repair-contacts`
        graph.add(readingTaskId, owner, "agent", item.snapshot.sourceUrl, [prepareId])
        dependencies.push(readingTaskId)
      }
      reading = await graph.run(readingTaskId, async task => {
        const feedback = validationError ? `\nPrevious reading failed: ${validationError}. Return ONLY the specified keys. organization must be exactly hospital or advocate. Copy quotes and values verbatim, including punctuation; no paraphrases.\n` : ""
        const prompt = `${extractContactTask}${feedback}\nUNTRUSTED SOURCE\n${JSON.stringify(source!.passages)}`
        if (prompt.length > 100_000) throw new Error("Contact source exceeds context limit")
        const output = await runtime.ask(task.owner, prompt, async sessionID => { task.sessionID = sessionID; await graph.checkpoint() })
        try { return validateContactReading(output, source!) }
        catch (error: any) { validationError = error.message; throw error }
      })
      if (reading) break
    }
    if (!reading || !source) continue
    const review: ContactReview = { taskId: readingTaskId, source, reading, decisions: [], confirmationTaskId: null }
    reviews.push(review)
    if (!reading.contacts.length) continue
    const confirmId = `${sourceId}:confirm-contacts`
    graph.add(confirmId, owner, "agent", item.snapshot.sourceUrl, [readingTaskId])
    dependencies.push(confirmId)
    const decisions = await graph.run(confirmId, async task => {
      const candidates = reading.contacts.map((contact, index) => ({ index, ...contact }))
      const prompt = `${confirmContactTask}\nCANDIDATES\n${JSON.stringify(candidates)}\nUNTRUSTED SOURCE\n${JSON.stringify(source!.passages)}`
      if (prompt.length > 110_000) throw new Error("Contact confirmation exceeds context limit")
      const output = await runtime.ask(task.owner, prompt, async sessionID => { task.sessionID = sessionID; await graph.checkpoint() })
      return validateContactDecisions(output, candidates.length)
    })
    review.confirmationTaskId = confirmId
    if (decisions) review.decisions = decisions
  }
  for (const task of graph.tasks) if (task.status === "failed") gaps.push(`${task.id}: ${task.error}`)
  graph.add("determine-k10", owner, "code", criterion, dependencies)
  const determination = await graph.run("determine-k10", async () => determineContactInformation(reviews, applications.map(a => a.snapshot.sha256), gaps), true)
  if (!determination) throw new Error(`Contact determination failed; inspect ${join(directory, "tasks.json")}`)
  const result = { runId, hospital, model, ...determination, reusedSources: applications.length, websiteSearch,
    scope: "Application-help contact presence on each identified saved application, with bounded live hospital-site corroboration. No PDF re-downloads.",
    reuseFrom: options.reuseFrom, taskGraph: join(directory, "tasks.json") }
  const path = join(directory, "result.json")
  await writeFile(path, JSON.stringify(result, null, 2), { flag: "wx" })
  console.log(JSON.stringify({ hospitalId: hospital.id, criterion, value: result.value, evidenceCount: result.evidence.length, path }))
  return { ...result, path }
}
