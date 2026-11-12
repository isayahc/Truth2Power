import type { ReviewSource } from "../../shared/review-sources.ts"
import type { ProcessReading, ProcessInstruction } from "./validate.ts"
export const criterion = "policy_summary.means_of_applying_explained"
export type ProcessReview = { taskId: string; source: ReviewSource; reading: ProcessReading }
export function actionableSubmission(i: ProcessInstruction) {
  if (i.action !== "submit" || !i.destination || i.route === "unspecified") return false
  if (i.route === "email") return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(i.destination)
  if (i.route === "online") return /^(?:https?:\/\/|www\.)[^\s]+\.[^\s]+$/i.test(i.destination)
  if (i.route === "telephone") return i.destination.replace(/\D/g, "").length >= 10
  return i.destination.trim().length >= 12 && /\d/.test(i.destination)
}
export function determineApplicationProcess(reviews: ProcessReview[], summaryIds: string[], gaps: string[], websiteSources: Pick<ReviewSource, "snapshot" | "roles">[] = []) {
  const webpages = websiteSources.map(({ snapshot }) => {
    const review = reviews.find(r => r.source.roles.includes("landing_page") && r.source.snapshot.sha256 === snapshot.sha256)
    const reading = review?.reading
    const submissionRoutes = reading?.instructions.filter(actionableSubmission) ?? []
    return { sourceUrl: snapshot.sourceUrl, sha256: snapshot.sha256, taskId: review?.taskId,
      readingStatus: reading ? "validated" : "unresolved",
      value: submissionRoutes.length && !reading!.limitations.length ? true : null,
      instructions: reading?.instructions ?? [], submissionRoutes, limitations: reading?.limitations ?? [] }
  })
  const summaries = summaryIds.map(sha256 => {
    const review = reviews.find(r => r.source.snapshot.sha256 === sha256 && r.source.roles.includes("policy_summary"))
    const reading = review?.reading
    const routes = reading?.instructions.filter(actionableSubmission) ?? []
    return { sha256, sourceUrl: review?.source.snapshot.sourceUrl, taskId: review?.taskId,
      value: routes.length && !reading!.limitations.length ? true : null,
      instructions: reading?.instructions ?? [], submissionRoutes: routes, limitations: reading?.limitations ?? [] }
  })
  const value = summaries.length && summaries.every(s => s.value === true) ? true : null
  return { criterion, value, result: value === true ? "yes" : "unclear",
    reason_code: value === true ? "condition_met" : "insufficient_evidence",
    explanation: value === true ? "Every identified summary provides source-matched submission instructions and a usable destination."
      : "A usable submission route is not verified in every identified summary; download/help information alone does not establish it.",
    expected: { minimum_application_instructions: 1 }, summaries, webpages,
    evidence: reviews.flatMap(r => r.reading.instructions.map(i => ({ locator: i.locator, quote: i.quote, action: i.action,
      sourceKind: r.source.roles.includes("policy_summary") ? "summary" : "webpage", route: i.route, destination: i.destination,
      sourceUrl: r.source.snapshot.sourceUrl, sha256: r.source.snapshot.sha256, snapshot_id: r.source.snapshot.snapshot_id,
      retrievedAt: r.source.snapshot.retrievedAt, taskId: r.taskId }))),
    limitations: [...gaps, ...summaries.flatMap(s => s.limitations), ...webpages.flatMap(p => p.limitations),
      "Scoped to saved English/Spanish summaries and the live assistance landing page. One reading per source, no retries; quotations and destinations validated locally. Webpage findings corroborate but do not replace designated-summary evidence.",
      "Printed submission routes were not operationally tested. Failed extraction is not a demonstrated language discrepancy or absence finding."],
    reviewStatus: "draft-human-review-pending" }
}
