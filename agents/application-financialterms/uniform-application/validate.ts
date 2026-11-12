import { sectionIds } from "./instructions.ts"
import type { ReviewSource } from "../../shared/review-sources.ts"
import type { UniformReference } from "./reference.ts"
type Citation = { locator: string; quote: string }
export type UniformReading = {
  applicationPages: string[]; referencePages: string[]
  sections: { id: string; status: "correspondence" | "difference" | "uncertain";
    application: Citation[]; reference: Citation[]; explanation: string }[]
  limitations: string[]
}
const normalized = (text: string) => text.normalize("NFC").replace(/\s+/g, " ").trim()
function exactSet(actual: unknown, expected: string[]) {
  return Array.isArray(actual) && actual.length === expected.length && new Set(actual).size === expected.length
    && actual.every(v => expected.includes(v))
}
function verify(citations: any, passages: { locator: string; text: string }[], required: boolean) {
  if (!Array.isArray(citations) || (required && !citations.length)) throw new Error("Missing paired uniform-form citations")
  for (const citation of citations) {
    const passage = passages.find(p => p.locator === citation?.locator)
    if (!passage || typeof citation.quote !== "string" || normalized(citation.quote).length < 8
        || Object.keys(citation).some(k => !["locator", "quote"].includes(k))
        || !normalized(passage.text).includes(normalized(citation.quote))) throw new Error("Uniform-form quotation failed source verification")
  }
}
export function validateUniformReading(output: string, application: ReviewSource, reference: UniformReference): UniformReading {
  const text = output.replace(/<thinking>[\s\S]*?<\/thinking>/g, "").trim()
  let reading: any
  try { reading = JSON.parse(text.slice(text.indexOf("{"), text.lastIndexOf("}") + 1)) }
  catch { throw new Error("Uniform comparison returned invalid JSON") }
  if (!reading || Object.keys(reading).some(k => !["applicationPages", "referencePages", "sections", "limitations"].includes(k))
      || !exactSet(reading.applicationPages, application.passages.map(p => p.locator))
      || !exactSet(reading.referencePages, reference.passages.map(p => p.locator))) throw new Error("Comparison omitted or invented pages")
  if (!Array.isArray(reading.sections) || !exactSet(reading.sections.map((s: any) => s?.id), [...sectionIds])
      || !Array.isArray(reading.limitations) || reading.limitations.some((s: any) => typeof s !== "string")) throw new Error("Incomplete uniform section coverage")
  for (const section of reading.sections) {
    if (!["correspondence", "difference", "uncertain"].includes(section.status)
        || typeof section.explanation !== "string" || !section.explanation.trim()
        || Object.keys(section).some(k => !["id", "status", "application", "reference", "explanation"].includes(k))) throw new Error("Invalid uniform section")
    verify(section.reference, reference.passages, true)
    verify(section.application, application.passages, section.status !== "uncertain")
  }
  return reading
}
