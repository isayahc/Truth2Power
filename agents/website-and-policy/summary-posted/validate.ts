import type { PDFPage } from "../../shared/pdf-text.ts"

export type SummaryReading = {
  isSummary: boolean | null
  evidence: { kind: "designation" | "assistance_information"; page: number; quote: string }[]
}

const normalized = (text: string) => text.normalize("NFC").replace(/\s+/g, " ").trim()

export function validateSummary(output: string, pages: PDFPage[]): SummaryReading {
  const cleaned = output.replace(/<thinking>[\s\S]*?<\/thinking>/g, "").trim()
  const start = cleaned.indexOf("{"); const end = cleaned.lastIndexOf("}")
  let parsed: any
  try { parsed = JSON.parse(cleaned.slice(start, end + 1)) } catch { throw new Error("Summary agent returned invalid JSON") }
  if (!parsed || ![true, false, null].includes(parsed.isSummary) || !Array.isArray(parsed.evidence)
      || Object.keys(parsed).some(key => !["isSummary", "evidence"].includes(key))) throw new Error("Invalid summary reading schema")
  for (const citation of parsed.evidence) {
    if (!citation || !["designation", "assistance_information"].includes(citation.kind) || !Number.isInteger(citation.page)
        || typeof citation.quote !== "string" || normalized(citation.quote).length < 4
        || Object.keys(citation).some(key => !["kind", "page", "quote"].includes(key))) throw new Error("Invalid summary citation")
    const page = pages.find(page => page.page === citation.page)
    if (!page || !normalized(page.text).includes(normalized(citation.quote))) throw new Error("Summary quotation is not on the cited source page")
  }
  if (parsed.isSummary === true && !["designation", "assistance_information"].every(kind => parsed.evidence.some((e: any) => e.kind === kind))) {
    throw new Error("Positive summary identification requires designation and assistance information")
  }
  if (parsed.isSummary !== true && parsed.evidence.length) throw new Error("Nonpositive summary reading must have an empty evidence array")
  return parsed
}
