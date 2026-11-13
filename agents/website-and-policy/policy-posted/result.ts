import type { Snapshot } from "../../shared/snapshots.ts"
import type { PolicyReading } from "./validate.ts"

export const criterion = "posted_materials.policy_statement_posted"
export type ReviewedPolicy = { taskId: string; snapshot: Snapshot; reading: PolicyReading }

export function determinePolicyPosted(documents: ReviewedPolicy[]) {
  const policies = documents.filter(doc => doc.reading.isPolicy === true)
  return {
    criterion,
    value: policies.length ? true : null,
    result: policies.length ? "yes" : "unclear",
    reason_code: policies.length ? "condition_met" : "insufficient_evidence",
    explanation: policies.length
      ? "Hospital website links lead to retrieved PDFs identified as governing financial-assistance policies with cited policy identities and provisions."
      : "No governing financial-assistance policy was established within the bounded website search and supported formats; absence is not proven.",
    expected: { any_accessible_role: ["policy_statement"] },
    evidence: policies.flatMap(doc => doc.reading.evidence.map(citation => ({
      snapshot_id: doc.snapshot.snapshot_id, locator: `PDF page ${citation.page}`, quote: citation.quote,
      sourceUrl: doc.snapshot.sourceUrl, finalUrl: doc.snapshot.finalUrl,
      sha256: doc.snapshot.sha256, retrievedAt: doc.snapshot.retrievedAt, taskId: doc.taskId,
    }))),
    reviewStatus: "draft-human-review-pending",
  }
}
