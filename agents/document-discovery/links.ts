export type DocumentLink = { url: string; label: string }

function decode(value: string) {
  return value.replace(/&amp;/gi, "&").replace(/&quot;/gi, '"')
    .replace(/&#39;|&apos;/gi, "'").replace(/&lt;/gi, "<").replace(/&gt;/gi, ">")
    .replace(/&#(x[0-9a-f]+|\d+);/gi, (match, digits: string) => {
      const code = digits[0].toLowerCase() === "x" ? parseInt(digits.slice(1), 16) : Number(digits)
      return code <= 0x10ffff ? String.fromCodePoint(code) : match
    })
}

export function extractDocumentLinks(html: string, pageUrl: string): DocumentLink[] {
  const links = new Map<string, DocumentLink>()
  const body = html.replace(/<!--[\s\S]*?-->/g, "")
    .replace(/<(script|style)\b[^>]*>[\s\S]*?<\/\1\s*>/gi, "")
  for (const anchor of body.matchAll(/<a\b[^>]*>([\s\S]*?)<\/a\s*>/gi)) {
    const href = /\s+href\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s>]+))/i.exec(anchor[0])
    if (!href) continue
    try {
      const url = new URL(decode(href[1] ?? href[2] ?? href[3]), pageUrl)
      url.hash = ""
      if (url.protocol !== "https:" || !/\.(pdf|docx?)$/i.test(url.pathname)) continue
      if (!links.has(url.href)) links.set(url.href, {
        url: url.href, label: decode(anchor[1].replace(/<[^>]*>/g, " ")).replace(/\s+/g, " ").trim(),
      })
    } catch { /* Ignore invalid source URLs. */ }
  }
  return [...links.values()]
}

export function validateSelection(output: string, candidates: DocumentLink[]): string[] {
  const cleaned = output.replace(/<thinking>[\s\S]*?<\/thinking>/g, "").trim()
  const fenced = /```(?:json)?\s*\n([\s\S]*?)\n```/.exec(cleaned)
  let value: unknown
  const start = cleaned.indexOf("{")
  const end = cleaned.lastIndexOf("}")
  const json = fenced?.[1] ?? (start >= 0 && end > start ? cleaned.slice(start, end + 1) : cleaned)
  try { value = JSON.parse(json) }
  catch {
    // Only accept explicit list entries, never URLs buried in narrative text.
    const urls = cleaned.split(/\r?\n/)
      .filter(line => /^\s*(?:[-*+] |\d+[.)] )/.test(line))
      .flatMap(line => line.match(/https:\/\/[^\s<>"`\])]+/g) ?? [])
    if (!urls.length) throw new Error("Discovery returned neither a JSON selection nor an explicit URL list; no inventory accepted")
    value = { urls }
  }
  const allowed = new Set(candidates.map(link => link.url))
  if (!value || typeof value !== "object" || !("urls" in value)
      || !Array.isArray(value.urls) || value.urls.some((url: unknown) => typeof url !== "string" || !allowed.has(url))) {
    throw new Error("Discovery agent returned invalid or invented document URLs")
  }
  const selected = [...new Set<string>(value.urls)]
  if (selected.length !== allowed.size) throw new Error("Discovery agent omitted document links")
  return selected
}
