import { readFile } from "node:fs/promises"
import { saveSource } from "../shared/snapshots.ts"
import type { Snapshot } from "../shared/snapshots.ts"
import { extractDocumentLinks } from "./links.ts"

// Bounded search of the hospital's own live site, not search-engine snippets.
export function relatedFinancialPages(html: string, pageUrl: string): string[] {
  const origin = new URL(pageUrl).origin
  const pages = new Set<string>()
  const body = html.replace(/<!--[\s\S]*?-->/g, "").replace(/<(script|style)\b[^>]*>[\s\S]*?<\/\1\s*>/gi, "")
  for (const anchor of body.matchAll(/<a\b[^>]*>([\s\S]*?)<\/a\s*>/gi)) {
    const href = /\s+href\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s>]+))/i.exec(anchor[0])
    if (!href) continue
    try {
      const url = new URL((href[1] ?? href[2] ?? href[3]).replace(/&amp;/gi, "&"), pageUrl)
      url.hash = ""
      const label = anchor[1].replace(/<[^>]*>/g, " ")
      if (url.origin !== origin || url.username || url.password || /\.(pdf|docx?|zip|jpe?g|png)$/i.test(url.pathname)) continue
      if (!/financial[-\s]*(assistance|aid)|charity[-\s]*care|asistencia[-\s]*(financiera|econ[oó]mica)/i.test(`${url.pathname} ${label}`)) continue
      pages.add(url.href)
    } catch { /* Ignore invalid links. */ }
  }
  return [...pages]
}

export async function searchHospitalWebsite(firstPage: Snapshot, directory: string, maxPages = 4) {
  const pages: Snapshot[] = []
  const gaps: string[] = []
  const visited = new Set<string>()
  const queue: { url: string; snapshot?: Snapshot }[] = [{ url: firstPage.finalUrl, snapshot: firstPage }]
  const documents = new Map<string, { url: string; label: string; foundOn: string[] }>()
  while (queue.length && visited.size < maxPages) {
    const next = queue.shift()!
    if (visited.has(next.url)) continue
    visited.add(next.url)
    try {
      const snapshot = next.snapshot ?? await saveSource(directory, next.url, "html")
      if (new URL(snapshot.finalUrl).origin !== new URL(firstPage.finalUrl).origin) {
        gaps.push(`Related page redirected outside the hospital site: ${next.url}`); continue
      }
      pages.push(snapshot)
      visited.add(snapshot.finalUrl)
      const html = await readFile(snapshot.path, "utf8")
      for (const link of extractDocumentLinks(html, snapshot.finalUrl)) {
        const existing = documents.get(link.url)
        if (existing) existing.foundOn.push(snapshot.snapshot_id)
        else documents.set(link.url, { ...link, foundOn: [snapshot.snapshot_id] })
      }
      for (const url of relatedFinancialPages(html, snapshot.finalUrl)) {
        if (!visited.has(url) && !queue.some(item => item.url === url)) queue.push({ url })
      }
    } catch (error) { gaps.push(`${next.url}: ${error instanceof Error ? error.message : "Page search failed"}`) }
  }
  if (queue.length) gaps.push(`Website search page limit reached; ${queue.length} linked pages not visited`)
  return { pages, documents: [...documents.values()], gaps, maxPages,
    scope: "Bounded search of the supplied live page and same-origin financial-assistance links; not an exhaustive website or search-engine search." }
}
