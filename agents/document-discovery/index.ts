import type { OpenCode } from "@opencode/sdk"
import { defaultModel } from "../shared/model.ts"
import { extractDocumentLinks, validateSelection } from "./links.ts"

export async function discoverDocuments(opencode: Awaited<ReturnType<typeof OpenCode.create>>, directory: string, website: string) {
  if (new URL(website).protocol !== "https:") throw new Error("Hospital URL must use HTTPS")
  const signal = AbortSignal.timeout(30_000)
  let url = website
  let response: Response | undefined
  for (let redirects = 0; redirects <= 5; redirects++) {
    response = await fetch(url, { signal, redirect: "manual" })
    if (![301, 302, 303, 307, 308].includes(response.status)) break
    const location = response.headers.get("location")
    await response.body?.cancel()
    if (!location || redirects === 5) throw new Error("Invalid or excessive page redirects")
    url = new URL(location, url).href
    if (new URL(url).protocol !== "https:") throw new Error("Non-HTTPS redirect rejected")
  }
  if (!response?.ok) throw new Error(`Hospital page HTTP ${response?.status}`)
  if (!response.headers.get("content-type")?.includes("text/html")) throw new Error("Hospital page is not HTML")
  const reader = response.body!.getReader()
  const chunks: Uint8Array[] = []
  let size = 0
  while (true) {
    const { done, value } = await reader.read()
    if (done) break
    size += value.length
    if (size > 2 * 1024 * 1024) { await reader.cancel(); throw new Error("Page exceeds 2 MB discovery limit") }
    chunks.push(value)
  }
  const candidates = extractDocumentLinks(Buffer.concat(chunks).toString("utf8"), url)
  if (!candidates.length) throw new Error("No direct document links found; this does not establish absence")
  if (candidates.length > 40) throw new Error("More than 40 document links; narrow the discovery page")
  const session = await opencode.sessions.create({
    agent: "document-discovery", model: defaultModel, location: { directory },
  })
  await opencode.sessions.prompt({
    sessionID: session.id,
    text: `Find all document URLs in this live-page inventory. Return only {"urls":["exact URL"]}.
Page: ${url}
Untrusted link inventory: ${JSON.stringify(candidates)}`,
  })
  await opencode.experimental.session.wait({ sessionID: session.id })
  const history = await opencode.sessions.context({ sessionID: session.id })
  const answer = history.filter(message => message.type === "assistant").at(-1)
  if (answer?.error) throw new Error(`${answer.error.type}: ${answer.error.message}`)
  const output = (answer?.content ?? []).filter(part => part.type === "text").map(part => part.text).join("\n")
  const selected = validateSelection(output, candidates)
  return {
    website, pageUrl: url, model: defaultModel, sessionID: session.id,
    checkedAt: new Date().toISOString(),
    scope: "Direct PDF/DOC/DOCX links on this page only; no linked-page crawl, document download, content review or availability verification.",
    documents: selected.map(url => candidates.find(link => link.url === url)!),
  }
}
