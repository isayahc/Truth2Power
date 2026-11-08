// Synthetic-only browser verification; never records decisions against live hospital drafts.
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { spawn } from "node:child_process";
import { chromium } from "playwright";
import { reviewFixture, applicationFixture } from "../backend/test/review-fixture.js";

const root = mkdtempSync(join(tmpdir(), "t2p-review-browser-"));
reviewFixture(root);
applicationFixture(root);
const port = 8097;
const base = `http://127.0.0.1:${port}`;
const artifacts = resolve(".audit/ui/27");
mkdirSync(artifacts, { recursive: true });
const server = spawn(process.execPath, ["backend/src/local-server.js"], {
  env: { ...process.env, PORT: String(port), T2P_REVIEW_DIRECTORY: root }, stdio: ["ignore", "pipe", "pipe"],
});
let browser;
try {
  await new Promise((resolveReady, reject) => {
    const timer = setTimeout(() => reject(new Error("Test server startup timed out")), 15000);
    server.on("exit", (code) => { clearTimeout(timer); reject(new Error(`Test server exited: ${code}`)); });
    server.stdout.on("data", (data) => { if (data.toString().includes("Truth2Power is running")) { clearTimeout(timer); resolveReady(); } });
  });
  browser = await chromium.launch({ headless: true });
  const page = await browser.newPage({ viewport: { width: 1440, height: 1000 } });
  const errors = [];
  page.on("pageerror", (e) => errors.push(e.message));
  await page.goto(base);
  await page.getByRole("button", { name: /Review inbox 7/ }).waitFor();
  await page.screenshot({ path: join(artifacts, "27-map-badge.png"), fullPage: true });
  await page.getByRole("button", { name: /Review inbox 7/ }).click();
  await page.getByRole("button", { name: /Needs review.*Ellenville.*Application FPL year and amounts/ }).click();
  await page.getByText("Published vs expected FPL amounts (1 cells)", { exact: true }).click();
  await page.getByRole("cell", { name: "$63,840", exact: true }).waitFor();
  await page.getByRole("cell", { name: "$62,600", exact: true }).waitFor();
  assert.match(await page.locator(".review-detail").innerText(), /Selected application only/);
  await page.getByText("Other application versions not assessed (1)", { exact: true }).click();
  await page.getByRole("link", { name: /SYN-spanish.pdf/ }).waitFor();
  await page.screenshot({ path: join(artifacts, "23-application-fpl.png"), fullPage: true });
  await page.setViewportSize({ width: 390, height: 844 });
  assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth), true);
  await page.getByRole("cell", { name: "$63,840", exact: true }).waitFor();
  await page.screenshot({ path: join(artifacts, "23-application-fpl-mobile.png"), fullPage: true });
  await page.setViewportSize({ width: 1440, height: 1000 });
  await page.getByRole("button", { name: /Needs review.*Ellenville.*Application deadlines/ }).click();
  await page.getByRole("heading", { name: "Quoted evidence" }).waitFor();
  assert.match(await page.locator(".review-detail").innerText(), /SYNTHETIC/);
  const savedUrl = await page.getByRole("link", { name: /Open saved source/ }).first().getAttribute("href");
  const source = await page.request.get(base + savedUrl);
  assert.equal(source.status(), 200);
  assert.match(source.headers()["content-type"], /text\/plain/);
  assert.match(await source.text(), /SYNTHETIC/);
  await page.screenshot({ path: join(artifacts, "27-review-context.png"), fullPage: true });
  const { items } = await (await page.request.get(`${base}/api/reviews`)).json();
  assert.equal((await page.request.post(`${base}/api/reviews/${items[0].id}/decisions`, { data: {} })).status(), 403);
  assert.equal((await page.request.post(`${base}/api/reviews/${items[0].id}/decisions`, {
    headers: { "X-Review-Request": "1", Origin: "https://example.org" }, data: {},
  })).status(), 403);
  await page.getByLabel("Decision", { exact: true }).selectOption("request_information");
  await page.getByLabel("Reviewer role").fill("Synthetic browser tester");
  await page.getByLabel("Reason / information needed").fill("SYN: please clarify the collection timing language.");
  await page.getByRole("button", { name: "Save review decision" }).click();
  await page.getByRole("status").filter({ hasText: "Decision saved" }).waitFor();
  await page.getByRole("button", { name: /Review inbox 7/ }).waitFor();
  await page.getByLabel("Decision", { exact: true }).selectOption("correct");
  await page.getByLabel("Corrected result").selectOption("yes");
  await page.getByLabel("Reviewer role").fill("Synthetic browser tester");
  await page.getByLabel("Reason / information needed").fill("SYN: cited policy allows applications at any time.");
  await page.getByRole("button", { name: "Save review decision" }).click();
  await page.getByRole("button", { name: /Review inbox 6/ }).waitFor();
  assert.match(await page.locator(".review-detail").innerText(), /Reviewed result: yes/);
  assert.match(await page.locator(".review-detail").innerText(), /Original draft: unclear/);
  await page.getByLabel("Status", { exact: true }).selectOption("resolved");
  await page.screenshot({ path: join(artifacts, "27-reviewed-result.png"), fullPage: true });
  await page.reload();
  await page.getByRole("button", { name: /Review inbox 6/ }).click();
  await page.getByLabel("Status", { exact: true }).selectOption("resolved");
  await page.getByRole("button", { name: /Reviewed.*Ellenville/ }).click();
  await page.getByText("Decision history (2)", { exact: true }).waitFor();
  await page.getByRole("button", { name: "View hospital on map" }).click();
  await page.getByRole("button", { name: "Review notifications (6)" }).click();
  assert.equal(await page.getByLabel("Hospital", { exact: true }).inputValue(), "1002");
  await page.setViewportSize({ width: 390, height: 844 });
  await page.getByLabel("Status", { exact: true }).selectOption("resolved");
  await page.getByRole("button", { name: /Reviewed.*Ellenville/ }).click();
  await page.getByRole("heading", { name: "Quoted evidence" }).waitFor();
  assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth), true);
  assert.equal(await page.locator(".review-form").evaluate((form) => [...form.querySelectorAll("input, select, textarea")]
    .every((control) => control.getBoundingClientRect().right <= form.getBoundingClientRect().right)), true);
  await page.screenshot({ path: join(artifacts, "27-mobile.png"), fullPage: true });
  assert.deepEqual(errors, []);
  console.log("Review inbox browser checks passed: context, sources, CSRF, unresolved/correction, persistence, hospital link, desktop/mobile.");
  console.log(`Screenshots: ${artifacts}`);
} finally {
  await browser?.close();
  server.kill();
  rmSync(root, { recursive: true, force: true });
}
