import type { ReviewSource } from "../../shared/review-sources.ts"
export type SummaryAreaReading = {
  descriptions: { scope: "primary_service_area" | "non_emergency" | "all_services" | "emergency_only" | "unclear";
    areas: string[]; locator: string; quote: string }[]
  limitations: string[]
}
const normalize = (s: string) => s.normalize("NFC").replace(/\s+/g, " ").trim()
export function validateSummaryArea(output: string, source: ReviewSource): SummaryAreaReading {
  const text = output.replace(/<thinking>[\s\S]*?<\/thinking>/g, "").trim()
  let result: any
  try { result = JSON.parse(text.slice(text.indexOf("{"), text.lastIndexOf("}") + 1)) }
  catch { throw new Error("Summary area agent returned invalid JSON") }
  if (!result || !Array.isArray(result.descriptions) || !Array.isArray(result.limitations)
      || result.limitations.some((s: any) => typeof s !== "string")
      || Object.keys(result).some(k => !["descriptions", "limitations"].includes(k))) throw new Error("Invalid summary area schema")
  const seen = new Set<string>()
  for (const d of result.descriptions) {
    if (!d || !["primary_service_area", "non_emergency", "all_services", "emergency_only", "unclear"].includes(d.scope)
        || !Array.isArray(d.areas) || !d.areas.length || d.areas.some((a: any) => typeof a !== "string" || !a.trim())
        || typeof d.quote !== "string" || normalize(d.quote).length < 8
        || Object.keys(d).some(k => !["scope", "areas", "locator", "quote"].includes(k))) throw new Error("Invalid service-area description")
    const passage = source.passages.find(p => p.locator === d.locator)
    if (!passage || !normalize(passage.text).includes(normalize(d.quote))) throw new Error("Summary area quotation failed source verification")
    if (d.areas.some((a: string) => !normalize(d.quote).includes(normalize(a)))) throw new Error("Area name not supported by quotation")
    if (new Set(d.areas.map(normalize)).size !== d.areas.length) throw new Error("Duplicate area name")
    const key = `${d.scope}:${d.locator}:${normalize(d.quote)}`
    if (seen.has(key)) throw new Error("Duplicate area description")
    seen.add(key)
  }
  return result
}
