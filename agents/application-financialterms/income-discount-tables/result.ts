import type { ReviewSource } from "../../shared/review-sources.ts"
import type { TablesReading, TableDecision } from "./validate.ts"
export const criterion = "application.income_discount_tables"
export type TablesReview = { taskId: string; source: ReviewSource; reading: TablesReading;
  decisions: TableDecision[]; confirmationTaskId: string | null }
export function determineIncomeDiscountTables(reviews: TablesReview[], applicationIds: string[], gaps: string[]) {
  const observations = reviews.flatMap(r => r.reading.tables.map((table, index) => ({ ...table,
    taskId: r.taskId, sourceUrl: r.source.snapshot.sourceUrl, sha256: r.source.snapshot.sha256,
    onApplication: r.source.roles.includes("application"), confirmationTaskId: r.confirmationTaskId,
    confirmation: r.decisions.find(d => d.index === index) ?? null,
  })))
  const applications = applicationIds.map(sha256 => {
    const tables = observations.filter(o => o.sha256 === sha256 && o.onApplication && o.confirmation?.confirmed)
    const incomeTable = tables.some(t => t.kind === "income")
    const discountTable = tables.some(t => t.kind === "discount")
    return { sha256, incomeTable, discountTable, value: incomeTable && discountTable ? true : null }
  })
  const value = applications.length && applications.every(a => a.value === true) ? true : null
  return { criterion, value, result: value === true ? "yes" : "unclear",
    reason_code: value === true ? "condition_met" : "insufficient_evidence",
    explanation: value === true ? "Both tables have source-matched headers and sample rows, with separate model confirmation, on every identified saved application."
      : "Both tables have not been verified on every identified application; missing, failed or ambiguous readings do not establish absence.",
    expected: { income_table: true, discount_table: true }, applications, observations,
    evidence: reviews.flatMap(r => r.reading.tables.flatMap((table, index) => [table.header, ...table.rows].map(c => ({
      locator: c.locator, quote: c.quote, kind: table.kind, snapshot_id: r.source.snapshot.snapshot_id,
      sha256: r.source.snapshot.sha256, sourceUrl: r.source.snapshot.sourceUrl, retrievedAt: r.source.snapshot.retrievedAt,
      taskId: r.taskId, confirmationTaskId: r.confirmationTaskId,
      interpretationConfirmed: r.decisions.find(d => d.index === index)?.confirmed === true,
    })))),
    limitations: [...gaps, ...reviews.flatMap(r => r.reading.limitations),
      "Presence is scoped to identified saved applications; not every current online form or language variant.",
      "Sample rows establish table presence, not complete cell coverage, current FPL year, arithmetic accuracy or compliant discount levels."],
    reviewStatus: "draft-human-review-pending" }
}
