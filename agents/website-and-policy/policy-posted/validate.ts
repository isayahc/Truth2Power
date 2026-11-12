import type { PDFPage } from "../../shared/pdf-text.ts"

export type PolicyReading = {
  isPolicy: boolean | null
  evidence: { kind: "policy_identity" | "governing_provision"; page: number; quote: string }[]
}

const normalized = (text: string) => text.normalize("NFC").replace(/\s+/g, " ").trim()

export function validatePolicy(output: string, pages: PDFPage[]): PolicyReading {
  const cleaned = output.replace(/<thinking>[\s\S]*?<\/thinking>/g, "").trim()
  const start = cleaned.indexOf("{"); const end = cleaned.lastIndexOf("}")
  let parsed: any
  try { parsed = JSON.parse(cleaned.slice(start, end + 1)) } catch { throw new Error("Policy agent returned invalid JSON") }
  if (!parsed || ![true, false, null].includes(parsed.isPolicy) || !Array.isArray(parsed.evidence)
      || Object.keys(parsed).some(key => !["isPolicy", "evidence"].includes(key))) throw new Error("Invalid policy reading schema")
  for (const citation of parsed.evidence) {
    if (!citation || !["policy_identity", "governing_provision"].includes(citation.kind) || !Number.isInteger(citation.page)
        || typeof citation.quote !== "string" || normalized(citation.quote).length < 4
        || Object.keys(citation).some(key => !["kind", "page", "quote"].includes(key))) throw new Error("Invalid policy citation")
    const page = pages.find(page => page.page === citation.page)
    if (!page || !normalized(page.text).includes(normalized(citation.quote))) throw new Error("Policy quotation is not on the cited source page")
  }
  if (parsed.isPolicy === true && !["policy_identity", "governing_provision"].every(kind => parsed.evidence.some((e: any) => e.kind === kind))) {
    throw new Error("Positive policy identification requires policy identity and a governing provision")
  }
  if (parsed.isPolicy !== true && parsed.evidence.length) throw new Error("Nonpositive policy reading must have an empty evidence array")
  return parsed
}
