import type { ReviewSource } from "../../shared/review-sources.ts"
import { boundedDiscoveryGap } from "../../shared/review-sources.ts"
import type { ServiceAreaReading } from "./validate.ts"
import type { ServiceAreaReference } from "./reference.ts"

export const criterion = "posted_materials.primary_service_area_boundaries_compliant"
export type GeographicReading = { taskId: string; source: ReviewSource; reading: ServiceAreaReading }

export function determineServiceArea(readings: GeographicReading[], reference: ServiceAreaReference | undefined, gaps: string[]) {
  const observations = readings.flatMap(({ taskId, source, reading }) => reading.observations.map(observation => ({
    taskId, sourceUrl: source.snapshot.sourceUrl, roles: source.roles, ...observation,
  })))
  const required = new Set(reference?.requiredCounties.map(c => c.toLocaleLowerCase("en-US").trim()) ?? [])
  const comparisons = observations.filter(o => o.serviceType === "medically_necessary" && o.geographyType === "county" && o.completeCountyList && o.roles.includes("policy_statement"))
    .map(o => ({ taskId: o.taskId, sourceUrl: o.sourceUrl, publishedCounties: o.areas,
      missingRequiredCounties: [...required].filter(c => !o.areas.some(a => a.toLocaleLowerCase("en-US").trim() === c)) }))
  const explicitBoundaries = observations.some(o => o.serviceType === "medically_necessary" &&
    ["county", "zip_code"].includes(o.geographyType))
  const completeReview = readings.length > 0 && readings.some(r => r.source.roles.includes("policy_statement")) &&
    gaps.filter(gap => gap !== boundedDiscoveryGap).length === 0 &&
    readings.every(r => r.source.passages.length > 0 && r.reading.limitations.length === 0)
  const missingBoundaries = completeReview && !explicitBoundaries
  // Disclosure is necessary but does not establish that the boundaries themselves
  // meet all applicable requirements. Missing authority cannot excuse clear omission.
  return {
    criterion, value: missingBoundaries ? false : null, result: missingBoundaries ? "not_met" : "unclear",
    reason_code: missingBoundaries ? "primary_service_boundaries_not_disclosed" : "insufficient_evidence",
    explanation: missingBoundaries
      ? "Within the saved sources reviewed, including the policy statement, the materials do not explicitly identify counties or ZIP codes primarily served for non-emergency financial assistance. This criterion is not met in that reviewed scope. Emergency-only geography, broad regions and mailing addresses do not satisfy this requirement."
      : reference?.status === "verified"
      ? "Published geography and source-verified reference data were compared; authority applicability and complete boundary review remain unresolved."
      : "Published geographic eligibility was reviewed, but an applicable facility-specific service-area authority is missing or invalid.",
    expected: { required_counties: "applicable_facility_reference" }, observations, comparisons,
    disclosure: { explicit_counties_or_zip_codes: explicitBoundaries, complete_source_review: completeReview },
    reviewed_sources: readings.map(({taskId,source}) => ({taskId, sourceUrl:source.snapshot.sourceUrl,
      sha256:source.snapshot.sha256, retrievedAt:source.snapshot.retrievedAt, locators:source.passages.map(p=>p.locator)})),
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
