import { chromium } from "playwright";
import { createHash, randomUUID } from "node:crypto";
import { mkdir, writeFile, rename } from "node:fs/promises";
import { join } from "node:path";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { setTimeout as sleep } from "node:timers/promises";
import { directory, openStore, claim, finish, now } from "./store.js";
import { runPipeline } from "./pipeline.js";

const db = openStore();
const origin = "http://127.0.0.1:" + (process.env.PORT || 8000);
const run = promisify(execFile);
async function snapshot(bytes, type, url) {
  const hash = createHash("sha256").update(bytes).digest("hex");
  const path =
    "snapshots/" + hash + (type === "application" ? ".pdf" : ".html");
  const file = join(directory, path),
    tmp = file + "." + randomUUID();
  await mkdir(join(directory, "snapshots"), { recursive: true });
  await writeFile(tmp, bytes);
  await rename(tmp, file);
  return {
    snapshot_id: hash,
    document_type: type,
    url,
    retrieved_at: now(),
    publisher_updated_at: null,
    sha256: hash,
    artifact_path: path,
  };
}
async function extract(pdf) {
  const parser = "pdf-fpl-row-v1";
  const cached = db
    .prepare("SELECT observation FROM extractions WHERE hash=? AND parser=?")
    .get(pdf.sha256, parser);
  if (cached) return JSON.parse(cached.observation);
  let stdout;
  try {
    ({ stdout } = await run("pdftotext", ["-layout", join(directory, pdf.artifact_path), "-"], { timeout: 15000 }));
  } catch (error) {
    if (error.code !== "ENOENT") throw error;
    // Reuse the installed Python PDF reader on machines without Poppler.
    ({ stdout } = await run(process.env.T2P_PYTHON || "python", ["-c",
      "import sys,json;from pypdf import PdfReader;print(json.dumps([p.extract_text() or '' for p in PdfReader(sys.argv[1]).pages]))",
      join(directory, pdf.artifact_path)], { timeout: 15000 }));
    stdout = JSON.parse(stdout).join("\f");
  }
  const matches = [];
  for (const [index, page] of stdout.split("\f").entries()) {
    for (const line of page.split("\n")) {
      const match =
        /^One-person household\s*\|\s*400% FPL\s*\|\s*\$([\d,]+) per year$/.exec(
          line.trim(),
        );
      if (match)
        matches.push({
          amount: Number(match[1].replaceAll(",", "")),
          quote: line.trim(),
          locator: "page " + (index + 1),
        });
    }
  }
  const observation = matches.length === 1 ? matches[0] : null;
  db.prepare("INSERT OR IGNORE INTO extractions VALUES(?,?,?)").run(
    pdf.sha256,
    parser,
    JSON.stringify(observation),
  );
  return observation;
}
async function audit(job) {
  const browser = await chromium.launch({
    executablePath: process.env.CHROMIUM_PATH || undefined,
  });
  try {
    const page = await browser.newPage({ javaScriptEnabled: false });
    await page.route("**/*", (route) =>
      new URL(route.request().url()).origin === origin
        ? route.continue()
        : route.abort(),
    );
    const url = new URL(job.context.source, origin).href;
    const landing = await page.goto(url, { timeout: 15000 });
    if (!landing?.ok()) throw Error("Landing page unavailable");
    const html = await snapshot(await landing.body(), "landing_page", url);
    db.prepare("UPDATE jobs SET checkpoint=? WHERE id=? AND token=?").run(
      JSON.stringify(html),
      job.id,
      job.token,
    );
    const link = page
      .locator('a[data-campus="362"]')
      .filter({ hasText: "Financial assistance application" });
    const pdfUrl = new URL(
      await link.getAttribute("href", { timeout: 5000 }),
      url,
    );
    if (pdfUrl.origin !== origin) throw Error("Unexpected fixture origin");
    const response = await page.request.get(pdfUrl.href, {
      timeout: 15000,
      maxRedirects: 0,
    });
    if (!response.ok()) throw Error("Application unavailable");
    const bytes = await response.body();
    if (bytes.subarray(0, 5).toString() !== "%PDF-")
      throw Error("Invalid application PDF");
    const pdf = await snapshot(bytes, "application", pdfUrl.href);
    const observation = await extract(pdf);
    const expected = job.context.expected_amount,
      completed = now();
    const amount = (value) => ({
      amount: value,
      period: "annual",
      currency: "USD",
      household_size: 1,
      fpl_percent: 400,
    });
    const result = observation
      ? observation.amount === expected
        ? "yes"
        : "no"
      : "unclear";
    const finding = {
      measure_id: job.rule,
      result,
      reason_code: {
        yes: "condition_met",
        no: "contradicted",
        unclear: "insufficient_evidence",
      }[result],
      explanation: observation
        ? `Published annual amount ${observation.amount}; expected ${expected} for ${job.year}.`
        : "A unique applicable row could not be verified.",
      observed: observation ? amount(observation.amount) : null,
      expected: amount(expected),
      evidence: observation
        ? [
            {
              snapshot_id: pdf.snapshot_id,
              quote: observation.quote,
              locator: observation.locator,
            },
          ]
        : [],
    };
    return {
      schema_version: "1.0",
      hospital_key: job.hospital,
      rubric_version: job.context.rubric,
      reference_version: job.context.reference_version,
      guideline_year: job.year,
      review_date: job.review_date,
      attempt: {
        attempt_id: job.token,
        attempted_at: job.attempted,
        status: "completed",
      },
      last_successful_assessment_at: completed,
      snapshots: [html, pdf],
      assessment: {
        assessment_id: "audit-" + job.id,
        completed_at: completed,
        findings: [finding],
      },
    };
  } finally {
    await browser.close();
  }
}
do {
  const job = claim(db);
  if (job) {
    const heartbeat = setInterval(
      () =>
        db
          .prepare(
            "UPDATE jobs SET lease=? WHERE id=? AND token=? AND status='running'",
          )
          .run(Date.now() + 90000, job.id, job.token),
      20000,
    );
    try {
      if (job.context.pipeline) await runPipeline(db, job);
      else finish(db, job, await audit(job));
    } catch (error) {
      if (!job.context.pipeline) finish(
        db,
        job,
        null,
        "Retrieval or extraction failed. Check the server, browser and pdftotext, then retry.",
      );
      console.error("audit_failed", job.id, error.name);
    } finally {
      clearInterval(heartbeat);
    }
  } else if (!process.argv.includes("--once")) await sleep(750);
} while (!process.argv.includes("--once"));
