import type { Snapshot } from "../../shared/snapshots.ts"
import type { SummaryReading } from "./validate.ts"

export const criterion = "posted_materials.policy_summary_posted"
export type ReviewedSummary = { taskId: string; snapshot: Snapshot; reading: SummaryReading }

export function determineSummaryPosted(documents: ReviewedSummary[]) {
  const summaries = documents.filter(doc => doc.reading.isSummary === true)
  return {
    criterion,
    value: summaries.length ? true : null,
    result: summaries.length ? "yes" : "unclear",
    reason_code: summaries.length ? "condition_met" : "insufficient_evidence",
    explanation: summaries.length
      ? "Publicly linked, successfully retrieved PDFs identify themselves as financial-assistance summaries and contain cited patient-facing assistance information."
      : "No designated financial-assistance summary was established within the searched page and supported formats; absence is not proven.",
    expected: { any_accessible_role: ["policy_summary"] },
    evidence: summaries.flatMap(doc => doc.reading.evidence.map(citation => ({
      snapshot_id: doc.snapshot.snapshot_id, locator: `PDF page ${citation.page}`, quote: citation.quote,
      sourceUrl: doc.snapshot.sourceUrl, finalUrl: doc.snapshot.finalUrl,
      sha256: doc.snapshot.sha256, retrievedAt: doc.snapshot.retrievedAt, taskId: doc.taskId,
    }))),
    reviewStatus: "draft-human-review-pending",
  }
}
