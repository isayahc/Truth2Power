import { runPostedDocument } from "../../shared/run-posted-document.ts"
import type { Hospital, ReuseOptions } from "../../shared/run-posted-document.ts"
import type { Model } from "../../shared/agent-runtime.ts"
import { summaryInstructions } from "./instructions.ts"
import { validateSummary } from "./validate.ts"
import { criterion, determineSummaryPosted } from "./result.ts"

export function checkSummaryPosted(hospital: Hospital, model: Model, options: ReuseOptions = {}) {
  return runPostedDocument(hospital, model, {
    key: "summary-posted", criterion, taskId: "determine-k2",
    instructions: summaryInstructions, validate: validateSummary, determine: determineSummaryPosted,
  }, options)
}
