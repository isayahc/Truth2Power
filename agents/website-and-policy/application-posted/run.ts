import { runPostedDocument } from "../../shared/run-posted-document.ts"
import type { Hospital, ReuseOptions } from "../../shared/run-posted-document.ts"
import type { Model } from "../../shared/agent-runtime.ts"
import { applicationInstructions } from "./instructions.ts"
import { validateApplication } from "./validate.ts"
import { criterion, determineApplicationPosted } from "./result.ts"

export type { Hospital } from "../../shared/run-posted-document.ts"

export function checkApplicationPosted(hospital: Hospital, model: Model, options: ReuseOptions = {}) {
  return runPostedDocument(hospital, model, {
    key: "application-posted", criterion, taskId: "determine-k1",
    instructions: applicationInstructions, validate: validateApplication, determine: determineApplicationPosted,
  }, options)
}
