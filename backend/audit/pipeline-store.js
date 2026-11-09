import { DatabaseSync } from "node:sqlite";
import { existsSync, readFileSync, mkdirSync, writeFileSync, linkSync, unlinkSync } from "node:fs";
import { randomUUID } from "node:crypto";
import { join, resolve } from "node:path";
import { directory, transaction, now } from "./store.js";
import { fingerprint, rubric, hhs, referenceHash } from "../grading/data.js";
import { sha256 } from "../review/identity.js";
import { applicationProfileHash, applicationVisualHash } from "../grading/profiles.js";

export const pipelineRoot = () => resolve(process.env.T2P_REVIEW_DIRECTORY || join(directory, "live"));
export const roster = JSON.parse(readFileSync(new URL("../../data/maps/hospitals.geojson", import.meta.url))).features;
export function immutable(root, path, bytes) {
  const target = join(root, path);
  mkdirSync(join(target, ".."), { recursive: true });
  const temporary = target + "." + randomUUID() + ".tmp";
  writeFileSync(temporary, bytes, { flag: "wx" });
  try { linkSync(temporary, target); }
  catch (e) { if (e.code !== "EEXIST" || !readFileSync(target).equals(Buffer.from(bytes))) throw Error("Immutable artifact collision"); }
  finally { unlinkSync(temporary); }
  return path;
}
export function enqueuePipeline(db, { hospital_key, year = 2026, review_date, mode = "replay", variant = "original", request_key, root = pipelineRoot(), evidence_root = root, discovery_bounds = {} }) {
  const caps = { depth: 8, pages: 100, documents: 100, bytes_per_resource: 12582912, total_bytes: 134217728, timeout: 30, seconds: 150, redirects: 8 };
  if (!discovery_bounds || Array.isArray(discovery_bounds) || Object.entries(discovery_bounds).some(([k, v]) => !Object.hasOwn(caps, k) || !Number.isInteger(v) || v < 1 || v > caps[k])) throw Error("Invalid discovery bounds");
  if (!roster.some((h) => String(h.id) === hospital_key) || ![2025, 2026].includes(year) ||
    !["synthetic", "replay", "live"].includes(mode) || !["original", "corrected", "multilingual"].includes(variant) ||
    !/^[a-zA-Z0-9-]{1,100}$/.test(request_key || "") || !/^\d{4}-\d{2}-\d{2}$/.test(review_date || "") ||
    !Number.isFinite(Date.parse(review_date)) || new Date(review_date).toISOString().slice(0, 10) !== review_date || Number(review_date.slice(0, 4)) !== year) throw Error("Invalid audit job context");
  if (mode !== "synthetic" && !["1002", "362"].includes(hospital_key)) throw Error("Only Wave 1 has a verified classification inventory; other sites remain due");
  if (mode === "synthetic" && hospital_key !== "1002") throw Error("Synthetic fixture is bound to its labeled hospital key 1002");
  const context = { pipeline: 1, engine_version: "multilingual-v1", application_visual_sha256: applicationVisualHash, application_profile_sha256: applicationProfileHash, discovery_bounds, mode, variant, root: resolve(root), evidence_root: resolve(evidence_root),
    hospital_key, year, review_date, rubric_version: rubric.version, rubric_sha256: fingerprint(rubric), reference_version: hhs.reference_version, reference_sha256: referenceHash,
    facility: roster.find((h) => String(h.id) === hospital_key).properties.name };
  const hash = fingerprint(context);
  return transaction(db, () => {
    const old = db.prepare("SELECT * FROM pipeline_requests WHERE request_key=?").get(request_key);
    if (old) { if (old.context_hash !== hash) throw Error("Idempotency key already used with different context"); return Number(old.job); }
    const id = Number(db.prepare("INSERT INTO jobs(hospital,year,rule,review_date,context) VALUES(?,?,?,?,?)")
      .run(hospital_key, year, "css-17-v1", review_date, JSON.stringify(context)).lastInsertRowid);
    db.prepare("INSERT INTO pipeline_requests VALUES(?,?,?)").run(request_key, id, hash);
    return id;
  });
}

