import { runAudit } from './runner.ts'
let finished = false
process.on('disconnect', () => { if (!finished) process.exit(1) })

// Only the trusted parent worker supplies the hospital, step and approved preparation.
process.once('message', async (input: any) => {
  try {
    await runAudit(input.hospital, { requested: input.requested ?? [input.step], approvedSteps: input.approvedSteps }, {
      log: () => {},
      checkpoint: manifest => new Promise<void>((resolve, reject) => {
        process.send!({ type: 'checkpoint', manifest }, error => error ? reject(error) : resolve())
      }),
    })
    process.exitCode = 0
  } catch {
    process.exitCode = 1
  } finally {
    finished = true
    process.disconnect()
  }
})
