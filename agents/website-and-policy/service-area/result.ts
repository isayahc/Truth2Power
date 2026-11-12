import type { ReviewSource } from "../../shared/review-sources.ts"
import type { ServiceAreaReading } from "./validate.ts"
import type { ServiceAreaReference } from "./reference.ts"

export const criterion = "posted_materials.primary_service_area_boundaries_compliant"
export type GeographicReading = { taskId: string; source: ReviewSource; reading: ServiceAreaReading }

export function determineServiceArea(readings: GeographicReading[], reference: ServiceAreaReference | undefined, gaps: string[]) {
  const observations = readings.flatMap(({ taskId, source, reading }) => reading.observations.map(observation => ({
    taskId, sourceUrl: source.snapshot.sourceUrl, roles: source.roles, ...observation,
  })))
  const required = new Set(reference?.requiredCounties.map(c => c.toLocaleLowerCase("en-US").trim()) ?? [])
  const comparisons = observations.filter(o => o.serviceType === "medically_necessary" && o.completeCountyList && o.roles.includes("policy_statement"))
    .map(o => ({ taskId: o.taskId, sourceUrl: o.sourceUrl, publishedCounties: o.areas,
      missingRequiredCounties: [...required].filter(c => !o.areas.some(a => a.toLocaleLowerCase("en-US").trim() === c)) }))
  // Existing project grading keeps real service-area decisions unresolved until
  // rule applicability is approved. Preserve observations and any provisional
  // county comparisons without turning them into an unsupported legal verdict.
  return {
    criterion, value: null, result: "unclear", reason_code: "insufficient_evidence",
    explanation: reference?.status === "verified"
      ? "Published geography and source-verified reference data were compared; authority applicability and complete boundary review remain unresolved."
      : "Published geographic eligibility was reviewed, but an applicable facility-specific service-area authority is missing or invalid.",
    expected: { required_counties: "applicable_facility_reference" }, observations, comparisons,
    evidence: readings.flatMap(({ taskId, source, reading }) => reading.observations.flatMap(o => o.evidence.map(c => ({
      snapshot_id: source.snapshot.snapshot_id, sourceUrl: source.snapshot.sourceUrl, finalUrl: source.snapshot.finalUrl,
      sha256: source.snapshot.sha256, retrievedAt: source.snapshot.retrievedAt, locator: c.locator, quote: c.quote,
      taskId, serviceType: o.serviceType,
    })))),
    reference: reference ?? { status: "missing", requiredCounties: [], evidence: [], limitations: ["Reference task failed"] },
    limitations: [...gaps, ...(reference?.limitations ?? []), ...readings.flatMap(r => r.reading.limitations)],
    reviewStatus: "draft-human-review-pending",
  }
}
