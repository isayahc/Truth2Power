export type { ReviewSource as ConsistencySource } from "../../shared/review-sources.ts"
export type Citation = { sourceId: string; locator: string; quote: string }
export type Conflict = { topic: string; explanation: string; evidence: Citation[] }
export type Comparison = { comparedSourceIds: string[]; conflicts: Conflict[]; limitations: string[] }
