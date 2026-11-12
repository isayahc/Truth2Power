import assert from "node:assert/strict";
import { spawn, spawnSync } from "node:child_process";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { setTimeout as sleep } from "node:timers/promises";
import { once } from "node:events";
import { DatabaseSync } from "node:sqlite";
import { adaptArtifact } from "../backend/grading/adapter.js";
import { grade } from "../backend/grading/grade.js";
import { chromium } from "playwright";

const directory = await mkdtemp(join(tmpdir(), "t2p-e2e-"));
const env = {
  ...process.env,
  AUDIT_DIR: directory,
  PORT: process.env.AUDIT_TEST_PORT || "18353",
};
const base = "http://127.0.0.1:" + env.PORT;
const server = spawn(process.execPath, ["backend/src/local-server.js"], {
  env,
  stdio: "inherit",
});
const state = async () => (await fetch(base + "/api/audits/362")).json();
let browser, db;
async function work() {
  const child = spawn(
    process.execPath,
    ["backend/audit/worker.js", "--once"],
    { env, stdio: "inherit", timeout: 60000 },
  );
  const [status] = await once(child, "exit");
  assert.equal(status, 0);
}
try {
  for (let i = 0; i < 60; i++) {
    if (server.exitCode !== null) throw Error("Test server exited");
    try {
      await state();
      break;
    } catch {
      await sleep(100);
    }
  }
  browser = await chromium.launch({
    executablePath: env.CHROMIUM_PATH || undefined,
  });
  async function openHospital() {
    const page = await browser.newPage();
    await page.goto(base);
    await page.getByRole("searchbox").fill("Little Falls");
    await page.locator(".results button").first().click();
    return page;
  }
  db = new DatabaseSync(join(directory, "audit.sqlite"));
  for (const year of ["2025", "2026"]) {
    let page = await openHospital();
    await page.locator('.criterion-card').nth(16).waitFor();
    assert.equal(await page.getByRole('button', {name:'Recheck application'}).count(),0);
    const queued = await fetch(`${base}/api/audits/362/${year}`, {method:'POST',headers:{'X-Audit-Request':'1'}});
    assert.equal(queued.status,202);
    await page.close();
    if (year === "2025") {
      // End a worker process after it takes ownership. Advance its lease to simulate timeout.
      const crashed = spawnSync(
        process.execPath,
        [
          "--input-type=module",
          "-e",
          "import {openStore,claim} from './backend/audit/store.js';claim(openStore());process.exit(17)",
        ],
        { env },
      );
      assert.equal(crashed.status, 17);
      db.exec("UPDATE jobs SET lease=0 WHERE status='running'");
    }
    await work();
    const { job, latest } = await state();
    assert.equal(job.status, "completed");
    assert.equal(
      latest.assessment.findings[0].result,
      year === "2025" ? "yes" : "no",
    );
    const adapted = adaptArtifact(Buffer.from(JSON.stringify(latest)), { root: directory });
    assert.equal(adapted.status, "partial", JSON.stringify(adapted.blockers.at(0)));
    const assessment = grade(adapted.input, { root: directory });
    const dollars = assessment.findings.find((f) => f.css_column === "AH");
    assert.equal(dollars.document_results[0].result, year === "2025" ? "unclear" : "no");
    assert.equal(assessment.final_grade, null);
    page = await openHospital();
    const snapshot = latest.snapshots.find(s => s.document_type === 'application');
    const pdf = await fetch(`${base}/api/audits/snapshots/${snapshot.sha256}`);
    assert.equal((await pdf.text()).slice(0, 5), "%PDF-");
    await page.close();
  }
  assert.equal(db.prepare("SELECT count(*) n FROM extractions").get().n, 1);
  assert.equal(db.prepare("SELECT count(*) n FROM assessments").get().n, 2);
  assert.equal(
    db
      .prepare("SELECT count(*) n FROM attempts WHERE status='interrupted'")
      .get().n,
    1,
  );
  console.log("Audit worker E2E passed.");
} finally {
  db?.close();
  await browser?.close();
  if (server.exitCode === null) {
    const stopped = once(server, "exit");
    server.kill();
    await stopped;
  }
  await rm(directory, { recursive: true, force: true });
}
