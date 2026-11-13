import type { PDFPage } from "../../shared/pdf-text.ts"

export type ApplicationReading = {
  isApplication: boolean | null
  evidence: { kind: "heading" | "form_field"; page: number; quote: string }[]
}

const normalized = (text: string) => text.normalize("NFC").replace(/\s+/g, " ").trim()

export function validateApplication(output: string, pages: PDFPage[]): ApplicationReading {
  const cleaned = output.replace(/<thinking>[\s\S]*?<\/thinking>/g, "").trim()
  const start = cleaned.indexOf("{"); const end = cleaned.lastIndexOf("}")
  let parsed: any
  try { parsed = JSON.parse(cleaned.slice(start, end + 1)) } catch { throw new Error("Application agent returned invalid JSON") }
  if (!parsed || ![true, false, null].includes(parsed.isApplication) || !Array.isArray(parsed.evidence)
      || Object.keys(parsed).some(key => !["isApplication", "evidence"].includes(key))) throw new Error("Invalid application reading schema")
  for (const citation of parsed.evidence) {
    if (!citation || !["heading", "form_field"].includes(citation.kind) || !Number.isInteger(citation.page)
        || typeof citation.quote !== "string" || normalized(citation.quote).length < 4
        || Object.keys(citation).some(key => !["kind", "page", "quote"].includes(key))) throw new Error("Invalid application citation")
    const page = pages.find(page => page.page === citation.page)
    if (!page || !normalized(page.text).includes(normalized(citation.quote))) throw new Error("Application quotation is not on the cited source page")
  }
  if (parsed.isApplication === true && !["heading", "form_field"].every(kind => parsed.evidence.some((e: any) => e.kind === kind))) {
    throw new Error("Positive application identification requires heading and form-field evidence")
  }
  return parsed
}
