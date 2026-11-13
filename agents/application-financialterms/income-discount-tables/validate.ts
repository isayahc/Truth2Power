import type { ReviewSource } from "../../shared/review-sources.ts"
type Citation = { locator: string; quote: string }
export type Table = { kind: "income" | "discount"; header: Citation;
  rows: (Citation & { values: string[] })[] }
export type TablesReading = { tables: Table[]; limitations: string[] }
export type TableDecision = { index: number; confirmed: boolean; explanation: string }
const normalize = (s: string) => s.normalize("NFC").replace(/\s+/g, " ").trim()
function parse(output: string): any {
  const text = output.replace(/<thinking>[\s\S]*?<\/thinking>/g, "").trim()
  try { return JSON.parse(text.slice(text.indexOf("{"), text.lastIndexOf("}") + 1)) }
  catch { throw new Error("Table agent returned invalid JSON") }
}
function verify(citation: any, source: ReviewSource) {
  const passage = source.passages.find(p => p.locator === citation?.locator)
  if (!passage || typeof citation.quote !== "string" || normalize(citation.quote).length < 8
      || !normalize(passage.text).includes(normalize(citation.quote))) throw new Error("Table quotation failed source verification")
}
export function validateTablesReading(output: string, source: ReviewSource): TablesReading {
  const result = parse(output)
  if (!result || !Array.isArray(result.tables) || !Array.isArray(result.limitations)
      || result.limitations.some((s: any) => typeof s !== "string")
      || Object.keys(result).some(k => !["tables", "limitations"].includes(k))) throw new Error("Invalid table reading schema")
  const kinds = new Set<string>()
  for (const table of result.tables) {
    if (!table || !["income", "discount"].includes(table.kind) || kinds.has(table.kind)
        || !Array.isArray(table.rows) || table.rows.length < 2
        || Object.keys(table).some(k => !["kind", "header", "rows"].includes(k))) throw new Error("Invalid or duplicate table")
    kinds.add(table.kind)
    verify(table.header, source)
    if (Object.keys(table.header).some(k => !["locator", "quote"].includes(k))) throw new Error("Invalid table header")
    const rows = new Set<string>()
    for (const row of table.rows) {
      verify(row, source)
      if (rows.has(normalize(row.quote)) || !Array.isArray(row.values)
          || row.values.length < (table.kind === "income" ? 2 : 1)
          || row.values.some((v: any) => typeof v !== "string" || !v.trim() || !normalize(row.quote).includes(normalize(v)))
          || new Set(row.values.map((v: string) => normalize(v))).size !== row.values.length
          || Object.keys(row).some(k => !["locator", "quote", "values"].includes(k))) throw new Error("Table cells or distinct rows lack quoted support")
      rows.add(normalize(row.quote))
    }
  }
  return result
}
export function validateTableDecisions(output: string, count: number): TableDecision[] {
  const result = parse(output)
  if (!result || !Array.isArray(result.decisions) || Object.keys(result).some(k => k !== "decisions")) throw new Error("Invalid table confirmation")
  const seen = new Set<number>()
  for (const d of result.decisions) {
    if (!d || !Number.isInteger(d.index) || d.index < 0 || d.index >= count || seen.has(d.index)
        || typeof d.confirmed !== "boolean" || typeof d.explanation !== "string" || !d.explanation.trim()
        || Object.keys(d).some(k => !["index", "confirmed", "explanation"].includes(k))) throw new Error("Invalid table confirmation index or decision")
    seen.add(d.index)
  }
  if (seen.size !== count) throw new Error("Table confirmation omitted candidates")
  return result.decisions
}
