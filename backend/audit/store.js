import { installLedger } from "./usage-ledger.js";
import { event } from "./run-history.js";
import { DatabaseSync } from "node:sqlite";
import { randomUUID } from "node:crypto";
import { mkdirSync } from "node:fs";
import { resolve, join } from "node:path";

export const directory = resolve(process.env.AUDIT_DIR || ".audit");
export const now = () => new Date().toISOString();
export function openStore(root = directory) {
  mkdirSync(root, { recursive: true });
  const db = new DatabaseSync(join(root, "audit.sqlite"));
  db.exec(`PRAGMA busy_timeout=5000; PRAGMA journal_mode=WAL;
    CREATE TABLE IF NOT EXISTS audit_quota(job INTEGER,unit TEXT,used INTEGER NOT NULL,PRIMARY KEY(job,unit));
    CREATE TABLE IF NOT EXISTS paid_reservations(job INTEGER,request_key TEXT,binding TEXT,tokens INTEGER,micros INTEGER,PRIMARY KEY(job,request_key));
    CREATE TABLE IF NOT EXISTS jobs (
      id INTEGER PRIMARY KEY, hospital TEXT NOT NULL, year INTEGER NOT NULL, rule TEXT NOT NULL,
      review_date TEXT NOT NULL, context TEXT NOT NULL, status TEXT NOT NULL DEFAULT 'queued',
      token TEXT, lease INTEGER, checkpoint TEXT, attempted TEXT, error TEXT, attempts INTEGER DEFAULT 0);
    CREATE TABLE IF NOT EXISTS assessments (job INTEGER PRIMARY KEY, hospital TEXT, completed TEXT, output TEXT NOT NULL);
    CREATE INDEX IF NOT EXISTS assessment_history ON assessments(hospital,job);
    CREATE TABLE IF NOT EXISTS extractions (hash TEXT, parser TEXT, observation TEXT, PRIMARY KEY(hash,parser));
    CREATE TABLE IF NOT EXISTS corrections (id INTEGER PRIMARY KEY, hospital TEXT, rule TEXT, note TEXT, recorded TEXT);
    CREATE TABLE IF NOT EXISTS attempts (token TEXT PRIMARY KEY, job INTEGER, started TEXT, status TEXT, error TEXT);
    CREATE TABLE IF NOT EXISTS pipeline_requests (request_key TEXT PRIMARY KEY, job INTEGER NOT NULL, context_hash TEXT NOT NULL);
    CREATE TABLE IF NOT EXISTS audit_run_events (
      seq INTEGER PRIMARY KEY, job INTEGER NOT NULL, attempt TEXT, state TEXT NOT NULL, at TEXT NOT NULL, detail TEXT NOT NULL);
    CREATE TRIGGER IF NOT EXISTS audit_events_no_update BEFORE UPDATE ON audit_run_events
      BEGIN SELECT RAISE(ABORT,'immutable audit event'); END;
    CREATE TRIGGER IF NOT EXISTS audit_events_no_delete BEFORE DELETE ON audit_run_events
      BEGIN SELECT RAISE(ABORT,'immutable audit event'); END;
    CREATE INDEX IF NOT EXISTS audit_events_by_job ON audit_run_events(job,seq);
    CREATE INDEX IF NOT EXISTS attempts_by_job ON attempts(job);
    CREATE INDEX IF NOT EXISTS audit_jobs_by_hospital ON jobs(hospital,rule,id);
    CREATE TABLE IF NOT EXISTS pipeline_events (id TEXT PRIMARY KEY, job INTEGER NOT NULL, output TEXT NOT NULL);`);
  if (!db.prepare("PRAGMA table_info(jobs)").all().some((c) => c.name === "available_at")) db.exec("ALTER TABLE jobs ADD COLUMN available_at INTEGER NOT NULL DEFAULT 0");
  installLedger(db);
  return db;
}
export function transaction(db, fn) {
  db.exec("BEGIN IMMEDIATE");
  try {
    const value = fn();
    db.exec("COMMIT");
    return value;
  } catch (error) {
    db.exec("ROLLBACK");
    throw error;
  }
}
export function history(db, hospital) {
  const row = db
    .prepare(
      "SELECT a.output FROM assessments a JOIN jobs j ON j.id=a.job WHERE a.hospital=? AND j.rule='application.fpl_guidelines' ORDER BY a.job DESC LIMIT 1",
    )
    .get(hospital);
  return row ? JSON.parse(row.output) : null;
}
export function enqueue(db, year) {
  const hospital = "362",
    rule = "application.fpl_guidelines";
  return transaction(db, () => {
    const pending = db
      .prepare(
        "SELECT id FROM jobs WHERE hospital=? AND year=? AND rule='application.fpl_guidelines' AND status IN ('queued','running')",
      )
      .get(hospital, year);
    if (pending) return pending.id;
    const previous = history(db, hospital);
    const context = {
      site: "Little Falls Hospital",
      source: "/audit-demo/index.html",
      scope: "synthetic single-campus fixture",
      reference: "https://aspe.hhs.gov/poverty-guidelines",
      rubric: "demo-v1",
      reference_version: `hhs-${year}-contiguous-us`,
      expected_amount: year === 2026 ? 63840 : 62600,
      previous_assessment: previous?.assessment.assessment_id ?? null,
      prior_findings:
        previous?.assessment.findings.filter((f) => f.measure_id === rule) ??
        [],
      corrections: db
        .prepare(
          "SELECT note,recorded FROM corrections WHERE hospital=? AND rule=? ORDER BY id",
        )
        .all(hospital, rule),
    };
    return Number(
      db
        .prepare(
          "INSERT INTO jobs(hospital,year,rule,review_date,context) VALUES(?,?,?,?,?)",
        )
        .run(hospital, year, rule, now().slice(0, 10), JSON.stringify(context))
        .lastInsertRowid,
    );
  });
}
export function claim(db, leaseMs = 90000, { id = null, rule = null } = {}) {
  return transaction(db, () => {
    const time = Date.now();
    const job = db
      .prepare(
        "SELECT * FROM jobs WHERE ((status='queued' AND available_at<=?) OR (status='running' AND lease<=?)) AND (? IS NULL OR id=?) AND (? IS NULL OR rule=?) ORDER BY id LIMIT 1",
      )
      .get(time, time, id, id, rule, rule);
    if (!job) return null;
    if (job.token && job.status === "running") {
      if (job.rule === "css-17-v1") event(db, job.id, job.token, "interrupted", { reason: "Worker lease expired" });
      db.prepare("UPDATE attempts SET status='interrupted' WHERE token=?").run(
        job.token,
      );
      if (job.rule === "css-17-v1" && job.attempts >= 1 + (JSON.parse(job.context).budget?.retries ?? 2)) {
        const reason = "Retry limit reached after worker lease expired";
        db.prepare("UPDATE jobs SET status='failed',lease=NULL,error=? WHERE id=?").run(reason, job.id);
        event(db, job.id, job.token, "failed", { reason, stop_code:"quota_exceeded",unit:"retries" });
        return null;
      }
    }
    const token = randomUUID(),
      attempted = now();
    db.prepare(
      "UPDATE jobs SET status='running', attempts=attempts+1,token=?,lease=?,attempted=? WHERE id=?",
    ).run(token, time + leaseMs, attempted, job.id);
    db.prepare("INSERT INTO attempts VALUES(?,?,?,'running',NULL)").run(
      token,
      job.id,
      attempted,
    );
    if (job.rule === "css-17-v1") event(db, job.id, token, "started");
    return { ...job, context: JSON.parse(job.context), token, attempted };
  });
}
export function finish(db, job, output, error = null) {
  return transaction(db, () => {
    const status = error ? "failed" : "completed";
    const update = db
      .prepare(
        "UPDATE jobs SET status=?,error=?,lease=NULL WHERE id=? AND token=? AND status='running'",
      )
      .run(status, error, job.id, job.token);
    if (!update.changes) return false;
    if (output)
      db.prepare("INSERT INTO assessments VALUES(?,?,?,?)").run(
        job.id,
        job.hospital,
        output.assessment.completed_at,
        JSON.stringify(output),
      );
    db.prepare("UPDATE attempts SET status=?,error=? WHERE token=?").run(
      status,
      error,
      job.token,
    );
    return true;
  });
}
