import { stepIds } from "./steps.ts"
import type { StepId } from "./steps.ts"

export const usage = `Usage: npm run audit -- <hospital> [--step kN | --through kN] [--refresh]

Hospital only runs all implemented criteria (k1–k17), scoped to English/Spanish.
--step       Run one criterion; reuse or run its prerequisites.
--through    Run all criteria up to and including this step.
--refresh    Fetch fresh sources instead of using saved inventories.
--help       Show this help without making model calls.

Example: npm run audit -- ellenville --step k6
Requires Node.js 26+ for the agent SDK. Runs use Amazon Bedrock Nova Micro.`

export function parseArgs(args: string[]) {
  if (args.length === 1 && ["--help", "-h"].includes(args[0])) return { help: true as const }
  let hospital: string | undefined
  let selection: StepId[] | undefined
  let refresh = false
  for (let i = 0; i < args.length; i++) {
    const arg = args[i]
    if (arg === "--refresh") {
      if (refresh) throw new Error("Duplicate --refresh")
      refresh = true
    } else if (arg === "--step" || arg === "--through") {
      if (selection) throw new Error("Use either --step or --through, once")
      const id = args[++i] as StepId
      if (!stepIds.includes(id)) throw new Error(`Choose an implemented step: ${stepIds.join(", ")}`)
      selection = arg === "--step" ? [id] : stepIds.slice(0, stepIds.indexOf(id) + 1)
    } else if (arg.startsWith("-")) throw new Error(`Unknown option: ${arg}`)
    else if (hospital) throw new Error("Supply one hospital; quote names containing spaces")
    else hospital = arg
  }
  if (!hospital) throw new Error("A hospital name is required. Use --help for usage.")
  return { help: false as const, hospital, requested: selection ?? [...stepIds], refresh }
}
