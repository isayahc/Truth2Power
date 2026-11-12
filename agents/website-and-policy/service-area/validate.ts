import type { ReviewSource } from "../../shared/review-sources.ts"

export type ServiceAreaReading = {
  observations: { serviceType: "emergency" | "medically_necessary" | "unspecified"; areas: string[];
    completeCountyList: boolean; evidence: { locator: string; quote: string }[] }[]
  limitations: string[]
}
export const normalized = (text: string) => text.normalize("NFC").replace(/\s+/g, " ").trim()

export function validateServiceArea(output: string, source: ReviewSource): ServiceAreaReading {
  const text = output.replace(/<thinking>[\s\S]*?<\/thinking>/g, "").trim()
  let result: any
  try { result = JSON.parse(text.slice(text.indexOf("{"), text.lastIndexOf("}") + 1)) }
  catch { throw new Error("Service-area agent returned invalid JSON") }
  if (!result || !Array.isArray(result.observations) || !Array.isArray(result.limitations)
      || result.limitations.some((v: any) => typeof v !== "string")
      || Object.keys(result).some(k => !["observations", "limitations"].includes(k))) throw new Error("Invalid service-area reading")
  for (const observation of result.observations) {
    if (!observation || !["emergency", "medically_necessary", "unspecified"].includes(observation.serviceType)
        || typeof observation.completeCountyList !== "boolean" || !Array.isArray(observation.areas) || !observation.areas.length
        || observation.areas.some((a: any) => typeof a !== "string" || !a.trim())
        || !Array.isArray(observation.evidence) || !observation.evidence.length
        || Object.keys(observation).some(k => !["serviceType", "completeCountyList", "areas", "evidence"].includes(k))) {
      throw new Error("Invalid geographic observation")
    }
    for (const citation of observation.evidence) {
      const passage = source.passages.find(p => p.locator === citation?.locator)
      if (!passage || typeof citation.quote !== "string" || normalized(citation.quote).length < 8
          || Object.keys(citation).some(k => !["locator", "quote"].includes(k))
          || !normalized(passage.text).includes(normalized(citation.quote))) throw new Error("Geographic quotation failed source verification")
    }
    if (observation.areas.some((area: string) => !observation.evidence.some((e: any) => normalized(e.quote).includes(normalized(area))))) {
      throw new Error("Geographic name is not supported by the quoted evidence")
    }
  }
  return result
}
