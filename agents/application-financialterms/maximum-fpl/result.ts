import type { ReviewSource } from "../../shared/review-sources.ts"
import type { MaximumReading } from "./validate.ts"
export const criterion = "application.maximum_fpl"
export type MaximumReview = { taskId: string; source: ReviewSource; reading: MaximumReading }
export function determineMaximumFpl(reviews: MaximumReview[], applicationIds: string[], gaps: string[]) {
  const applications = applicationIds.map(sha256 => {
    const review = reviews.find(r => r.source.snapshot.sha256 === sha256 && r.source.roles.includes("application"))
    const reading = review?.reading
    const supportive = reading?.limits.filter(l => l.kind === "eligibility" && l.scope === "general" && l.percent >= 400) ?? []
    const lowerCeilings = reading?.limits.filter(l => l.kind === "hard_ceiling" && l.percent < 400) ?? []
    const lowerEligibility = reading?.limits.some(l => l.kind === "eligibility" && l.percent < 400) ?? false
    const uncertain = !reading || !!reading.limitations.length || lowerEligibility
    const contradictory = supportive.length > 0 && lowerCeilings.length > 0
    const generalCeiling = lowerCeilings.some(l => l.scope === "general")
    const value = contradictory || uncertain ? null : generalCeiling ? false
      : supportive.length && !lowerCeilings.length ? true : null
    return { sha256, sourceUrl: review?.source.snapshot.sourceUrl, taskId: review?.taskId, value,
      limits: reading?.limits ?? [], conditions: reading?.conditions ?? [],
      limitations: [...(reading?.limitations ?? []), ...(contradictory ? ["Eligibility and lower ceiling conflict."] : []),
        ...(lowerEligibility ? ["Lower eligibility wording needs reconciliation; it is not automatically a hard ceiling."] : [])] }
  })
  const value = applications.some(a => a.value === false) ? false
    : applications.length && applications.every(a => a.value === true) ? true : null
  return { criterion, value, result: value === false ? "no" : value === true ? "yes" : "unclear",
    reason_code: value === false ? "contradicted" : value === true ? "condition_met" : "insufficient_evidence",
    explanation: value === true ? "Each identified application explicitly states general financial-assistance eligibility through at least 400% FPL, with no extracted unresolved lower limit."
      : value === false ? "An application explicitly imposes a general hard ceiling below 400% FPL."
      : "Explicit eligibility through 400% FPL is missing, unverified or requires reconciliation with other provisions.",
    expected: { minimum_percent: 400 }, applications,
    evidence: reviews.flatMap(r => [...r.reading.limits, ...r.reading.conditions].map(c => ({
      locator: c.locator, quote: c.quote, sourceUrl: r.source.snapshot.sourceUrl, sha256: r.source.snapshot.sha256,
      snapshot_id: r.source.snapshot.snapshot_id, retrievedAt: r.source.snapshot.retrievedAt, taskId: r.taskId,
    }))),
    limitations: [...gaps, ...applications.flatMap(a => a.limitations),
      "Scoped to identified saved English/Spanish applications. One model interpretation per application; quotations and percentages are validated locally.",
      "Eligibility wording does not establish current FPL dollar values or eligibility for every patient irrespective of qualifying conditions."],
    reviewStatus: "draft-human-review-pending" }
}
