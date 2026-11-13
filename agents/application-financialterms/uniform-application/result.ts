import type { ReviewSource } from "../../shared/review-sources.ts"
import type { UniformReference } from "./reference.ts"
import type { UniformReading } from "./validate.ts"
export const criterion = "application.uniform_application"
export type UniformReview = { taskId: string; source: ReviewSource; reading: UniformReading }
export function determineUniformApplication(reviews: UniformReview[], reference: UniformReference | undefined, gaps: string[]) {
  return {
    criterion, value: null, result: "unclear", reason_code: "insufficient_evidence",
    explanation: "Text comparisons are provisional. Whole-form compliance requires applicable template/customization rules and visual review of every form page.",
    expected: { required_sections: "applicable_uniform_template", visual_review_complete: true },
    reference: reference ? { version: reference.version, sourceUrl: reference.sourceUrl, sourceHash: reference.sourceHash,
      renderHash: reference.renderHash, derived: true, sourcePath: reference.sourcePath, renderPath: reference.renderPath } : null,
    visualReviewComplete: false,
    comparisons: reviews.map(r => ({ taskId: r.taskId, sourceUrl: r.source.snapshot.sourceUrl, sha256: r.source.snapshot.sha256, ...r.reading })),
    evidence: reviews.flatMap(r => r.reading.sections.flatMap(section => [
      ...section.application.map(c => ({ ...c, section: section.id, role: "application", taskId: r.taskId,
        sourceUrl: r.source.snapshot.sourceUrl, sha256: r.source.snapshot.sha256 })),
      ...section.reference.map(c => ({ ...c, section: section.id, role: "uniform_reference", taskId: r.taskId,
        sourceUrl: reference!.sourceUrl, sha256: reference!.renderHash })),
    ])),
    limitations: [...gaps, ...reviews.flatMap(r => r.reading.limitations),
      "This run performs text comparison only; visual field/layout completeness has not been established.",
      "Template applicability, translated-template equivalence, permitted customization and overlap with the FPL criterion remain unapproved. Differences alone do not determine failure.",
      "Page/section lists and matched quotations verify response coverage and provenance, not semantic completeness."],
    reviewStatus: "draft-human-review-pending",
  }
}
