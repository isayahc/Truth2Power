import type { ReviewSource } from "../../shared/review-sources.ts"

export type TimingStatement = {
  kind: "any_time" | "submission_deadline" | "ambiguous"
  locator: string; quote: string; explanation: string
}
export type DeadlineReading = { statements: TimingStatement[]; limitations: string[] }
export type DeadlineConfirmation = { confirmed: boolean; explanation: string }

function parse(output: string): any {
  const text = output.replace(/<thinking>[\s\S]*?<\/thinking>/g, "").trim()
  try { return JSON.parse(text.slice(text.indexOf("{"), text.lastIndexOf("}") + 1)) }
  catch { throw new Error("Deadline agent returned invalid JSON") }
}
const normalized = (text: string) => text.normalize("NFC").replace(/\s+/g, " ").trim()

export function validateDeadline(output: string, source: ReviewSource): DeadlineReading {
  const result = parse(output)
  if (!result || !Array.isArray(result.statements) || !Array.isArray(result.limitations)
      || result.limitations.some((v: any) => typeof v !== "string")
      || Object.keys(result).some(k => !["statements", "limitations"].includes(k))) throw new Error("Invalid deadline reading schema")
  const seen = new Set<string>()
  for (const statement of result.statements) {
    if (!statement || !["any_time", "submission_deadline", "ambiguous"].includes(statement.kind)
        || typeof statement.quote !== "string" || normalized(statement.quote).length < 8
        || typeof statement.explanation !== "string" || !statement.explanation.trim()
        || Object.keys(statement).some(k => !["kind", "locator", "quote", "explanation"].includes(k))) {
      throw new Error("Invalid application-timing statement")
    }
    const passage = source.passages.find(p => p.locator === statement.locator)
    if (!passage || !normalized(passage.text).includes(normalized(statement.quote))) throw new Error("Application-timing quote failed source verification")
    const key = `${statement.locator}\n${normalized(statement.quote)}`
    if (seen.has(key)) throw new Error("Duplicate timing quotation")
    seen.add(key)
  }
  return result
}

export function validateDeadlineConfirmation(output: string): DeadlineConfirmation {
  const result = parse(output)
  if (!result || typeof result.confirmed !== "boolean" || typeof result.explanation !== "string" || !result.explanation.trim()
      || Object.keys(result).some(k => !["confirmed", "explanation"].includes(k))) throw new Error("Invalid deadline confirmation")
  return result
}