/** A single SQLite commit publishes all views and the change event, fenced by the claimed attempt. */
export function publishPipeline(db, job, bundle) {
  return transaction(db, () => {
    const updated = db.prepare("UPDATE jobs SET status='completed',lease=NULL,error=NULL WHERE id=? AND token=? AND status='running'").run(job.id, job.token);
    if (!updated.changes) return false;
    const previous = db.prepare("SELECT a.output FROM assessments a JOIN jobs j ON j.id=a.job WHERE j.hospital=? AND j.year=? AND j.rule='css-17-v1' AND j.id<? ORDER BY j.id DESC")
      .all(job.hospital, job.year, job.id).map((r) => JSON.parse(r.output)).find((r) => r.root === bundle.root && r.input.synthetic === bundle.input.synthetic);
    db.prepare("INSERT INTO assessments VALUES(?,?,?,?)").run(job.id, job.hospital, bundle.report.last_successful_assessment_at, JSON.stringify(bundle));
    const newer = db.prepare("SELECT a.output FROM assessments a JOIN jobs j ON j.id=a.job WHERE j.hospital=? AND j.year=? AND j.rule='css-17-v1' AND j.id>?")
      .all(job.hospital, job.year, job.id).some((r) => { const b = JSON.parse(r.output); return b.root === bundle.root && b.input.synthetic === bundle.input.synthetic; });
    if (!newer && previous && previous.content_fingerprint !== bundle.content_fingerprint) {
      const changed = bundle.input.sources.filter((s) => s.snapshot && previous.content[s.source_id] !== bundle.content[s.source_id]);
      for (const s of changed) {
        const before = previous.input.sources.find((d) => d.source_id === s.source_id && d.snapshot);
        if (!before) continue; // New-source discovery remains a coverage change, not a fabricated before image.
        const evidence = (source, b) => ({ ...source.snapshot, locator: "Saved source bytes", excerpt: "Content changed; inspect the immutable source and assessment.",
          saved_url: `/api/pilot/snapshots/${source.snapshot.sha256}`, assessment_id: b.id, assessment_url: `/api/pilot/assessments/${b.id}` });
        const event = { id: sha256(`${previous.id}:${bundle.id}:${s.source_id}`), hospital_key: job.hospital,
          hospital_name: (bundle.input.synthetic ? "SYNTHETIC — " : "") + job.context.facility, kind: "material_change", detected_at: bundle.report.last_successful_assessment_at,
          description: "Verified source content changed between completed audit revisions.", measures: rubric.measures.filter((m) => m.roles.includes(s.role)).map((m) => m.measure_id),
          before: evidence(before, previous), after: evidence(s, bundle), revision: bundle.id, synthetic: bundle.input.synthetic };
        db.prepare("INSERT OR IGNORE INTO pipeline_events VALUES(?,?,?)").run(event.id, job.id, JSON.stringify(event));
      }
    }
    db.prepare("UPDATE attempts SET status='completed',error=NULL WHERE token=?").run(job.token);
    return true;
  });
}
export function failPipeline(db, job) {
  return transaction(db, () => {
    const message = "Audit failed during retrieval, extraction or verification; prior successful assessment retained.";
    const retry = db.prepare("SELECT attempts FROM jobs WHERE id=? AND token=? AND status='running'").get(job.id, job.token);
    if (!retry) return false;
    db.prepare("UPDATE jobs SET status=?,lease=NULL,error=?,available_at=? WHERE id=? AND token=?")
      .run(retry.attempts < 3 ? "queued" : "failed", message, Date.now() + 1000 * 2 ** retry.attempts, job.id, job.token);
    db.prepare("UPDATE attempts SET status='failed',error=? WHERE token=?").run(message, job.token);
    return true;
  });
}

/** Read committed publications only. Never creates a database on a read path. */
export function publications(root = pipelineRoot(), { includeSynthetic = process.env.T2P_PILOT_DEMO === "1" } = {}) {
  const path = join(directory, "audit.sqlite");
  if (!existsSync(path)) return { bundles: [], failures: [], events: [], jobs: [] };
  const db = new DatabaseSync(path, { readOnly: true });
  try {
    if (!db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='pipeline_events'").get()) return { bundles: [], failures: [], events: [], jobs: [] };
    const rows = db.prepare("SELECT a.output,a.job FROM assessments a JOIN jobs j ON j.id=a.job WHERE j.rule='css-17-v1' ORDER BY a.job DESC").all();
    const bundles = rows.map((r) => ({ ...JSON.parse(r.output), job: r.job })).filter((b) => b.root === resolve(root) && (includeSynthetic || !b.input.synthetic));
    if (bundles.some((b) => b.id !== fingerprint({ input: b.input, report: b.report }))) throw Error("Persisted assessment identity mismatch");
    const jobs = db.prepare("SELECT * FROM jobs WHERE rule='css-17-v1' ORDER BY id DESC").all()
      .map((j) => ({ ...j, context: JSON.parse(j.context) })).filter((j) => j.context.root === resolve(root) && (includeSynthetic || j.context.mode !== "synthetic"));
    const failures = jobs.filter((j) => j.error);
    const ids = new Set(bundles.map((b) => b.job));
    const events = db.prepare("SELECT job,output FROM pipeline_events ORDER BY job DESC").all().filter((r) => ids.has(r.job)).map((r) => JSON.parse(r.output));
    return { bundles, failures, events, jobs };
  } finally { db.close(); }
}
