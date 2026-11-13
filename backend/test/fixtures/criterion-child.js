// Synthetic-only worker fixture; never imports the SDK or makes network calls.
import { writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { runAudit } from '../../../agents/runner.ts';
import { steps } from '../../../agents/steps.ts';
process.once('message', async input => {
  try {
    const registry = { ...steps };
    for (const id of input.approvedSteps) registry[id] = { ...steps[id], run: async () => {
      const path = join(process.env.AUDIT_DIR, `SYN-child-${id}.json`);
      const result = { synthetic:true, runId:'SYN-child', hospital:input.hospital, criterion:steps[id].criterion,
        value:true, explanation:'SYNTHETIC worker result', evidence:[] };
      await writeFile(path, JSON.stringify(result)); return {...result,path};
    } };
    await runAudit(input.hospital, {requested:input.requested ?? [input.step],approvedSteps:input.approvedSteps}, {
      registry, find:async()=>undefined, log:()=>{},
      checkpoint:manifest=>new Promise((resolve,reject)=>process.send({type:'checkpoint',manifest},error=>error?reject(error):resolve())),
    });
  } catch { process.exitCode=1; }
  finally { process.disconnect(); }
});
