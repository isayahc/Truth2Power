import { runPostedDocument } from "../../shared/run-posted-document.ts"
import type { Hospital, ReuseOptions } from "../../shared/run-posted-document.ts"
import type { Model } from "../../shared/agent-runtime.ts"
import { policyInstructions } from "./instructions.ts"
import { validatePolicy } from "./validate.ts"
import { criterion, determinePolicyPosted } from "./result.ts"

export function checkPolicyPosted(hospital: Hospital, model: Model, options: ReuseOptions = {}) {
  return runPostedDocument(hospital, model, {
    key: "policy-posted", criterion, taskId: "determine-k3", searchWebsite: true,
    instructions: policyInstructions, validate: validatePolicy, determine: determinePolicyPosted,
  }, options)
}
