import type { ReviewSource } from "../../shared/review-sources.ts"
type Citation = { locator: string; quote: string }
export type FplReading = { year: (Citation & { value: number }) | null; header: Citation | null;
  rows: (Citation & { household: number; amounts: string[]; dollars: number[] })[]; limitations: string[] }
const normalize = (text: string) => text.normalize("NFC").replace(/\s+/g, " ").trim()
function verify(citation: any, source: ReviewSource) {
  const page = source.passages.find(p => p.locator === citation?.locator)
  if (!page || typeof citation.quote !== "string" || normalize(citation.quote).length < 4
      || !normalize(page.text).includes(normalize(citation.quote))) throw new Error("FPL quotation failed source verification")
}
export function usd(text: string) {
  if (!/^\$?\s*(?:\d{1,3}(?:,\d{3})+|\d+)(?:\.00)?$/.test(text.trim())) throw new Error("Ambiguous annual USD amount")
  return Number(text.replace(/[$,\s]/g, ""))
}
export function validateFplReading(output: string, source: ReviewSource): FplReading {
  const text = output.replace(/<thinking>[\s\S]*?<\/thinking>/g, "").trim()
  let result: any
  try { result = JSON.parse(text.slice(text.indexOf("{"), text.lastIndexOf("}") + 1)) }
  catch { throw new Error("FPL agent returned invalid JSON") }
  if (!result || !Array.isArray(result.rows) || !Array.isArray(result.limitations)
      || result.limitations.some((s: any) => typeof s !== "string")
      || Object.keys(result).some(k => !["year", "header", "rows", "limitations"].includes(k))) throw new Error("Invalid FPL schema")
  const limitations = [...result.limitations]
  let year: FplReading["year"] = null
  let header: FplReading["header"] = null
  if (result.year != null) {
    verify(result.year, source)
    if (!Number.isInteger(result.year.value) || result.year.value < 2000 || result.year.value > 2100
        || !new RegExp(`\\b${result.year.value}\\b`).test(result.year.quote)
        || Object.keys(result.year).some(k => !["value", "locator", "quote"].includes(k))) throw new Error("Unsupported FPL year")
    year = result.year
  }
  if (result.header != null) {
    try {
      verify(result.header, source)
      if (![200, 300, 400].every(p => new RegExp(`${p}\\s*%`).test(result.header.quote))
          || Object.keys(result.header).some(k => !["locator", "quote"].includes(k))) throw new Error("Missing ordered FPL column headings")
      const positions = [200, 300, 400].map(p => result.header.quote.indexOf(String(p)))
      if (!(positions[0] < positions[1] && positions[1] < positions[2])) throw new Error("Unexpected FPL column order")
      header = result.header
    } catch (error: any) { limitations.push(error.message) }
  }
  const rows: FplReading["rows"] = []
  const counts = new Map<number, number>()
  for (const row of result.rows) counts.set(row?.household, (counts.get(row?.household) ?? 0) + 1)
  for (const row of result.rows) {
    try {
      verify(row, source)
      if (!header || !Number.isInteger(row.household) || row.household < 1 || row.household > 8 || counts.get(row.household) !== 1
          || !new RegExp(`(?:^|\\s)${row.household}(?:\\s|$)`).test(normalize(row.quote))
          || !Array.isArray(row.amounts) || row.amounts.length !== 3
          || Object.keys(row).some(k => !["household", "locator", "quote", "amounts"].includes(k))) throw new Error("Invalid or duplicate household row")
      let end = 0
      for (const amount of row.amounts) {
        if (typeof amount !== "string" || !amount.trim()) throw new Error("Missing amount")
        const offset = normalize(row.quote).indexOf(normalize(amount), end)
        if (offset < 0) throw new Error("Amounts not supported in quoted column order")
        end = offset + normalize(amount).length
      }
      rows.push({ ...row, dollars: row.amounts.map(usd) })
    } catch (error: any) { limitations.push(`Rejected household row ${row?.household ?? "unknown"}: ${error.message}`) }
  }
  if (!year) limitations.push("Printed FPL table year not verified.")
  if (!header) limitations.push("FPL column headings not verified; dollar comparisons withheld.")
  return { year, header, rows, limitations }
}
