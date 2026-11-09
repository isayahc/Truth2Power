// Read-only browser test against the shipped roster and a temporary empty review store.
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawn } from "node:child_process";
import { chromium } from "playwright";

const root = mkdtempSync(join(tmpdir(),"SYN-overview-"));
const port = 18229, base = "http://127.0.0.1:" + port;
const server = spawn(process.execPath,["backend/src/local-server.js"],{
  env:{...process.env,PORT:String(port),T2P_REVIEW_DIRECTORY:root},stdio:["ignore","pipe","inherit"]});
let browser;
try {
  await new Promise((ready,reject) => {
    const timer = setTimeout(() => reject(Error("Server startup timeout")),15000);
    server.once("exit",(code) => {clearTimeout(timer);reject(Error("Server exited " + code));});
    server.stdout.on("data",(b) => {if(b.toString().includes("Truth2Power is running")) {clearTimeout(timer);ready();}});
  });
  browser = await chromium.launch({executablePath:process.env.CHROMIUM_PATH || undefined});
  const page = await browser.newPage();
  await page.goto(base);
  await page.getByRole("link",{name:"Audit overview"}).click();
  const data = await (await page.request.get(base + "/api/overview")).json();
  const h = data.hospitals.find((item) => item.hospital_key === "1002");
  const g = data.regions.find((r) => r.region === h.region);
  const label = h.freshness === "current" ? "Current" : "Overdue";
  await page.getByRole("button",{name:`${g.region} · ${label} · ${g.freshness[h.freshness]}`,exact:true}).click();
  const list = page.getByRole("table",{name:"Hospital directory"});
  assert.equal(await list.locator("tbody tr").count(),1);
  assert.match(await list.innerText(),/Ellenville/);
  const detail = await list.getByRole("link").getAttribute("href");
  assert.ok(detail.includes(h.revision));
  await page.getByRole("button",{name:"Show coverage map"}).click();
  await page.getByRole("button",{name:`${h.name} · ${label}`,exact:true}).first().click();
  await page.getByRole("region",{name:"Current hospital findings"}).waitFor();
  assert.ok(page.url().includes(h.revision));
  await page.goBack();
  await page.getByRole("heading",{name:"Audit overview"}).waitFor();
  await page.getByRole("button",{name:/^AH ·/}).click();
  await list.getByRole("link",{name:"Ellenville Regional Hospital"}).click();
  await page.getByRole("region",{name:"Current hospital findings"}).waitFor();
  assert.equal(new URL(page.url()).hash,"#measure-1002-AH");
  const card = page.locator("#measure-1002-AH");
  await card.getByText(/Draft a correction request/).first().click();
  const letter = card.getByRole("textbox").first();
  assert.match(await letter.inputValue(),/https:\/\//);
  await letter.fill("SYN editable draft");
  await page.goto(base + "/?hospital=1002&revision=SYN-stale");
  await page.getByRole("link",{name:"Refresh the overview"}).click();
  await page.setViewportSize({width:390,height:844});
  await list.waitFor();
  assert.ok(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth));
  console.log("Overview browser checks passed: regional counts, filtered map, revision links, draft evidence, editable request, stale revision and mobile layout.");
} finally {
  await browser?.close();
  server.kill();
  rmSync(root,{recursive:true,force:true});
}
