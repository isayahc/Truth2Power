import type { Snapshot } from "../../shared/snapshots.ts"
import type { ApplicationReading } from "./validate.ts"

export const criterion = "posted_materials.application_posted"
export type ReviewedDocument = { taskId: string; snapshot: Snapshot; reading: ApplicationReading }

export function determineApplicationPosted(documents: ReviewedDocument[]) {
  const applications = documents.filter(doc => doc.reading.isApplication === true)
  return {
    criterion,
    value: applications.length ? true : null,
    result: applications.length ? "yes" : "unclear",
    reason_code: applications.length ? "condition_met" : "insufficient_evidence",
    explanation: applications.length
      ? "Publicly linked PDFs were downloaded successfully and identified as application forms using cited source text."
      : "No application was established within the searched page and supported document formats; absence is not proven.",
    expected: { any_accessible_role: ["application", "online_application"] },
    evidence: applications.flatMap(doc => doc.reading.evidence.map(citation => ({
      snapshot_id: doc.snapshot.snapshot_id, locator: `PDF page ${citation.page}`, quote: citation.quote,
      sourceUrl: doc.snapshot.sourceUrl, finalUrl: doc.snapshot.finalUrl,
      sha256: doc.snapshot.sha256, retrievedAt: doc.snapshot.retrievedAt, taskId: doc.taskId,
    }))),
    reviewStatus: "draft-human-review-pending",
  }
}
