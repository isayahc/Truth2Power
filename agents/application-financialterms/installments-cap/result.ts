import type { ReviewSource } from "../../shared/review-sources.ts"
import type { InstallmentReading } from "./validate.ts"
export const criterion = "application.installments_cap"
export type InstallmentReview = { taskId: string; source: ReviewSource; reading: InstallmentReading }
export function determineInstallmentCap(reviews: InstallmentReview[], applicationIds: string[], gaps: string[]) {
  const applications = applicationIds.map(sha256 => {
    const review = reviews.find(r => r.source.snapshot.sha256 === sha256 && r.source.roles.includes("application"))
    const reading = review?.reading
    const caps = reading?.statements.filter(s => s.kind === "payment_cap") ?? []
    const favorable = caps.filter(s => s.basis === "gross_monthly_income" && s.percent !== null && s.percent <= 5)
    const unfavorable = caps.filter(s => s.basis === "gross_monthly_income" && s.percent !== null && s.percent > 5)
    const uncapped = reading?.statements.some(s => s.kind === "explicitly_uncapped") ?? false
    const uncertain = !reading || !!reading.limitations.length || caps.some(s => s.basis !== "gross_monthly_income")
      || reading.statements.some(s => s.kind === "ambiguous")
    const conflict = favorable.length > 0 && (unfavorable.length > 0 || uncapped)
    const value = uncertain || conflict ? null : unfavorable.length || uncapped ? false : favorable.length ? true : null
    return { sha256, sourceUrl: review?.source.snapshot.sourceUrl, taskId: review?.taskId, value,
      statements: reading?.statements ?? [], limitations: [...(reading?.limitations ?? []),
        ...(conflict ? ["Payment cap conflicts with a higher or uncapped payment provision."] : []),
        ...(caps.some(s => s.basis !== "gross_monthly_income") ? ["Gross monthly income basis was not established for every payment cap."] : [])] }
  })
  const value = applications.some(a => a.value === false) ? false
    : applications.length && applications.every(a => a.value === true) ? true : null
  return { criterion, value, result: value === false ? "no" : value === true ? "yes" : "unclear",
    reason_code: value === false ? "contradicted" : value === true ? "condition_met" : "insufficient_evidence",
    explanation: value === true ? "Every identified application explicitly caps monthly installments at no more than 5% of gross monthly income."
      : value === false ? "An application explicitly permits uncapped monthly installments or a cap exceeding 5% of gross monthly income."
      : "The monthly installment cap, gross-monthly-income basis or consistency of the provisions remains unverified.",
    expected: { maximum_percent: 5, basis: "gross_monthly_income" }, applications,
    evidence: reviews.flatMap(r => r.reading.statements.map(s => ({ locator: s.locator, quote: s.quote, kind: s.kind,
      sourceUrl: r.source.snapshot.sourceUrl, sha256: r.source.snapshot.sha256, snapshot_id: r.source.snapshot.snapshot_id,
      retrievedAt: r.source.snapshot.retrievedAt, taskId: r.taskId }))),
    limitations: [...gaps, ...applications.flatMap(a => a.limitations),
      "Scoped to identified saved English/Spanish applications. One model reading per application; quotations and percentages validated locally.",
      "Interest rates do not establish installment-payment caps. Source matching does not independently verify semantic interpretation."],
    reviewStatus: "draft-human-review-pending" }
}
