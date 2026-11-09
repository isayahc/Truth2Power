// Public pinned data; failed recheck is a synthetic intercepted response, never a saved hospital decision.
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { spawn } from "node:child_process";
import { chromium } from "playwright";

const root = mkdtempSync(join(tmpdir(), "SYN-hospital-page-")), artifacts = resolve(".audit/ui/30");
mkdirSync(artifacts, { recursive: true });
const server = spawn(process.execPath, ["backend/src/local-server.js"], {
  env: { ...process.env, PORT: "8095", T2P_REVIEW_DIRECTORY: root }, stdio: ["ignore", "pipe", "pipe"],
});
let browser;
try {
  await new Promise((ready, reject) => {
    const timer = setTimeout(() => reject(Error("Startup timeout")), 15000);
    server.on("exit", (code) => { clearTimeout(timer); reject(Error(`Server exited ${code}`)); });
    server.stdout.on("data", (b) => { if (b.toString().includes("Truth2Power is running")) { clearTimeout(timer); ready(); } });
  });
  browser = await chromium.launch({ headless: true, executablePath: process.env.CHROMIUM_PATH || undefined });
  const page = await browser.newPage({ viewport: { width: 1440, height: 1000 } });
  const errors = [];
  page.on("pageerror", (e) => errors.push(e.message));
  page.on("console", (m) => { if (m.type() === "error" && /same key|hydration/i.test(m.text())) errors.push(m.text()); });
  for (const [key, name] of [["1002", "Ellenville"], ["362", "Little Falls"]]) {
    await page.goto(`http://127.0.0.1:8095/?hospital=${key}`);
    const panel = page.getByRole("region", { name: "Current hospital findings" });
    await panel.getByText("Current grade: pending", { exact: true }).waitFor();
    assert.equal(await panel.locator(".measure-card").count(), 17);
    assert.equal(await panel.locator('a[href="https://www.nysenate.gov/legislation/laws/PBH/2807-K"]').count(), 17);
    assert.match(await page.locator(".detail h2").innerText(), new RegExp(name));
    assert.match(await page.locator(".detail .pill").innerText(), /September 2025/);
    assert.equal(await panel.locator("dt").filter({ hasText: "Publisher’s page update date" }).locator("+ dd").innerText(), "Unknown");
    assert.match(await page.getByRole("link", { name: "Get hospital financial assistance (HFA)" }).getAttribute("href"), /^https:\/\//);
    const card = panel.locator(".measure-card").filter({ hasText: "Does the summary explain how to apply?" });
    await card.locator("details > summary").first().click();
    await card.locator(".measure-evidence > summary").first().click();
    assert.ok((await card.locator("blockquote").first().innerText()).length > 20);
    assert.match(await card.getByRole("link", { name: "Open cited document" }).first().getAttribute("href"), /^https:\/\//);
    assert.match(await card.innerText(), /retrieved .* UTC/);
    for (const [label, width, height] of [["desktop",1440,1000], ["mobile",390,844]]) {
      await page.setViewportSize({ width, height });
      assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), true);
      await page.screenshot({ path: join(artifacts, `${name}-after-${label}.png`), fullPage: true });
    }
    await page.setViewportSize({ width: 1440, height: 1000 });
    await page.reload();
    await page.getByRole("region", { name: "Current hospital findings" }).waitFor();
  }
  // Navigation and browser history restore the selected record.
  await page.getByRole("searchbox").fill("Ellenville");
  await page.locator(".results button").first().click();
  await page.waitForURL("**/?hospital=1002");
  await page.goBack();
  await page.waitForURL("**/?hospital=362");
  await page.locator(".detail h2").filter({ hasText: "Little Falls" }).waitFor();

  await page.route("**/api/hospitals/362/page", async (route) => {
    const response = await route.fetch(), data = await response.json();
    const v = data.measures.find((m) => m.column === "AH").versions.find((v) => v.finding.result === "yes");
    v.failures = [{ attempted_at: "2026-11-10T10:00:00Z", reason: "SYN simulated retrieval failure. Prior finding retained." }];
    await route.fulfill({ json: data });
  });
  await page.reload();
  const failed = page.locator("#measure-362-AH");
  await failed.locator("details > summary").first().click();
  await failed.getByText(/Failed recheck/).first().waitFor();
  assert.match(await failed.innerText(), /Latest successful assessment: 2026-/);
  assert.match(await failed.innerText(), /Yes — Published FPL table is labelled 2026/);
  await failed.screenshot({ path: join(artifacts, "SYN-failed-recheck-after.png") });

  await page.route("**/api/hospitals/1002/page", (route) => route.fulfill({ status: 500, json: {} }));
  await page.getByRole("searchbox").fill("Ellenville");
  await page.locator(".results button").first().click();
  await page.getByRole("alert").filter({ hasText: "Hospital findings could not be loaded" }).waitFor();
  assert.equal(await page.locator(".hospital-assessment").count(), 0);
  await page.unroute("**/api/hospitals/1002/page");
  await page.getByRole("button", { name: "Try again", exact: true }).click();
  await page.getByRole("region", { name: "Current hospital findings" }).waitFor();
  assert.deepEqual(errors, []);
  console.log("Hospital pages passed: offline Wave 1, 17 measures, law/evidence links, dates, grade separation, responsive layout, deep links/history, failed recheck retention and retry.");
} finally {
  await browser?.close();
  server.kill();
  rmSync(root, { recursive: true, force: true });
}
