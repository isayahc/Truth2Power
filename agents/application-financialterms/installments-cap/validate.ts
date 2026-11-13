import type { ReviewSource } from "../../shared/review-sources.ts"
export type InstallmentStatement = {
  kind: "payment_cap" | "interest_cap" | "explicitly_uncapped" | "ambiguous"
  percent: number | null
  basis: "gross_monthly_income" | "net_monthly_income" | "annual_income" | "unspecified" | "not_applicable"
  locator: string; quote: string
}
export type InstallmentReading = { statements: InstallmentStatement[]; limitations: string[] }
const normalize = (s: string) => s.normalize("NFC").replace(/\s+/g, " ").trim()
export function validateInstallmentReading(output: string, source: ReviewSource): InstallmentReading {
  const text = output.replace(/<thinking>[\s\S]*?<\/thinking>/g, "").trim()
  let result: any
  try { result = JSON.parse(text.slice(text.indexOf("{"), text.lastIndexOf("}") + 1)) }
  catch { throw new Error("Installment agent returned invalid JSON") }
  if (!result || !Array.isArray(result.statements) || !Array.isArray(result.limitations)
      || result.limitations.some((s: any) => typeof s !== "string")
      || Object.keys(result).some(k => !["statements", "limitations"].includes(k))) throw new Error("Invalid installment reading schema")
  const seen = new Set<string>()
  for (const s of result.statements) {
    if (!s || !["payment_cap", "interest_cap", "explicitly_uncapped", "ambiguous"].includes(s.kind)
        || !["gross_monthly_income", "net_monthly_income", "annual_income", "unspecified", "not_applicable"].includes(s.basis)
        || (s.percent !== null && (!Number.isFinite(s.percent) || s.percent < 0 || s.percent > 100))
        || (["payment_cap", "interest_cap"].includes(s.kind) && s.percent === null)
        || (s.kind === "explicitly_uncapped" && s.percent !== null)
        || typeof s.quote !== "string" || normalize(s.quote).length < 8
        || Object.keys(s).some(k => !["kind", "percent", "basis", "locator", "quote"].includes(k))) throw new Error("Invalid installment statement")
    const passage = source.passages.find(p => p.locator === s.locator)
    if (!passage || !normalize(passage.text).includes(normalize(s.quote))) throw new Error("Installment quotation failed source verification")
    if (s.percent !== null) {
      const printed = [...s.quote.matchAll(/(?<![\d.,])(\d+(?:[.,]\d+)?)\s*%/g)].map(m => Number(m[1].replace(",", ".")))
      if (!printed.includes(s.percent)) throw new Error("Installment percentage not supported by quotation")
    }
    const key = `${s.kind}:${s.locator}:${normalize(s.quote)}`
    if (seen.has(key)) throw new Error("Duplicate installment statement")
    seen.add(key)
  }
  return result
}
