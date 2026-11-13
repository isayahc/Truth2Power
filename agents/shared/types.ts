export type ReviewContext = {
  hospital_key: string
  review_date: string
  guideline_year: number
}

export type EvidencePacket = {
  // Include relevant languages, conflicting documents and reference sources.
  passages: { snapshot_id: string; locator: string; text: string; role: string; language: string }[]
  coverage: { complete: boolean; gaps: string[]; search_notes: string }
}

export type Measure = {
  measure_id: string
  title: string
  roles: string[]
  expected: unknown
  evidence_requirement: string
  exemptions: unknown[]
}
