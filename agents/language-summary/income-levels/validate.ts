import type { ReviewSource } from "../../shared/review-sources.ts"
export type IncomeLevel = { basis: "fpl_percent" | "income_amount"; threshold: string; locator: string; quote: string }
export type IncomeReading = { levels: IncomeLevel[]; limitations: string[] }
const normalize = (s: string) => s.normalize("NFC").replace(/\s+/g, " ").trim()
export function validateIncomeReading(output: string, source: ReviewSource): IncomeReading {
  const text = output.replace(/<thinking>[\s\S]*?<\/thinking>/g, "").trim()
  let result: any
  try { result = JSON.parse(text.slice(text.indexOf("{"), text.lastIndexOf("}") + 1)) }
  catch { throw new Error("Income-level agent returned invalid JSON") }
  if (!result || !Array.isArray(result.levels) || !Array.isArray(result.limitations)
      || result.limitations.some((v: any) => typeof v !== "string")
      || Object.keys(result).some(k => !["levels", "limitations"].includes(k))) throw new Error("Invalid income-level schema")
  const seen = new Set<string>()
  for (const level of result.levels) {
    if (!level || !["fpl_percent", "income_amount"].includes(level.basis)) throw new Error("Invalid income level: basis")
    if (typeof level.threshold !== "string" || !/\d/.test(level.threshold)) throw new Error("Invalid income level: numeric threshold required")
    if (typeof level.quote !== "string" || normalize(level.quote).length < 8
        || Object.keys(level).some(k => !["basis", "threshold", "locator", "quote"].includes(k))) throw new Error("Invalid income level: quote or fields")
    const passage = source.passages.find(p => p.locator === level.locator)
    if (!passage || !normalize(passage.text).includes(normalize(level.quote))) throw new Error("Income-level quotation failed source verification")
    if (!normalize(level.quote).includes(normalize(level.threshold))) throw new Error("Income threshold not supported by quotation")
    const key = `${level.basis}:${normalize(level.threshold)}:${level.locator}:${normalize(level.quote)}`
    if (seen.has(key)) throw new Error("Duplicate income level")
    seen.add(key)
  }
  return result
}
