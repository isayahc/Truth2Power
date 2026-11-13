import type { ReviewSource } from "../../shared/review-sources.ts"
import type { IncomeReading } from "./validate.ts"
export const criterion = "policy_summary.income_levels_included"
export type IncomeReview = { taskId: string; source: ReviewSource; reading: IncomeReading }
export type IncomeSource = Pick<ReviewSource, "snapshot" | "roles">
export function determineIncomeLevels(reviews: IncomeReview[], sources: IncomeSource[], gaps: string[]) {
  const findings = sources.map(source => {
    const sourceKind = source.roles.includes("policy_summary") ? "summary" : "webpage"
    const review = reviews.find(r => r.source.snapshot.sha256 === source.snapshot.sha256
      && r.source.snapshot.sourceUrl === source.snapshot.sourceUrl && r.source.roles.includes(sourceKind === "summary" ? "policy_summary" : "landing_page"))
    const reading = review?.reading
    return { sourceKind, sourceUrl: source.snapshot.sourceUrl, sha256: source.snapshot.sha256,
      taskId: review?.taskId, readingStatus: reading ? "validated" : "unresolved",
      value: reading && reading.levels.length > 0 && !reading.limitations.length ? true : null,
      levels: reading?.levels ?? [], limitations: reading?.limitations ?? [] }
  })
  const summaries = findings.filter(f => f.sourceKind === "summary")
  const webpages = findings.filter(f => f.sourceKind === "webpage")
  const value = summaries.length > 0 && summaries.every(s => s.value === true) ? true : null
  return { criterion, value, result: value === true ? "yes" : "unclear",
    reason_code: value === true ? "condition_met" : "insufficient_evidence",
    explanation: value === true ? "Every identified summary states an explicit assistance income level."
      : "An explicit assistance income level is not verified in every identified summary.",
    expected: { minimum_stated_income_levels: 1 }, summaries, webpages,
    evidence: reviews.flatMap(r => r.reading.levels.map(level => ({ ...level,
      sourceKind: r.source.roles.includes("policy_summary") ? "summary" : "webpage",
      sourceUrl: r.source.snapshot.sourceUrl, sha256: r.source.snapshot.sha256,
      snapshot_id: r.source.snapshot.snapshot_id, retrievedAt: r.source.snapshot.retrievedAt, taskId: r.taskId }))),
    limitations: [...gaps, ...findings.flatMap(f => f.limitations),
      "English/Spanish summaries and live assistance landing page; one reading per source, no retries. Webpage evidence does not substitute for designated-summary evidence.",
      "Presence of income levels does not establish current FPL accuracy, legal sufficiency or translation equivalence. Silence and failed readings remain unresolved."],
    reviewStatus: "draft-human-review-pending" }
}
