import { randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { openStore, claim } from "./store.js";
import { enqueuePipeline, pipelineRoot } from "./pipeline-store.js";
import { runPipeline } from "./pipeline.js";
import { grade } from "../grading/grade.js";
import { overview } from "../overview/service.js";
import { fingerprint, rubric } from "../grading/data.js";

const args = process.argv.slice(2), command = args.shift();
const option = (key, fallback) => args.includes(key) ? args[args.indexOf(key) + 1] : fallback;
const year = Number(option("--year", "2026"));
const date = option("--date", `${year}-11-09`);
let db, targetId;
try {
  if (command === "replay") {
    const b = JSON.parse(readFileSync(args[0]));
    if (b.id !== fingerprint({ input: b.input, report: b.report }) || b.rubric_sha256 !== fingerprint(rubric)) throw Error("Assessment identity or rubric bytes differ");
    const report = grade(b.input, { root: resolve(option("--root", pipelineRoot())) });
    if (JSON.stringify(report) !== JSON.stringify(b.report)) throw Error("Replay differs from committed report");
    console.log(JSON.stringify({ assessment_id: b.id, measures: report.findings.length, replay: "identical", grade_status: report.grade_status }));
  } else if (command === "due") {
    const report = overview();
    console.log(JSON.stringify({ denominator: report.hospitals.length, due: report.hospitals.filter((h) => h.freshness !== "current").map((h) => ({ hospital_key: h.hospital_key, next_due_at: h.next_due_at, status: h.freshness })) }, null, 2));
  } else if (["run", "queue", "work"].includes(command)) {
    db = openStore();
    if (command !== "work") {
      const id = enqueuePipeline(db, { hospital_key: option("--hospital", "1002"), year, review_date: date, mode: option("--mode", "replay"),
        variant: option("--variant", "original"), request_key: option("--request", randomUUID()), evidence_root: resolve(option("--evidence-root", pipelineRoot())) });
      console.log(JSON.stringify({ job_id: id, queued: true }));
      targetId = id;
      if (command === "queue") process.exitCode = 0;
    }
    if (command !== "queue") {
      const job = claim(db, 600000, { id: targetId ?? null, rule: "css-17-v1" });
      if (job) {
        const b = await runPipeline(db, job);
        console.log(JSON.stringify({ job_id: job.id, revision: b?.id, findings: b?.report.findings.length, grade_status: b?.report.grade_status,
          calculated_grade: b?.report.calculated_grade, unresolved: b?.report.unresolved_measures.length, path: b && `pipeline-assessments/${b.id}.json` }));
      } else console.log(JSON.stringify({ idle: true }));
    }
  } else throw Error("Use run|queue|work|replay|due; see docs/validation/pilot-operations.md");
} catch (error) { console.error("pipeline_cli_failed", error.message); process.exitCode = 1; }
finally { db?.close(); }
