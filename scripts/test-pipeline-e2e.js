// Offline end-to-end synthetic pilot. Uses the actual persistent worker, grader and read APIs.
import assert from "node:assert/strict";
import { spawn, execFile } from "node:child_process";
import { promisify } from "node:util";
import { mkdtempSync, mkdirSync, rmSync, readFileSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { tmpdir } from "node:os";
import { once } from "node:events";
import { chromium } from "playwright";

const execute = promisify(execFile), root = mkdtempSync(join(tmpdir(), "SYN-pilot-browser-"));
const env = { ...process.env, AUDIT_DIR: root, T2P_REVIEW_DIRECTORY: join(root, "live"), T2P_PILOT_DEMO: "1", PORT: "8091" };
const artifacts = resolve(".audit/ui/pilot");
mkdirSync(artifacts, { recursive: true });
const server = spawn(process.execPath, ["backend/src/local-server.js"], { env, stdio: ["ignore", "pipe", "pipe"] });
const origin = "http://127.0.0.1:8091";
const get = async (path) => { const r = await fetch(origin + path); assert.equal(r.status, 200); return r.json(); };
const worker = () => execute(process.execPath, ["backend/audit/worker.js", "--once"], { env, timeout: 90000 });
const queue = (key, variant = "original") => fetch(origin + "/api/pilot/hospitals/1002", { method: "POST", headers: { "Content-Type": "application/json", "X-Review-Request": "1" },
  body: JSON.stringify({ mode: "synthetic", variant, year: 2026, review_date: "2026-11-09", request_key: key }) });
let browser, errors = [];
try {
  await new Promise((ready, reject) => {
    const timer = setTimeout(() => reject(Error("Server startup timeout")), 15000);
    server.on("exit", (c) => { clearTimeout(timer); reject(Error(`Server exited ${c}`)); });
    server.stdout.on("data", (b) => { if (b.toString().includes("Truth2Power is running")) { clearTimeout(timer); ready(); } });
  });
  browser = await chromium.launch({ executablePath: process.env.CHROMIUM_PATH || undefined });
  let page = await browser.newPage({ viewport: { width: 1440, height: 1000 } });
  await page.clock.install({ time: new Date("2026-11-09T12:00:00Z") });
  await page.goto(origin + "/?hospital=1002");
  const controls = page.getByRole("region", { name: "Integrated audit job" });
  await controls.getByRole("button", { name: "Queue 17-measure audit" }).waitFor();
  await page.screenshot({ path: join(artifacts, "before-desktop.png"), fullPage: true });
  await controls.getByLabel("Evidence mode").selectOption("synthetic");
  await controls.getByRole("button", { name: "Queue 17-measure audit" }).click();
  await controls.getByText("queued", { exact: true }).waitFor();
  await page.close(); // The audit has no dependency on a browser tab staying open.
  await worker();
  const firstStatus = await get("/api/pilot/hospitals/1002"), first = await get(`/api/pilot/assessments/${firstStatus.latest}`);
  assert.equal(first.report.findings.length, 17);
  assert.equal(first.report.calculated_grade, "B");
  assert.equal(first.report.final_grade, null);
  const verifyViews = async (id) => {
    assert.equal((await get("/api/hospitals/1002/page")).revision, id);
    assert.equal((await get("/api/overview")).hospitals.find((r) => r.hospital_key === "1002").revision, id);
    assert.equal((await get("/api/grading/hospitals/1002")).revision, id);
    const inbox = await get("/api/reviews?hospital_key=1002&namespace=pipeline");
    assert.equal(inbox.items.length, 17);
    assert.ok(inbox.items.every((i) => i.status === "pending"));
  };
  await verifyViews(first.id);
  page = await browser.newPage({ viewport: { width: 1440, height: 1000 } });
  page.on("pageerror", (e) => errors.push(e.message));
  await page.goto(origin + "/?hospital=1002");
  await page.getByText("SYNTHETIC DEMO — fabricated evidence, not hospital compliance findings.", { exact: true }).waitFor();
  assert.equal(await page.locator(".measure-card").count(), 17);
  assert.match(await page.locator(".detail .pill").innerText(), /September 2025/);
  const source = first.input.sources.find((s) => s.role === "application").snapshot;
  const response = await fetch(origin + `/api/pilot/snapshots/${source.sha256}`);
  assert.equal(response.status, 200);
  assert.deepEqual(Buffer.from(await response.arrayBuffer()), readFileSync(join(env.T2P_REVIEW_DIRECTORY, source.artifact_path)));
  await queue("SYN-unchanged"); await worker();
  assert.equal((await get("/api/changes")).events.filter((e) => e.synthetic).length, 0);
  await queue("SYN-corrected", "corrected"); await worker();
  const correctedId = (await get("/api/pilot/hospitals/1002")).latest;
  await verifyViews(correctedId);
  assert.equal((await get(`/api/pilot/assessments/${correctedId}`)).report.calculated_grade, "A");
  const events = (await get("/api/changes")).events.filter((e) => e.synthetic);
  assert.equal(events.length, 1); assert.equal(events[0].revision, correctedId);
  await page.goto(origin + "/?view=changes");
  await page.getByText("SYNTHETIC — Ellenville Regional Hospital", { exact: true }).waitFor();
  await page.screenshot({ path: join(artifacts, "changes-after-desktop.png"), fullPage: true });
  // A failed refresh does not advance any view or produce a material event.
  const path = join(env.T2P_REVIEW_DIRECTORY, source.artifact_path), bytes = readFileSync(path);
  writeFileSync(path, "SYN corrupted snapshot");
  await queue("SYN-failed"); await worker();
  writeFileSync(path, bytes);
  const failed = await get("/api/pilot/hospitals/1002");
  assert.equal(failed.latest, correctedId); assert.equal(failed.job.status, "queued");
  await verifyViews(correctedId);
  assert.equal((await get("/api/changes")).events.filter((e) => e.synthetic).length, 1);
  await page.goto(origin + "/?hospital=1002");
  await page.locator(".measure-card .recheck-failed").first().waitFor();
  for (const [label, width, height] of [["desktop",1440,1000], ["mobile",390,844]]) {
    await page.setViewportSize({ width, height });
    assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), true);
    await page.screenshot({ path: join(artifacts, `after-${label}.png`), fullPage: true });
  }
  assert.deepEqual(errors, []);
  // Public-byte regression: same pipeline, original Little Falls two-hop summary chain.
  await execute(env.T2P_PYTHON || "python", ["-m", "zipfile", "-e", "docs/validation/pilot-wave-one-evidence.zip", env.T2P_REVIEW_DIRECTORY]);
  await execute(process.execPath, ["backend/audit/pipeline-cli.js", "run", "--mode", "replay", "--hospital", "362",
    "--year", "2026", "--date", "2026-11-09", "--request", "public-summary-chain"], { env, timeout: 90000 });
  const publicId = (await get("/api/pilot/hospitals/362")).latest;
  const publicBundle = await get(`/api/pilot/assessments/${publicId}`);
  assert.equal(publicBundle.report.findings.find((f) => f.css_column === "S").result, "yes");
  assert.equal(publicBundle.report.final_grade, null);
  const publicPage = await get("/api/hospitals/362/page");
  assert.equal(publicPage.revision, publicId);
  assert.equal(publicPage.measures.find((m) => m.column === "S").result, "yes");
  assert.equal((await get("/api/grading/hospitals/362")).revision, publicId);
  assert.equal((await get("/api/overview")).hospitals.find((h) => h.hospital_key === "362").revision, publicId);
  assert.equal((await get("/api/reviews?hospital_key=362&namespace=pipeline")).items.length, 17);
  assert.equal((await get("/api/changes")).events.filter((e) => e.synthetic).length, 1);
  await page.setViewportSize({ width: 1440, height: 1000 });
  await page.goto(origin + "/?hospital=362");
  const summaryCard = page.locator("#measure-362-S");
  try { await summaryCard.locator(".result-yes").waitFor(); }
  catch (error) { await page.screenshot({ path: join(artifacts, "little-falls-failure.png"), fullPage: true }); throw Error(`${error.message}\nBrowser errors: ${JSON.stringify(errors)}`); }
  await summaryCard.locator("details").evaluateAll((details) => details.forEach((d) => { d.open = true; }));
  const quoteCount = await summaryCard.locator("blockquote").count();
  await summaryCard.screenshot({ path: join(artifacts, "little-falls-summary-chain-desktop.png") });
  assert.ok(quoteCount >= 7, `Expected all path/title/campus citations, found ${quoteCount}`);
  assert.deepEqual(errors, []);
  // Same-origin enforcement and server-selected storage paths.
  const forbidden = await fetch(origin + "/api/pilot/hospitals/1002", { method: "POST", headers: { Origin: "https://example.org" }, body: "{}" });
  assert.equal(forbidden.status, 403);
  console.log("Pilot browser passed: queue/close/reopen, actual worker, 17 outcomes, immutable evidence, consistent revisions, unchanged/corrected/failed refresh, one event, desktop/mobile, CSRF and original Little Falls two-hop S=yes across all read views.");
} finally {
  if (errors.length) console.error("browser_errors", JSON.stringify(errors));
  await browser?.close();
  const stopped = once(server, "exit"); server.kill(); await stopped;
  rmSync(root, { recursive: true, force: true });
}
