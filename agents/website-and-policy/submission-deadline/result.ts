import type { ReviewSource } from "../../shared/review-sources.ts"
import type { DeadlineReading, DeadlineConfirmation } from "./validate.ts"

export const criterion = "posted_materials.no_submission_time_limit"
export type TimingReview = { taskId: string; source: ReviewSource; reading: DeadlineReading }
export type ConfirmedTiming = { reviewTaskId: string; statementIndex: number; taskId: string; result: DeadlineConfirmation }

export function determineSubmissionDeadline(reviews: TimingReview[], confirmations: ConfirmedTiming[], gaps: string[]) {
  const observations = reviews.flatMap(review => review.reading.statements.map((statement, statementIndex) => {
    const confirmation = confirmations.find(c => c.reviewTaskId === review.taskId && c.statementIndex === statementIndex)
    return { ...statement, taskId: review.taskId, sourceUrl: review.source.snapshot.sourceUrl,
      confirmationTaskId: confirmation?.taskId ?? null, confirmation: confirmation?.result ?? null,
      recognizedRole: review.source.roles.some(role => ["application", "policy_statement", "policy_summary", "landing_page", "supplement", "online_application"].includes(role)) }
  }))
  const restrictions = observations.filter(o => o.kind === "submission_deadline" && o.recognizedRole && o.confirmation?.confirmed)
  const favorable = observations.filter(o => o.kind === "any_time" && o.recognizedRole)
  const limitations = [...gaps, ...reviews.flatMap(r => r.reading.limitations)]
  const uncertain = observations.some(o => o.kind === "ambiguous" || (o.kind === "submission_deadline" && !restrictions.includes(o)))
  if (uncertain) limitations.push("Ambiguous or unconfirmed application-timing statements require review.")
  const value = restrictions.length ? false : favorable.length && !uncertain && !limitations.length ? true : null
  return {
    criterion, value, result: value === true ? "yes" : value === false ? "no" : "unclear",
    reason_code: value === true ? "condition_met" : value === false ? "contradicted" : "insufficient_evidence",
    explanation: value === false
      ? "An explicit application submission restriction has source-verified quotations and a separate model confirmation; interpretation remains a draft."
      : value === true
        ? "Explicit unrestricted application timing is supported with complete supplied coverage and no unresolved restrictions."
        : "Available timing evidence does not establish an unrestricted application window across all applicable materials; gaps or ambiguities remain.",
    expected: { application_submission: "any_time" }, observations, limitations,
    evidence: reviews.flatMap(review => review.reading.statements.map((statement, i) => {
      const confirmation = confirmations.find(c => c.reviewTaskId === review.taskId && c.statementIndex === i)
      return { snapshot_id: review.source.snapshot.snapshot_id, locator: statement.locator, quote: statement.quote,
        sourceUrl: review.source.snapshot.sourceUrl, finalUrl: review.source.snapshot.finalUrl,
        sha256: review.source.snapshot.sha256, retrievedAt: review.source.snapshot.retrievedAt,
        kind: statement.kind, taskId: review.taskId, confirmationTaskId: confirmation?.taskId ?? null }
    })),
    reviewStatus: "draft-human-review-pending",
  }
}
