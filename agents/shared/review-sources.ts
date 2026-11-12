import { createHash } from "node:crypto"
import { readFile } from "node:fs/promises"
import type { Hospital } from "./run-posted-document.ts"
import type { Snapshot } from "./snapshots.ts"
import { extractPDF } from "./pdf-text.ts"
import { outsideLanguageScope } from "./language-scope.ts"

export type ReviewSource = {
  id: string; snapshot: Snapshot; roles: string[]
  passages: { locator: string; text: string }[]
}

export async function loadReviewInventory(hospital: Hospital, paths: string[]) {
  if (!paths.length) throw new Error("Review requires prior source inventories")
  const byUrl = new Map<string, { snapshot: Snapshot; roles: Set<string> }>()
  const gaps = new Set<string>(["Bounded website discovery: online applications and all applicable website pages have not been exhaustively reviewed."])
  const roleByCriterion: Record<string, string> = {
    "posted_materials.application_posted": "application",
    "posted_materials.policy_summary_posted": "policy_summary",
    "posted_materials.policy_statement_posted": "policy_statement",
  }
  for (const path of paths) {
    const prior = JSON.parse(await readFile(path, "utf8"))
    if (prior.hospital?.id !== hospital.id || prior.hospital?.financialAssistanceUrl !== hospital.financialAssistanceUrl) {
      throw new Error("Review inputs belong to a different hospital or landing page")
    }
    const graph = JSON.parse(await readFile(prior.taskGraph, "utf8"))
    if (graph.hospitalId !== hospital.id || !Array.isArray(graph.tasks)) throw new Error("Invalid source task graph")
    for (const gap of prior.gaps ?? []) gaps.add(String(gap))
    const snapshots: Snapshot[] = graph.tasks.filter((task: any) => task.status === "succeeded"
      && (task.id === "fetch-page" || task.id.endsWith(":download"))).map((task: any) => task.result)
    snapshots.push(...(prior.websiteSearch?.pages ?? []))
    for (const snapshot of snapshots) {
      if (!snapshot || !["html", "pdf"].includes(snapshot.kind) || !/^[a-f0-9]{64}$/.test(snapshot.sha256)
          || snapshot.sha256 !== snapshot.snapshot_id || !Number.isFinite(Date.parse(snapshot.retrievedAt))) {
        throw new Error("Invalid source snapshot metadata")
      }
      const roles = new Set<string>(snapshot.kind === "html" ? ["landing_page"] : [])
      const role = roleByCriterion[prior.criterion]
      if (role && (prior.evidence ?? []).some((e: any) => e.sourceUrl === snapshot.sourceUrl && e.sha256 === snapshot.sha256)) roles.add(role)
      const existing = byUrl.get(snapshot.sourceUrl)
      if (!existing || Date.parse(snapshot.retrievedAt) > Date.parse(existing.snapshot.retrievedAt)) {
        if (existing?.snapshot.sha256 === snapshot.sha256) for (const role of existing.roles) roles.add(role)
        byUrl.set(snapshot.sourceUrl, { snapshot, roles })
      } else if (existing.snapshot.sha256 === snapshot.sha256) for (const role of roles) existing.roles.add(role)
    }
  }
  const sources = []
  for (const { snapshot, roles } of byUrl.values()) {
    if (outsideLanguageScope(snapshot.sourceUrl)) {
      gaps.add(`Excluded by English/Spanish budget scope: ${snapshot.sourceUrl}`)
      continue
    }
    sources.push({ snapshot, roles: [...roles] })
  }
  return { sources, gaps: [...gaps] }
}

export function htmlEvidence(html: string) {
  return html.replace(/<!--[\s\S]*?-->/g, " ").replace(/<(script|style)\b[^>]*>[\s\S]*?<\/\1\s*>/gi, " ")
    .replace(/<[^>]*>/g, " ").replace(/&nbsp;/gi, " ").replace(/&amp;/gi, "&")
    .replace(/&quot;/gi, '"').replace(/&#39;|&apos;/gi, "'")
    .replace(/&#(x[0-9a-f]+|\d+);/gi, (match, code: string) => {
      const value = code[0].toLowerCase() === "x" ? parseInt(code.slice(1), 16) : Number(code)
      return value <= 0x10ffff ? String.fromCodePoint(value) : match
    }).replace(/\s+/g, " ").trim()
}

export async function prepareReviewSource(item: { snapshot: Snapshot; roles: string[] }, directory: string): Promise<ReviewSource> {
  const { snapshot } = item
  const bytes = await readFile(snapshot.path)
  if (createHash("sha256").update(bytes).digest("hex") !== snapshot.sha256 || bytes.length !== snapshot.bytes) {
    throw new Error("Review source failed integrity verification")
  }
  const passages = snapshot.kind === "pdf"
    ? (await extractPDF(snapshot, directory)).map(p => ({ locator: `PDF page ${p.page}`, text: p.text }))
    : [{ locator: "HTML extracted text", text: htmlEvidence(bytes.toString("utf8")) }]
  if (passages.some(p => !p.text.trim())) throw new Error("Source has no readable content")
  return { id: snapshot.sha256, snapshot, roles: item.roles, passages }
}
