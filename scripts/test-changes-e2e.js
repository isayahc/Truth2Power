// Public discovery and deliberately staged HTML changes; never write to a real audit store.
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawn } from "node:child_process";
import { chromium } from "playwright";

const root = mkdtempSync(join(tmpdir(),"SYN-changes-"));
const url = "https://erhny.org/patient-guests/financial-assistance-program/";
mkdirSync(join(root,"collections/1002"),{recursive:true});
mkdirSync(join(root,"snapshots"));
function capture(day, text) {
  const sha256 = createHash("sha256").update(text).digest("hex");
  const artifact_path = "snapshots/" + sha256 + ".html";
  writeFileSync(join(root,artifact_path),text);
  const landing_page = {sha256,url,artifact_path,retrieved_at:`2026-11-${day}T00:00:00Z`,publisher_updated_at:null};
  writeFileSync(join(root,"collections/1002",day+".json"),JSON.stringify({hospital_key:"1002",status:"complete",landing_url:url,landing_page,documents:[]}));
}
const before = "<p>SYN financial assistance through 300% FPL.</p>", after = before.replace("300%","400%");
capture("01",before); capture("02",after); capture("03",after);
const base = "http://127.0.0.1:18235";
const server = spawn(process.execPath,["backend/src/local-server.js"],{env:{...process.env,PORT:"18235",T2P_REVIEW_DIRECTORY:root},
  stdio:["ignore","pipe","inherit"]});
let browser;
try {
  await new Promise((resolve,reject) => {
    const timeout = setTimeout(() => reject(Error("Server startup timeout")),15000);
    server.on("exit",(code) => {clearTimeout(timeout);reject(Error("Server exited "+code));});
    server.stdout.on("data",(s) => {if (s.toString().includes("Truth2Power is running")) {clearTimeout(timeout);resolve();}});
  });
  browser = await chromium.launch({executablePath:process.env.CHROMIUM_PATH || undefined});
  const page = await browser.newPage();
  await page.goto(base);
  await page.getByRole("link",{name:"Recent changes"}).click();
  const articles = page.locator(".changes-feed article");
  await articles.first().waitFor();
  assert.equal(await articles.count(),2);
  const staged = articles.filter({hasText:"Ellenville"});
  await staged.getByText("Earlier and later evidence").click();
  assert.match(await staged.innerText(),/300% FPL/);
  assert.match(await staged.innerText(),/400% FPL/);
  const saved = staged.getByRole("link",{name:"Download saved bytes"}).first();
  const response = await page.request.get(base+await saved.getAttribute("href"));
  assert.equal(await response.text(),before);
  assert.equal(response.headers()["content-type"],"application/octet-stream");
  const original = articles.filter({hasText:"Little Falls"});
  await original.getByText("Earlier and later evidence").click();
  await original.getByRole("heading",{name:"Earlier · unclear"}).waitFor();
  await original.getByRole("heading",{name:"Later · yes"}).waitFor();
  for (const link of await original.getByRole("link",{name:/Saved assessment/}).all()) {
    const path = await link.getAttribute("href");
    const raw = await (await page.request.get(base+path)).body();
    assert.equal(createHash("sha256").update(raw).digest("hex"),path.split("/").at(-1));
  }
  await page.getByRole("button",{name:"Refresh changes"}).click();
  await articles.first().waitFor();
  assert.equal(await articles.count(),2);
  await page.setViewportSize({width:390,height:844});
  assert.ok(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth));
  await page.getByRole("link",{name:"Little Falls Hospital"}).click();
  await page.locator("#measure-362-S").getByText("Yes · draft",{exact:true}).waitFor();
  console.log("Changes feed passed: two verified source versions, repeat suppression, dated discovery, evidence download, mobile and hospital drill-down.");
} finally {
  await browser?.close(); server.kill(); rmSync(root,{recursive:true,force:true});
}
