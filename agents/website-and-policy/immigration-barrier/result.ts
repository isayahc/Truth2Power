import type { ReviewSource } from "../../shared/review-sources.ts"
import type { ImmigrationReading, ImmigrationDecision } from "./validate.ts"

export const criterion = "posted_materials.no_immigration_status_barrier"
export type ImmigrationReview = { taskId: string; source: ReviewSource; reading: ImmigrationReading }
export type ImmigrationConfirmation = { reviewTaskId: string; taskId: string; decisions: ImmigrationDecision[] }

export function determineImmigrationBarrier(reviews: ImmigrationReview[], confirmations: ImmigrationConfirmation[], gaps: string[]) {
  const observations = reviews.flatMap(review => review.reading.statements.map((statement, index) => {
    const confirmation = confirmations.find(c => c.reviewTaskId === review.taskId)
    const decision = confirmation?.decisions.find(d => d.index === index)
    const recognizedRole = review.source.roles.some(role => ["application", "policy_statement", "policy_summary", "landing_page", "supplement", "online_application"].includes(role))
    return { ...statement, taskId: review.taskId, sourceUrl: review.source.snapshot.sourceUrl,
      recognizedRole, confirmationTaskId: decision ? confirmation!.taskId : null, confirmation: decision ?? null }
  }))
  const restrictions = observations.filter(o => o.kind === "status_barrier" && o.recognizedRole && o.confirmation?.confirmed)
  const favorable = observations.filter(o => o.kind === "regardless_of_status" && o.recognizedRole && o.confirmation?.confirmed)
  const uncertain = observations.some(o => o.kind === "ambiguous" || !o.recognizedRole || !o.confirmation?.confirmed)
  const limitations = [...gaps, ...reviews.flatMap(r => r.reading.limitations)]
  if (uncertain) limitations.push("Ambiguous, unconfirmed or unclassified-source immigration provisions require review.")
  const value = restrictions.length ? false : favorable.length && !uncertain && !limitations.length ? true : null
  const evidence = reviews.flatMap(review => review.reading.statements.map((statement, index) => {
    const confirmation = confirmations.find(c => c.reviewTaskId === review.taskId)
    const decision = confirmation?.decisions.find(d => d.index === index)
    return { snapshot_id: review.source.snapshot.snapshot_id, sourceUrl: review.source.snapshot.sourceUrl,
      finalUrl: review.source.snapshot.finalUrl, sha256: review.source.snapshot.sha256, retrievedAt: review.source.snapshot.retrievedAt,
      locator: statement.locator, quote: statement.quote, kind: statement.kind, taskId: review.taskId,
      confirmationTaskId: decision ? confirmation!.taskId : null, interpretationConfirmed: decision?.confirmed ?? false }
  }))
  return {
    criterion, value, result: value === true ? "yes" : value === false ? "no" : "unclear",
    reason_code: value === true ? "condition_met" : value === false ? "contradicted" : "insufficient_evidence",
    explanation: value === false
      ? "An explicit immigration-based aid restriction has source-matched evidence and separate model confirmation; interpretation remains a draft."
      : value === true
        ? "Explicit immigration-neutral financial-assistance eligibility is confirmed with no supplied coverage gaps or unresolved provisions."
        : "Immigration-neutral aid eligibility cannot be established across all applicable materials; coverage gaps or uncertain provisions remain.",
    expected: { immigration_eligibility: "regardless_of_status" }, observations, evidence, limitations,
    reviewStatus: "draft-human-review-pending",
  }
}
