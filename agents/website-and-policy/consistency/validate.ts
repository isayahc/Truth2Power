import type { Comparison, ConsistencySource } from "./types.ts"

function parse(output: string): any {
  const text = output.replace(/<thinking>[\s\S]*?<\/thinking>/g, "").trim()
  try { return JSON.parse(text.slice(text.indexOf("{"), text.lastIndexOf("}") + 1)) }
  catch { throw new Error("Consistency agent returned invalid JSON") }
}
const strings = (value: any): value is string[] => Array.isArray(value) && value.every(v => typeof v === "string" && v.trim())
const normalized = (text: string) => text.normalize("NFC").replace(/\s+/g, " ").trim()

export function validateComparison(output: string, sources: ConsistencySource[]): Comparison {
  const result = parse(output)
  if (!result || !strings(result.comparedSourceIds) || !Array.isArray(result.conflicts) || result.conflicts.length > 3
      || !strings(result.limitations) || Object.keys(result).some(k => !["comparedSourceIds", "conflicts", "limitations"].includes(k))) {
    throw new Error("Invalid consistency comparison schema")
  }
  const expected = new Set(sources.map(s => s.id))
  if (result.comparedSourceIds.length !== expected.size || new Set(result.comparedSourceIds).size !== expected.size
      || result.comparedSourceIds.some((id: string) => !expected.has(id))) throw new Error("Comparison omitted or invented sources")
  for (const conflict of result.conflicts) {
    if (!conflict || typeof conflict.topic !== "string" || !conflict.topic.trim()
        || typeof conflict.explanation !== "string" || !conflict.explanation.trim() || !Array.isArray(conflict.evidence)
        || Object.keys(conflict).some(k => !["topic", "explanation", "evidence"].includes(k))) throw new Error("Invalid conflict schema")
    const urls = new Set<string>()
    for (const citation of conflict.evidence) {
      if (!citation || typeof citation.quote !== "string" || normalized(citation.quote).length < 8
          || Object.keys(citation).some(k => !["sourceId", "locator", "quote"].includes(k))) throw new Error("Invalid conflict citation")
      const source = sources.find(s => s.id === citation.sourceId)
      const passage = source?.passages.find(p => p.locator === citation.locator)
      if (!source || !passage || !normalized(passage.text).includes(normalized(citation.quote))) throw new Error("Conflict quotation failed source verification")
      urls.add(source.snapshot.sourceUrl)
    }
    if (urls.size < 2) throw new Error("A cross-document conflict requires evidence from two different source URLs")
  }
  return result
}

export function validateConfirmation(output: string, conflictCount: number): { confirmed: number[]; limitations: string[] } {
  const result = parse(output)
  if (!result || !Array.isArray(result.confirmed) || !strings(result.limitations)
      || Object.keys(result).some(k => !["confirmed", "limitations"].includes(k))
      || new Set(result.confirmed).size !== result.confirmed.length
      || result.confirmed.some((i: any) => !Number.isInteger(i) || i < 0 || i >= conflictCount)) {
    throw new Error("Invalid conflict confirmation")
  }
  return result
}
