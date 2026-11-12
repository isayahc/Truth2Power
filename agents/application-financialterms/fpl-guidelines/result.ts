import type { ReviewSource } from "../../shared/review-sources.ts"
import type { FplReading } from "./validate.ts"
import type { FplReference } from "./reference.ts"
export const criterion = "application.fpl_guidelines"
export type FplReview = { taskId: string; source: ReviewSource; reading: FplReading }
export function determineFplGuidelines(reviews: FplReview[], applicationIds: string[], reference: FplReference | undefined, gaps: string[]) {
  const applications = applicationIds.map(sha256 => {
    const review = reviews.find(r => r.source.snapshot.sha256 === sha256 && r.source.roles.includes("application"))
    const reading = review?.reading
    const cells = reading && reference ? reading.rows.flatMap(row => row.dollars.map((observed, i) => ({
      household: row.household, percent: [200, 300, 400][i], observed,
      expected: reference.amounts[row.household - 1] * [2, 3, 4][i], locator: row.locator, quote: row.quote,
    }))) : []
    const outdated = !!reference && !!reading?.year && reading.year.value !== reference.year
    const mismatch = cells.some(c => c.observed !== c.expected)
    const complete = cells.length === 24 && reading?.year?.value === reference?.year
    const value = reference && (outdated || mismatch) ? false : reference && complete && !reading!.limitations.length ? true : null
    return { sha256, sourceUrl: review?.source.snapshot.sourceUrl, taskId: review?.taskId,
      publishedYear: reading?.year?.value ?? null, yearEvidence: reading?.year ?? null, outdated, cells, value }
  })
  const value = applications.some(a => a.value === false) ? false
    : applications.length && applications.every(a => a.value === true) ? true : null
  return { criterion, value, result: value === false ? "no" : value === true ? "yes" : "unclear",
    reason_code: value === false ? "contradicted" : value === true ? "condition_met" : "insufficient_evidence",
    explanation: value === false ? "At least one reviewed application publishes a different FPL year or dollar amount from the assessment-year reference."
      : value === true ? "All reviewed applications match the reference year and all 24 required income cells."
      : "The reference, printed year or complete household/percentage evidence could not be verified.",
    reference: reference ?? null, applications,
    evidence: reviews.flatMap(r => [r.reading.year, r.reading.header, ...r.reading.rows].filter(c => c != null).map(c => ({
      locator: c!.locator, quote: c!.quote, sourceUrl: r.source.snapshot.sourceUrl, sha256: r.source.snapshot.sha256,
      snapshot_id: r.source.snapshot.snapshot_id, retrievedAt: r.source.snapshot.retrievedAt, taskId: r.taskId,
    }))),
    limitations: [...gaps, ...reviews.flatMap(r => r.reading.limitations),
      "Assessment uses the pinned annual USD reference for the contiguous US. Results are scoped to saved English/Spanish applications; no inference about other languages.",
      "The model identifies the table and row relationships; exact quotations and local arithmetic do not independently verify those interpretations."],
    reviewStatus: "draft-human-review-pending" }
}
