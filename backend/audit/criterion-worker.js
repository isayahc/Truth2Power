import { fork } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { criterionHospital, claimCriterion, finishCriterion, saveCriterionProgress } from './criterion-service.js';

export async function workCriterion(db, root, { launch = fork } = {}) {
  const job = claimCriterion(db);
  if (!job) return false;
  let timer, heartbeat, child, writes = Promise.resolve(), writeFailed = false, timedOut = false;
  try {
    const hospital = criterionHospital(job.hospital);
    child = launch(fileURLToPath(new URL('../../agents/criterion-job.ts', import.meta.url)), [], {
      execArgv: [], stdio: ['ignore','ignore','ignore','ipc'],
      env: { ...process.env, AUDIT_DIR: root, T2P_AGENT_MAX_CALLS: '40' },
    });
    child.on('message', message => {
      if (message?.type !== 'checkpoint') return;
      writes = writes.then(() => saveCriterionProgress(db, job, message.manifest, root)).catch(() => {
        writeFailed = true;
        child.kill();
      });
    });
    heartbeat = setInterval(() => {
      const lease = db.prepare("UPDATE criterion_jobs SET lease=? WHERE id=? AND token=? AND status='running'")
        .run(Date.now() + 90000, job.id, job.token);
      if (!lease.changes) child.kill();
    }, 20000);
    timer = setTimeout(() => { timedOut = true; child.kill('SIGKILL'); }, 20 * 60 * 1000);
    const done = new Promise((resolve, reject) => {
      child.once('error', reject);
      child.once('exit', code => resolve(code));
    });
    child.send({ hospital, step: job.step, approvedSteps: JSON.parse(job.approved) });
    const code = await done;
    await writes;
    const progress = JSON.parse(db.prepare('SELECT progress FROM criterion_jobs WHERE id=?').get(job.id).progress);
    finishCriterion(db, job, timedOut ? 'timeout' : code !== 0 || writeFailed || progress[job.step]?.status !== 'succeeded' ? 'execution_failed' : null);
  } catch {
    child?.kill();
    await writes;
    finishCriterion(db, job, 'execution_failed');
  } finally {
    clearTimeout(timer);
    clearInterval(heartbeat);
  }
  return true;
}
