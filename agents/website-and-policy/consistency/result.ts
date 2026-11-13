import type { Comparison, ConsistencySource } from "./types.ts"

export const criterion = "posted_materials.consistent_across_documents"

export function determineConsistency(sources: ConsistencySource[], comparison: Comparison | undefined,
  confirmation: { confirmed: number[]; limitations: string[] } | undefined, gaps: string[]) {
  const conflicts = (confirmation?.confirmed ?? []).map(i => comparison!.conflicts[i])
  // A bounded inventory cannot establish a universal consistency claim. A cited
  // counterexample can establish inconsistency despite other coverage gaps.
  return {
    criterion, value: conflicts.length ? false : null,
    result: conflicts.length ? "no" : "unclear",
    reason_code: conflicts.length ? "contradicted" : "insufficient_evidence",
    explanation: conflicts.length
      ? "Cross-document contradictions were identified, source-checked, and confirmed in a separate model session. Interpretation remains a draft."
      : "No cross-document contradiction was confirmed; incomplete coverage or interpretation gaps prevent establishing full consistency.",
    expected: { conflicting_terms: 0, include_online_application: true },
    conflicts,
    evidence: conflicts.flatMap(conflict => conflict.evidence.map(citation => {
      const source = sources.find(s => s.id === citation.sourceId)!
      return { snapshot_id: source.snapshot.snapshot_id, locator: citation.locator, quote: citation.quote,
        sourceUrl: source.snapshot.sourceUrl, finalUrl: source.snapshot.finalUrl, sha256: source.snapshot.sha256,
        retrievedAt: source.snapshot.retrievedAt, taskId: "compare-materials", confirmationTaskId: "confirm-conflicts" }
    })),
    limitations: [...gaps, ...(comparison?.limitations ?? []), ...(confirmation?.limitations ?? [])],
    reviewStatus: "draft-human-review-pending",
  }
}
