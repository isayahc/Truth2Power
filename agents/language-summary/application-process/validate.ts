import type { ReviewSource } from "../../shared/review-sources.ts"
export type ProcessInstruction = { action: "obtain" | "complete" | "provide_documents" | "submit" | "get_help";
  route: "postal" | "in_person" | "email" | "online" | "telephone" | "unspecified";
  destination: string | null; locator: string; quote: string }
export type ProcessReading = { instructions: ProcessInstruction[]; limitations: string[] }
const normalize = (s: string) => s.normalize("NFC").replace(/\s+/g, " ").trim()
export function validateProcessReading(output: string, source: ReviewSource): ProcessReading {
  const text = output.replace(/<thinking>[\s\S]*?<\/thinking>/g, "").trim()
  let result: any
  try { result = JSON.parse(text.slice(text.indexOf("{"), text.lastIndexOf("}") + 1)) }
  catch { throw new Error("Application-process agent returned invalid JSON") }
  if (!result || !Array.isArray(result.instructions) || !Array.isArray(result.limitations)
      || result.limitations.some((s: any) => typeof s !== "string")
      || Object.keys(result).some(k => !["instructions", "limitations"].includes(k))) throw new Error("Invalid application-process schema")
  const seen = new Set<string>()
  for (const i of result.instructions) {
    if (!i || typeof i !== "object") throw new Error("Invalid application instruction: expected object")
    if (!["obtain", "complete", "provide_documents", "submit", "get_help"].includes(i.action)) throw new Error("Invalid application instruction: action")
    if (!["postal", "in_person", "email", "online", "telephone", "unspecified"].includes(i.route)) throw new Error("Invalid application instruction: route")
    if (i.destination !== null && (typeof i.destination !== "string" || !i.destination.trim())) throw new Error("Invalid application instruction: destination")
    if (typeof i.quote !== "string" || normalize(i.quote).length < 8) throw new Error("Invalid application instruction: quote")
    if (Object.keys(i).some(k => !["action", "route", "destination", "locator", "quote"].includes(k))) throw new Error("Invalid application instruction: unexpected field")
    const page = source.passages.find(p => p.locator === i.locator)
    if (!page || !normalize(page.text).includes(normalize(i.quote))) throw new Error("Application instruction quotation failed source verification")
    if (i.destination !== null && !normalize(i.quote).includes(normalize(i.destination))) throw new Error("Submission destination not supported by quotation")
    const key = `${i.action}:${i.locator}:${normalize(i.quote)}`
    if (seen.has(key)) throw new Error("Duplicate application instruction")
    seen.add(key)
  }
  return result
}
