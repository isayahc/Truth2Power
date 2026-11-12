import { mkdir, readFile, writeFile } from "node:fs/promises"
import { loadEnvFile } from "node:process"
import { fileURLToPath } from "node:url"
import { join } from "node:path"
import { randomUUID } from "node:crypto"
import { TaskGraph } from "../task-graph/index.ts"
import { sourceStore } from "./source-reuse.ts"
import { saveSource } from "./snapshots.ts"
import type { Snapshot } from "./snapshots.ts"
import { extractPDF } from "./pdf-text.ts"
import type { PDFPage } from "./pdf-text.ts"
import { createAgentRuntime } from "./agent-runtime.ts"
import type { Model } from "./agent-runtime.ts"
import { extractDocumentLinks, validateSelection } from "../document-discovery/links.ts"
import { discoveryInstructions } from "../document-discovery/instructions.ts"
import { searchHospitalWebsite } from "../document-discovery/website-search.ts"
import { outsideLanguageScope, languageScope } from "./language-scope.ts"

export type Hospital = { id: string; name: string; financialAssistanceUrl: string }

export type ReuseOptions = { reuseFrom?: string }
export type PostedDocumentCheck<R, D> = {
  key: string; criterion: string; taskId: string; instructions: string
  searchWebsite?: boolean
  validate: (output: string, pages: PDFPage[]) => R
  determine: (documents: { taskId: string; snapshot: Snapshot; reading: R }[]) => D
}

export async function runPostedDocument<R, D extends { value: boolean | null; evidence: unknown[] }>(
  hospital: Hospital, model: Model, check: PostedDocumentCheck<R, D>, options: ReuseOptions = {},
) {
  const criterion = check.criterion
  if (!hospital.id.trim() || !hospital.name.trim() || new URL(hospital.financialAssistanceUrl).protocol !== "https:") {
    throw new Error("Hospital requires an ID, name and HTTPS financial-assistance page")
  }
  const projectDirectory = fileURLToPath(new URL("../../", import.meta.url))
  try { loadEnvFile(join(projectDirectory, ".env")) } catch (error: any) { if (error.code !== "ENOENT") throw error }
  const runId = randomUUID()
  const directory = join(projectDirectory, ".audit", "agents", check.key, runId)
  await mkdir(directory, { recursive: true })
  const graph = new TaskGraph(hospital.id, directory)
  const documents: { taskId: string; snapshot: Snapshot; reading: R }[] = []
  const sources = await sourceStore(directory, hospital, options.reuseFrom, check.searchWebsite)
  const reviewTasks: string[] = []
  const gaps: string[] = []
  graph.add("fetch-page", "document-discovery", "code", hospital.financialAssistanceUrl)
  if (check.searchWebsite) graph.add("search-website", "document-discovery", "code", hospital.financialAssistanceUrl, ["fetch-page"])
  graph.add("discover-documents", "document-discovery", "agent", hospital.financialAssistanceUrl, [check.searchWebsite ? "search-website" : "fetch-page"])
  await graph.checkpoint()
  await writeFile(join(directory, "run.json"), JSON.stringify({ runId, hospital, model, criterion, ...options }, null, 2))
  await using runtime = await createAgentRuntime(projectDirectory, model, {
    "document-discovery": discoveryInstructions, "website-and-policy": check.instructions,
  })
  const page = await graph.run("fetch-page", () => check.searchWebsite
    ? saveSource(directory, hospital.financialAssistanceUrl, "html")
    : sources.get(hospital.financialAssistanceUrl, "html"))
  const search = check.searchWebsite
    ? await graph.run("search-website", () => searchHospitalWebsite(page!, directory)) : undefined
  if (search) gaps.push(...search.gaps)
  const links = await graph.run("discover-documents", async task => {
    const allCandidates = search?.documents ?? extractDocumentLinks(await readFile(page!.path, "utf8"), page!.finalUrl)
    const candidates = allCandidates.filter(link => !outsideLanguageScope(link.url, link.label))
    for (const link of allCandidates) if (!candidates.includes(link)) gaps.push(`Excluded by English/Spanish budget scope: ${link.url}`)
    if (candidates.length > 40) throw new Error("More than 40 document candidates; narrow the input page")
    const output = await runtime.ask(task.owner, JSON.stringify({ page: page!.finalUrl, links: candidates }), async id => {
      task.sessionID = id; await graph.checkpoint()
    })
    return validateSelection(output, candidates).map(url => candidates.find(link => link.url === url)!)
  })
  for (const [index, link] of (links ?? []).entries()) {
    const id = `document-${index + 1}`
    graph.add(`${id}:download`, "website-and-policy", "code", link.url, ["discover-documents"])
    graph.add(`${id}:extract`, "website-and-policy", "code", link.url, [`${id}:download`])
    graph.add(`${id}:identify`, "website-and-policy", "agent", link.url, [`${id}:extract`])
    reviewTasks.push(`${id}:identify`)
    const snapshot = await graph.run(`${id}:download`, async () => {
      if (!/\.pdf$/i.test(new URL(link.url).pathname)) throw new Error("This proof runner supports PDF documents only")
      return sources.get(link.url, "pdf")
    })
    const pages = await graph.run(`${id}:extract`, async () => {
      const pages = await extractPDF(snapshot!, projectDirectory)
      const path = join(directory, `${id}-pages.json`)
      await writeFile(path, JSON.stringify(pages))
      return { path, count: pages.length }
    })
    const reading = await graph.run(`${id}:identify`, async task => {
      const text = JSON.parse(await readFile(pages!.path, "utf8"))
      const output = await runtime.ask(task.owner, JSON.stringify({ pages: text }), async id => {
        task.sessionID = id; await graph.checkpoint()
      })
      return check.validate(output, text)
    })
    if (reading && snapshot) documents.push({ taskId: `${id}:identify`, snapshot, reading })
  }
  for (const task of graph.tasks) if (task.status === "failed") gaps.push(`${task.id}: ${task.error}`)
  graph.add(check.taskId, "website-and-policy", "code", criterion, ["discover-documents", ...reviewTasks])
  const determination = await graph.run(check.taskId, async () => check.determine(documents), true)
  if (!determination) throw new Error(`Criterion determination failed; inspect ${join(directory, "tasks.json")}`)
  const result = { runId, hospital, model, ...determination, gaps, languageScope,
    landingPage: page ?? null, discoveredDocuments: links ?? [],
    websiteSearch: search ?? null,
    scope: `${search?.scope ?? "Direct document links from the supplied financial-assistance page."} Text-readable PDFs only; HTML policy bodies and online forms are not classified. A negative result cannot be established by this scope. Reused PDF availability reflects the recorded original retrieval time.`,
    taskGraph: join(directory, "tasks.json"), reuseFrom: options.reuseFrom ?? null,
  }
  const path = join(directory, "result.json")
  await writeFile(path, JSON.stringify(result, null, 2), { flag: "wx" })
  console.log(JSON.stringify({ hospitalId: hospital.id, criterion, value: result.value, evidenceCount: result.evidence?.length ?? 0, path }))
  return { ...result, path }
}
