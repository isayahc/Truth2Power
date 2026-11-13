import { resolveHospital } from "./hospitals.ts"
import { runAudit } from "./runner.ts"

const result = await runAudit(resolveHospital("ellenville"), { requested: ["k6"] })
debugger // Inspect result.steps and result.path; criterion artifacts contain evidence and task graphs.
