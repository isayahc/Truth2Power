import type { ReviewSource } from "../../shared/review-sources.ts"
import type { SummaryAreaReading } from "./validate.ts"
export const criterion = "policy_summary.primary_service_area_described"
export type SummaryAreaReview = { taskId: string; source: ReviewSource; reading: SummaryAreaReading }
export function determineSummaryArea(reviews: SummaryAreaReview[], summaryIds: string[], gaps: string[]) {
  const summaries = summaryIds.map(sha256 => {
    const review = reviews.find(r => r.source.snapshot.sha256 === sha256 && r.source.roles.includes("policy_summary"))
    const reading = review?.reading
    const descriptions = reading?.descriptions ?? []
    const supported = descriptions.some(d => ["primary_service_area", "non_emergency", "all_services"].includes(d.scope))
    const unresolved = !reading || !!reading.limitations.length || descriptions.some(d => d.scope === "unclear")
    return { sha256, sourceUrl: review?.source.snapshot.sourceUrl, taskId: review?.taskId,
      value: supported && !unresolved ? true : null, descriptions, limitations: reading?.limitations ?? [] }
  })
  const value = summaries.length && summaries.every(s => s.value === true) ? true : null
  return { criterion, value, result: value === true ? "yes" : "unclear",
    reason_code: value === true ? "condition_met" : "insufficient_evidence",
    explanation: value === true ? "Each identified summary explicitly describes the primary/non-emergency service area or geographic aid coverage for all services."
      : "The primary service area is not verified in every identified summary; emergency-only geography, silence or failed readings do not establish it.",
    expected: { minimum_described_areas: 1 }, summaries,
    evidence: reviews.flatMap(r => r.reading.descriptions.map(d => ({ locator: d.locator, quote: d.quote,
      scope: d.scope, areas: d.areas, sourceUrl: r.source.snapshot.sourceUrl, sha256: r.source.snapshot.sha256,
      snapshot_id: r.source.snapshot.snapshot_id, retrievedAt: r.source.snapshot.retrievedAt, taskId: r.taskId }))),
    limitations: [...gaps, ...summaries.flatMap(s => s.limitations),
      "Scoped to identified saved English/Spanish summaries. One model reading per summary; quotations and geographic names validated locally.",
      "A described service area does not establish legally compliant boundaries or certified translation equivalence."],
    reviewStatus: "draft-human-review-pending" }
}
