import type { ReviewSource } from "../../shared/review-sources.ts"
type Citation = { locator: string; quote: string }
export type MaximumReading = {
  limits: (Citation & { kind: "eligibility" | "hard_ceiling" | "discretionary"; percent: number; scope: "general" | "subgroup" })[]
  conditions: (Citation & { explanation: string })[]; limitations: string[]
}
const normalize = (text: string) => text.normalize("NFC").replace(/\s+/g, " ").trim()
function verify(citation: any, source: ReviewSource) {
  const passage = source.passages.find(p => p.locator === citation?.locator)
  if (!passage || typeof citation.quote !== "string" || normalize(citation.quote).length < 8
      || !normalize(passage.text).includes(normalize(citation.quote))) throw new Error("Eligibility quotation failed source verification")
}
export function validateMaximumReading(output: string, source: ReviewSource): MaximumReading {
  const text = output.replace(/<thinking>[\s\S]*?<\/thinking>/g, "").trim()
  let result: any
  try { result = JSON.parse(text.slice(text.indexOf("{"), text.lastIndexOf("}") + 1)) }
  catch { throw new Error("Eligibility agent returned invalid JSON") }
  if (!result || !Array.isArray(result.limits) || !Array.isArray(result.conditions) || !Array.isArray(result.limitations)
      || result.limitations.some((s: any) => typeof s !== "string")
      || Object.keys(result).some(k => !["limits", "conditions", "limitations"].includes(k))) throw new Error("Invalid eligibility reading schema")
  const seen = new Set<string>()
  for (const limit of result.limits) {
    verify(limit, source)
    if (!["eligibility", "hard_ceiling", "discretionary"].includes(limit.kind) || !["general", "subgroup"].includes(limit.scope)
        || !Number.isFinite(limit.percent) || limit.percent <= 0 || limit.percent > 10000
        || Object.keys(limit).some(k => !["kind", "percent", "scope", "locator", "quote"].includes(k))) throw new Error("Invalid eligibility limit")
    const printed = [...limit.quote.matchAll(/(?<![\d.,])(\d+(?:[.,]\d+)?)\s*%/g)].map(m => Number(m[1].replace(",", ".")))
    if (!printed.includes(limit.percent)) throw new Error("Eligibility percentage not supported by quotation")
    const key = `${limit.locator}:${normalize(limit.quote)}`
    if (seen.has(key)) throw new Error("Duplicate eligibility quotation")
    seen.add(key)
  }
  for (const condition of result.conditions) {
    verify(condition, source)
    if (typeof condition.explanation !== "string" || !condition.explanation.trim()
        || Object.keys(condition).some(k => !["locator", "quote", "explanation"].includes(k))) throw new Error("Invalid eligibility condition")
  }
  return result
}
