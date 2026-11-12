import { readFile } from "node:fs/promises"
import { saveSource } from "../../shared/snapshots.ts"
import type { Snapshot } from "../../shared/snapshots.ts"

export function contactPageLinks(html: string, pageUrl: string) {
  const urls = new Set<string>()
  const body = html.replace(/<!--[\s\S]*?-->/g, "").replace(/<(script|style)\b[^>]*>[\s\S]*?<\/\1\s*>/gi, "")
  for (const anchor of body.matchAll(/<a\b[^>]*>([\s\S]*?)<\/a\s*>/gi)) {
    const match = /\s+href\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s>]+))/i.exec(anchor[0])
    if (!match) continue
    try {
      const href = (match[1] ?? match[2] ?? match[3]).replace(/&amp;/gi, "&").trim()
      // Some hospital anchors accidentally put a phone number in href without tel:.
      if (/^[+()\d\s.-]+$/.test(href) || !href || href.startsWith("#")) continue
      const url = new URL(href, pageUrl)
      url.hash = ""
      if (url.origin !== new URL(pageUrl).origin || url.username || url.password || /\.(pdf|docx?|zip|png|jpe?g)$/i.test(url.pathname)) continue
      if (/financial[-\s]*(assistance|aid)|contact[-\s]*us|paying-for-your-care|patient[-\s]*financ|billing/i.test(`${url.pathname} ${anchor[1].replace(/<[^>]*>/g, " ")}`)) urls.add(url.href)
    } catch { /* Not a usable same-origin link. */ }
  }
  return [...urls]
}
export async function searchContactWebsite(startUrl: string, directory: string) {
  const pages: Snapshot[] = []
  const gaps: string[] = []
  const queue = [startUrl]
  const visited = new Set<string>()
  while (queue.length && visited.size < 4) {
    const url = queue.shift()!
    if (visited.has(url)) continue
    visited.add(url)
    try {
      const snapshot = await saveSource(directory, url, "html")
      if (new URL(snapshot.finalUrl).origin !== new URL(startUrl).origin) throw new Error("Contact page redirected outside hospital site")
      pages.push(snapshot)
      const html = await readFile(snapshot.path, "utf8")
      for (const link of contactPageLinks(html, snapshot.finalUrl)) if (!visited.has(link) && !queue.includes(link)) queue.push(link)
    } catch (error: any) { gaps.push(`${url}: ${error.message}`) }
  }
  if (queue.length) gaps.push("Bounded contact search reached its four-page limit.")
  return { pages, gaps, scope: "Live same-origin financial-assistance, contact and billing links, at most four pages. Search snippets are not evidence." }
}
