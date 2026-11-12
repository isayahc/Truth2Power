import { parseArgs, usage } from "./cli-options.ts"
import { resolveHospital } from "./hospitals.ts"
import { runAudit } from "./runner.ts"

try {
  const options = parseArgs(process.argv.slice(2))
  if (options.help) console.log(usage)
  else {
    const hospital = resolveHospital(options.hospital)
    if (Number(process.versions.node.split(".")[0]) < 26) throw new Error("The audit CLI requires Node.js 26+. Use the project's VS Code F5 audit target or select Node 26 in your terminal.")
    await runAudit(hospital, options)
  }
} catch (error: any) {
  console.error(`Audit failed: ${error.message ?? String(error)}`)
  process.exitCode = 1
}
