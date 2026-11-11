// Read-only public Wave 1 reporting checks; no review decisions or audit jobs submitted.
import assert from "node:assert/strict";
import { mkdirSync } from "node:fs";
import { resolve, join } from "node:path";
import { spawn } from "node:child_process";
import { chromium } from "playwright";

const port = 8096, artifacts = resolve(".audit/ui/25");
mkdirSync(artifacts, { recursive: true });
const server = spawn(process.execPath, ["backend/src/local-server.js"], {
  env: { ...process.env, PORT: String(port) }, stdio: ["ignore", "pipe", "pipe"],
});
let browser;
try {
  await new Promise((ready, reject) => {
    const timer = setTimeout(() => reject(new Error("Test server startup timed out")), 15000);
    server.on("exit", (code) => { clearTimeout(timer); reject(new Error(`Server exited ${code}`)); });
    server.stdout.on("data", (bytes) => { if (bytes.toString().includes("Truth2Power is running")) { clearTimeout(timer); ready(); } });
  });
  browser = await chromium.launch({ headless: true, executablePath: process.env.CHROMIUM_PATH || undefined });
  const page = await browser.newPage({ viewport: { width: 1440, height: 1000 } });
  const errors = [];
  page.on("pageerror", (e) => errors.push(e.message));
  await page.goto(`http://127.0.0.1:${port}/`);
  for (const [name, applications] of [["Ellenville", 5], ["Little Falls", 2]]) {
    if (name === "Little Falls") await page.getByRole("button", { name: "← Back to statewide map and ratings" }).click();
    await page.getByRole("searchbox").fill(name);
    await page.locator(".results button").first().click();
    const panel = page.getByRole("region", { name: "Languages and service area — not graded" });
    await panel.getByRole("heading", { name: "Document languages", exact: true }).waitFor();
    assert.match(await panel.innerText(), /Informational — excluded from grade count/);
    assert.match(await panel.innerText(), /Pending review — no independent county reference established/);
    await panel.getByText(`Application languages (${applications} documents)`, { exact: true }).click();
    await panel.getByText("Plain-language summary languages (2 documents)", { exact: true }).click();
    assert.ok(await panel.getByRole("link", { name: /Spanish/ }).count() >= 2);
    if (name === "Ellenville") {
      assert.match(await panel.innerText(), /Ulster, Dutchess, Orange, Sullivan, Delaware, Greene, Columbia/);
      await panel.getByText("Policy statement languages (3 documents)", { exact: true }).click();
      await panel.getByText("Unknown", { exact: true }).waitFor();
      assert.match(await panel.innerText(), /linked document unavailable \(404\)/);
    } else {
      assert.match(await panel.innerText(), /No explicit county list/);
      assert.match(await panel.innerText(), /Little Falls, Delhi, Herkimer, Oneonta, Cobleskill, Cooperstown/);
      assert.doesNotMatch(await panel.innerText(), /Ulster, Dutchess/);
    }
    const gradeBefore = await page.locator(".detail .pill").innerText();
    assert.match(gradeBefore, /September 2025/);
    for (const [label, width, height] of [["desktop", 1440, 1000], ["mobile", 390, 844]]) {
      await page.setViewportSize({ width, height });
      assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), true);
      await panel.screenshot({ path: join(artifacts, `${name}-after-${label}.png`) });
      assert.equal(await page.locator(".detail .pill").innerText(), gradeBefore);
    }
    await page.setViewportSize({ width: 1440, height: 1000 });
  }
  // Context loading failure must not display a previous hospital's data.
  await page.route("**/api/hospitals/1002/reporting-context", (route) => route.fulfill({ status: 500, body: "{}" }));
  await page.getByRole("button", { name: "← Back to statewide map and ratings" }).click();
  await page.getByRole("searchbox").fill("Ellenville");
  await page.locator(".results button").first().click();
  await page.getByRole("alert").filter({ hasText: "Languages and service-area context could not be loaded" }).waitFor();
  assert.equal(await page.locator(".reporting-context").count(), 0);
  assert.deepEqual(errors, []);
  console.log("Reporting context passed: both hospitals, per-document languages, pending county reference, preserved historical grades, desktop/mobile and failure state.");
  console.log(`Screenshots: ${artifacts}`);
} finally {
  await browser?.close();
  server.kill();
}
