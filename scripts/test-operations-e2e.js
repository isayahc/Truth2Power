// Offline end-to-end operator flow. Only the collector transport uses fixture responses.
import assert from "node:assert/strict";
import { execFileSync, spawn } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { join, resolve } from "node:path";
import { tmpdir } from "node:os";
import { chromium } from "playwright";

const root = mkdtempSync(join(tmpdir(), "SYN-operations-"));
process.env.AUDIT_DIR = root;
process.env.T2P_REVIEW_DIRECTORY = join(root, "live");
const { openStore, claim } = await import("../backend/audit/store.js");
const { runPipeline } = await import("../backend/audit/pipeline.js");
const { failPipeline } = await import("../backend/audit/pipeline-store.js");
const db = openStore(),
  port = process.env.TEST_PORT ?? "8198",
  origin = "http://127.0.0.1:" + port;
const server = spawn(process.execPath, ["backend/src/local-server.js"], {
  env: { ...process.env, PORT: port },
  stdio: ["ignore", "pipe", "inherit"],
});
const artifacts = resolve(".audit/ui/operations");
mkdirSync(artifacts, { recursive: true });
let browser;
try {
  await new Promise((ok, fail) => {
    server.stdout.once("data", ok);
    server.once("exit", fail);
  });
  browser = await chromium.launch({
    executablePath: process.env.CHROMIUM_PATH || undefined,
    args:
      process.env.TEST_SINGLE_PROCESS === "1"
        ? ["--single-process", "--no-zygote", "--disable-gpu"]
        : [],
  });
  const page = await browser.newPage({
    viewport: { width: 1440, height: 960 },
  });
  const errors = [];
  page.on("pageerror", (e) => errors.push(e.message));
  let release;
  const gate = new Promise((ok) => {
    release = ok;
  });
  await page.route("**/v1/operations", async (route) => {
    await gate;
    await route.continue();
  });
  await page.goto(origin + "/?view=operations");
  await page
    .getByRole("status")
    .filter({ hasText: "Loading audit records" })
    .first()
    .waitFor();
  release();
  await page.getByRole("status").filter({ hasText: "212 / 212" }).waitFor();

  await page.getByRole("searchbox").fill("739");
  const hospital = page.getByRole("link", {
    name: "A.O. Fox Memorial Hospital",
  });
  await hospital.focus();
  await page.keyboard.press("Enter");
  const panel = page.getByRole("region", { name: "Hospital audits" });
  await panel.getByText("No runs recorded.").waitFor();
  async function choose(mode) {
    await panel.getByRole("button", { name: mode, exact: true }).click();
    await panel.getByRole("button", { name: "Confirm run" }).waitFor();
  }
  const confirm = () =>
    panel.getByRole("button", { name: "Confirm run" }).click();
  const refresh = () =>
    panel.getByRole("button", { name: "Refresh", exact: true }).click();
  async function work(scenario) {
    const job = claim(db);
    assert.ok(job);
    await runPipeline(db, job, (dir, request) =>
      JSON.parse(
        execFileSync(
          process.env.T2P_PYTHON || "python",
          ["backend/test/fixtures/roster-collector.py", dir],
          { input: JSON.stringify({ ...request, scenario }), encoding: "utf8" },
        ),
      ),
    );
    await refresh();
  }
  await choose("Full audit");
  await panel
    .getByText(/Network, compute and storage costs may apply/)
    .waitFor();
  await panel.getByRole("button", { name: "Cancel", exact: true }).click();
  assert.equal(db.prepare("SELECT count(*) n FROM jobs").get().n, 0);
  await choose("Scan documents");
  let lost = false;
  await page.route("**/v1/hospitals/739/runs", async (route) => {
    if (!lost && route.request().method() === "POST") {
      lost = true;
      await route.fetch();
      await route.abort();
    } else await route.continue();
  });
  await confirm();
  await panel.getByRole("button", { name: "Retry same request" }).click();
  await panel
    .getByRole("heading", { name: "audit-run-1", exact: true })
    .waitFor();
  assert.equal(db.prepare("SELECT count(*) n FROM jobs").get().n, 1);
  await work();
  await panel
    .getByRole("link", { name: /Download source/ })
    .first()
    .waitFor();
  await panel.getByText("Campus or document role needs review").waitFor();
  const clocks = async () =>
    (await (await fetch(origin + "/api/pilot/v1/hospitals/739/runs")).json())
      .clocks;
  const fetched = (await clocks()).last_successful_source_retrieval;
  await choose("Replay saved evidence");
  await confirm();
  await panel
    .getByRole("heading", { name: "audit-run-2", exact: true })
    .waitFor();
  await work();
  await panel.getByText("Draft findings", { exact: true }).waitFor();
  assert.equal((await clocks()).last_successful_source_retrieval, fetched);
  await panel.getByText("Cost receipt incomplete.").waitFor();
  await panel.getByText("No incremental model charge.").waitFor();
  await panel.getByRole("button", { name: "audit-run-1", exact: true }).click();
  await panel
    .getByRole("link", { name: /Download source/ })
    .first()
    .waitFor();
  assert.match(page.url(), /hospital=739/);
  await choose("Full audit");
  await confirm();
  await panel
    .getByRole("heading", { name: "audit-run-3", exact: true })
    .waitFor();
  for (let i = 0; i < 3; i++) {
    db.prepare("UPDATE jobs SET available_at=0 WHERE id=3").run();
    failPipeline(db, claim(db));
  }
  await refresh();
  await panel
    .getByText(/Retry scheduled/)
    .first()
    .waitFor();
  await page
    .getByRole("link", { name: "Audit operations", exact: true })
    .click();
  await page
    .getByRole("rowheader", { name: "A.O. Fox Memorial Hospital", exact: true })
    .waitFor();
  await page.screenshot({ path: join(artifacts, "operations-desktop.png") });
  await page
    .getByRole("link", { name: "A.O. Fox Memorial Hospital", exact: true })
    .click();
  await page.getByRole("button", { name: "Español" }).click();
  await page.setViewportSize({ width: 390, height: 844 });
  const es = page.getByRole("region", { name: "Auditorías del hospital" });
  await es.getByRole("button", { name: "audit-run-1", exact: true }).click();
  await es
    .getByRole("link", { name: /Descargar fuente/ })
    .first()
    .waitFor();
  assert.ok((await es.ariaSnapshot()).includes("Evidencia guardada"));
  await es.evaluate((node) => node.scrollIntoView({ block: "start" }));
  await page.screenshot({ path: join(artifacts, "hospital-mobile-es.png") });
  await page.getByRole("link", { name: "Operaciones de auditoría" }).click();
  await page.getByRole("searchbox").fill("739");
  await page
    .getByRole("rowheader", { name: "A.O. Fox Memorial Hospital" })
    .waitFor();
  assert.ok(
    await page.evaluate(
      () => document.documentElement.scrollWidth <= window.innerWidth,
    ),
  );
  // Isolate historical display states that the partial campus fixture cannot produce.
  await page.route("**/v1/runs/audit-run-3", async (route) => {
    const json = await (await route.fetch()).json();
    await route.fulfill({ json: { ...json, status: "completed" } });
  });
  await page.route("**/v1/runs/audit-run-3/receipt", async (route) => {
    const json = await (await route.fetch()).json();
    await route.fulfill({
      json: { ...json, units: { ...json.units, checkpoint_hits: 2 } },
    });
  });
  await page.clock.setFixedTime(new Date("2030-01-01T12:00:00Z"));
  await page
    .getByRole("rowheader", { name: "A.O. Fox Memorial Hospital" })
    .getByRole("link")
    .click();
  await es.getByText("Finalizada", { exact: true }).waitFor();
  assert.equal(
    await es
      .getByText("Reutilizaciones del progreso guardado", { exact: true })
      .locator("+ dd")
      .textContent(),
    "2",
  );
  await es
    .getByText(/Vencida/)
    .first()
    .waitFor();
  // Run the CDN regression through the same button operators use for any roster entry.
  await page.clock.setFixedTime(new Date("2026-11-10T17:00:00Z"));
  await page.goto(origin + "/?hospital=324&lang=en");
  await page.getByRole("button", { name: "Audits and history" }).click();
  await choose("Full audit");
  await confirm();
  await panel.getByRole("heading", { name: "audit-run-4", exact: true }).waitFor();
  await work("public-files");
  await page.getByRole("button", { name: "Findings", exact: true }).click();
  const summary = page.locator("#measure-324-S");
  await summary.locator(":scope > summary").click();
  await summary.getByText("Yes · draft", { exact: true }).waitFor();
  await summary.getByText(/Evidence, dates and scope/).click();
  await summary.locator(".measure-evidence > summary").filter({ hasText: "page 1" }).first().click();
  await summary.locator(".measure-evidence[open] blockquote").filter({ hasText: "Financial Assistance Policy Summary" }).first().waitFor();
  const application = page.locator("#measure-324-R");
  await application.locator(":scope > summary").click();
  await application.getByText(/Linked file unavailable/).first().waitFor();
  assert.deepEqual(errors, []);
  console.log("Offline operations flow passed; screenshots at " + artifacts);
} finally {
  await browser?.close();
  server.kill();
  db.close();
  rmSync(root, { recursive: true, force: true });
}
