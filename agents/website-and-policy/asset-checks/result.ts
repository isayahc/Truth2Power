import type { ReviewSource } from "../../shared/review-sources.ts"
import type { AssetReading, AssetDecision } from "./validate.ts"

export const criterion = "posted_materials.no_evidence_of_asset_checks"
export type AssetReview = { taskId: string; source: ReviewSource; reading: AssetReading }
export type AssetConfirmation = { reviewTaskId: string; taskId: string; decisions: AssetDecision[] }

export function determineAssetChecks(reviews: AssetReview[], confirmations: AssetConfirmation[], gaps: string[]) {
  const observations = reviews.flatMap(review => review.reading.statements.map((statement, index) => {
    const confirmation = confirmations.find(c => c.reviewTaskId === review.taskId)
    const decision = confirmation?.decisions.find(d => d.index === index)
    const recognizedRole = review.source.roles.some(role => ["application", "policy_statement", "policy_summary", "landing_page", "supplement", "online_application"].includes(role))
    return { ...statement, taskId: review.taskId, sourceUrl: review.source.snapshot.sourceUrl,
      recognizedRole, confirmationTaskId: decision ? confirmation!.taskId : null, confirmation: decision ?? null }
  }))
  const restrictions = observations.filter(o => o.kind === "asset_test" && o.recognizedRole && o.confirmation?.confirmed)
  const favorable = observations.filter(o => o.kind === "no_asset_test" && o.recognizedRole && o.confirmation?.confirmed)
  const uncertain = observations.some(o => o.kind === "ambiguous" || !o.recognizedRole || !o.confirmation?.confirmed)
  const limitations = [...gaps, ...reviews.flatMap(r => r.reading.limitations)]
  if (uncertain) limitations.push("Ambiguous, unconfirmed or unclassified-source asset statements require review.")
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
      ? "An explicit asset eligibility condition has source-matched evidence and separate model confirmation; interpretation remains a draft."
      : value === true
        ? "Explicit exclusion of asset tests is confirmed with no supplied coverage gaps or unresolved asset provisions."
        : "An absence of asset-based eligibility checks cannot be established across the applicable materials; coverage gaps or uncertain provisions remain.",
    expected: { eligibility_asset_test: "no_asset_test" }, observations, evidence, limitations,
    reviewStatus: "draft-human-review-pending",
  }
}
