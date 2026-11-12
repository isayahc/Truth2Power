// Re-export: the model-review renderer lives in features/hospital/
// (ported earlier) and is shared by the hospital detail and the run
// detail in AuditOperations.jsx. Do not duplicate it here.
export { default, AgentFinding } from "../hospital/AgentReview.jsx";
