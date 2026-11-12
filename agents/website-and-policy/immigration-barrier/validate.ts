import type { ReviewSource } from "../../shared/review-sources.ts"

export type ImmigrationStatement = {
  kind: "regardless_of_status" | "status_barrier" | "ambiguous"
  locator: string; quote: string; explanation: string
}
export type ImmigrationReading = { statements: ImmigrationStatement[]; limitations: string[] }
export type ImmigrationDecision = { index: number; confirmed: boolean; explanation: string }
const normalized = (text: string) => text.normalize("NFC").replace(/\s+/g, " ").trim()

function parse(output: string): any {
  const text = output.replace(/<thinking>[\s\S]*?<\/thinking>/g, "").trim()
  try { return JSON.parse(text.slice(text.indexOf("{"), text.lastIndexOf("}") + 1)) }
  catch { throw new Error("Immigration review returned invalid JSON") }
}

export function validateImmigrationReading(output: string, source: ReviewSource): ImmigrationReading {
  const result = parse(output)
  if (!result || !Array.isArray(result.statements) || !Array.isArray(result.limitations)
      || result.limitations.some((v: any) => typeof v !== "string")
      || Object.keys(result).some(k => !["statements", "limitations"].includes(k))) throw new Error("Invalid immigration reading schema")
  const seen = new Set<string>()
  for (const statement of result.statements) {
    if (!statement || !["regardless_of_status", "status_barrier", "ambiguous"].includes(statement.kind)
        || typeof statement.quote !== "string" || normalized(statement.quote).length < 8
        || typeof statement.explanation !== "string" || !statement.explanation.trim()
        || Object.keys(statement).some(k => !["kind", "locator", "quote", "explanation"].includes(k))) {
      throw new Error("Invalid immigration statement")
    }
    const passage = source.passages.find(p => p.locator === statement.locator)
    if (!passage || !normalized(passage.text).includes(normalized(statement.quote))) throw new Error("Immigration quotation failed source verification")
    const key = `${statement.locator}\n${normalized(statement.quote)}`
    if (seen.has(key)) throw new Error("Duplicate immigration quotation")
    seen.add(key)
  }
  return result
}

export function validateImmigrationDecisions(output: string, indexes: number[]): ImmigrationDecision[] {
  const result = parse(output)
  if (!result || !Array.isArray(result.decisions) || Object.keys(result).some(k => k !== "decisions")) throw new Error("Invalid immigration confirmation schema")
  const seen = new Set<number>()
  for (const decision of result.decisions) {
    if (!decision || !Number.isInteger(decision.index) || !indexes.includes(decision.index) || seen.has(decision.index)
        || typeof decision.confirmed !== "boolean" || typeof decision.explanation !== "string" || !decision.explanation.trim()
        || Object.keys(decision).some(k => !["index", "confirmed", "explanation"].includes(k))) throw new Error("Invalid immigration confirmation index or decision")
    seen.add(decision.index)
  }
  if (seen.size !== indexes.length) throw new Error("Immigration confirmation omitted candidates")
  return result.decisions
}
