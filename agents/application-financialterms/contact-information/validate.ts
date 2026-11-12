import type { ReviewSource } from "../../shared/review-sources.ts"
export type Contact = { type: "telephone" | "email" | "url" | "office"; value: string;
  organization: "hospital" | "advocate"; locator: string; quote: string; explanation?: string }
export type ContactReading = { contacts: Contact[]; limitations: string[] }
export type ContactDecision = { index: number; confirmed: boolean; explanation: string }
const normalize = (text: string) => text.normalize("NFC").replace(/\s+/g, " ").trim()
export function contactKey(contact: Pick<Contact, "type" | "value">) {
  // Preserve extension digits; do not equate a switchboard with an extension.
  return `${contact.type}:${contact.type === "telephone" ? contact.value.replace(/\D/g, "") : normalize(contact.value).toLowerCase()}`
}
function parse(output: string): any {
  const text = output.replace(/<thinking>[\s\S]*?<\/thinking>/g, "").trim()
  try { return JSON.parse(text.slice(text.indexOf("{"), text.lastIndexOf("}") + 1)) }
  catch { throw new Error("Contact agent returned invalid JSON") }
}
export function validateContactReading(output: string, source: ReviewSource): ContactReading {
  const result = parse(output)
  if (!result || !Array.isArray(result.contacts) || !Array.isArray(result.limitations)
      || result.limitations.some((v: any) => typeof v !== "string")
      || Object.keys(result).some(k => !["contacts", "limitations"].includes(k))) throw new Error("Invalid contact reading")
  const seen = new Set<string>()
  for (const contact of result.contacts) {
    if (!contact || !["telephone", "email", "url", "office"].includes(contact.type)
        || !["hospital", "advocate"].includes(contact.organization)
        || typeof contact.value !== "string" || !contact.value.trim()
        || typeof contact.quote !== "string" || normalize(contact.quote).length < 12
        || (contact.explanation !== undefined && (typeof contact.explanation !== "string" || !contact.explanation.trim()))
        || Object.keys(contact).some(k => !["type", "value", "organization", "locator", "quote", "explanation"].includes(k))) throw new Error("Invalid contact schema")
    const passage = source.passages.find(p => p.locator === contact.locator)
    if (!passage || !normalize(passage.text).includes(normalize(contact.quote))
        || !normalize(contact.quote).includes(normalize(contact.value))) throw new Error("Contact quotation or value failed source verification")
    if (contact.type === "telephone" && !/^(?:\+?1[ .-]?)?\(?[2-9]\d{2}\)?[ .-]?\d{3}[ .-]?\d{4}(?:\s*(?:ext\.?|x|extension)\s*\d{1,6})?$/i.test(contact.value.trim())) throw new Error("Unusable telephone format")
    if (contact.type === "email" && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(contact.value)) throw new Error("Unusable email format")
    if (contact.type === "url") {
      let url: URL
      try { url = new URL(contact.value) } catch { throw new Error("Unusable URL format") }
      if (!["http:", "https:"].includes(url.protocol) || url.username || url.password) throw new Error("Unusable URL format")
    }
    if (contact.type === "office" && (contact.value.trim().length < 12 || !/\d/.test(contact.value))) throw new Error("Office contact lacks a usable location")
    const key = `${contact.locator}:${contactKey(contact)}`
    if (seen.has(key)) throw new Error("Duplicate contact")
    seen.add(key)
  }
  return result
}
export function validateContactDecisions(output: string, count: number): ContactDecision[] {
  const result = parse(output)
  if (!result || !Array.isArray(result.decisions) || Object.keys(result).some(k => k !== "decisions")) throw new Error("Invalid contact confirmation")
  const seen = new Set<number>()
  for (const d of result.decisions) {
    if (!d || !Number.isInteger(d.index) || d.index < 0 || d.index >= count || seen.has(d.index)
        || typeof d.confirmed !== "boolean" || typeof d.explanation !== "string" || !d.explanation.trim()
        || Object.keys(d).some(k => !["index", "confirmed", "explanation"].includes(k))) throw new Error("Invalid contact confirmation index or decision")
    seen.add(d.index)
  }
  if (seen.size !== count) throw new Error("Contact confirmation omitted candidates")
  return result.decisions
}
