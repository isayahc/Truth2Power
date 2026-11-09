// Run IDs are stable within the SQLite store, including for pre-migration jobs.
export const runId = (job) => `audit-run-${job}`;

export function event(db, job, token, state, detail = {}) {
  db.prepare("INSERT INTO audit_run_events(job,attempt,state,at,detail) VALUES(?,?,?,?,?)")
    .run(job, token, state, new Date().toISOString(), JSON.stringify(detail));
}

/** Record only work performed by the currently claimed worker. */
export function stage(db, job, name, details = {}) {
  db.prepare(`INSERT INTO audit_run_events(job,attempt,state,at,detail)
    SELECT id,token,'stage',?,? FROM jobs WHERE id=? AND token=? AND status='running'`)
    .run(new Date().toISOString(), JSON.stringify({ name, ...details }), job.id, job.token);
}

/** Publish a terminal event in the same transaction as the job and artifact pointer. */
export function recordPublication(db, job, artifact) {
  const scan = artifact.mode === "discovery_only";
  const partial = scan ? artifact.discovery.status !== "complete" || artifact.inventory.gaps.length > 0 :
    artifact.report.unresolved_measures.length > 0 || artifact.report.coverage_gaps.length > 0;
  const live = ["live", "full_audit", "discovery_only"].includes(job.context.mode);
  const captures = live ? (artifact.inventory?.sources ?? []).filter((s) => s.capture_status === "saved" && s.provenance !== "curated_inventory")
    .map((s) => ({ url: s.source_id, sha256: s.digest, retrieved_at: s.retrieved_at })) : [];
  event(db, job.id, job.token, partial ? "partial" : "completed", {
    assessment_id: scan ? null : artifact.id, scan_id: scan ? artifact.id : null, captures,
    unresolved_measures: artifact.report?.unresolved_measures.length ?? null,
    coverage_gaps: (scan ? artifact.inventory.gaps : artifact.report.coverage_gaps).length,
  });
}

/** Local operator read contract. Read a consistent snapshot, scoped to one evidence store. */
export function hospitalHistory(db, hospital, root, asOf = new Date()) {
  db.exec("BEGIN");
  try {
    const jobs = db.prepare(`SELECT j.*,r.request_key,a.completed,a.job AS assessment_job,
      json_extract(a.output,'$.id') AS assessment_id FROM jobs j
      LEFT JOIN pipeline_requests r ON r.job=j.id LEFT JOIN assessments a ON a.job=j.id
      WHERE j.hospital=? AND j.rule='css-17-v1' AND json_extract(j.context,'$.root')=? ORDER BY j.id DESC`).all(hospital, root);
    const clocks = { last_attempted: null, last_completed_execution: null, last_successful_source_retrieval: null, last_eligible_assessment: null };
    const runs = jobs.map((j) => {
      const context = JSON.parse(j.context), audit_run_id = runId(j.id);
      const events = db.prepare("SELECT * FROM audit_run_events WHERE job=? ORDER BY seq").all(j.id)
        .map((e) => ({ ...e, detail: JSON.parse(e.detail) }));
      const attempts = db.prepare("SELECT token AS attempt_id,started,status,error FROM attempts WHERE job=? ORDER BY started,rowid").all(j.id);
      const terminal = events.find((e) => ["partial", "completed"].includes(e.state));
      const update = (key, at, attempt, latestJob = false) => {
        if (at && context.mode !== "synthetic" && (!clocks[key] || (!latestJob && Date.parse(at) > Date.parse(clocks[key].at))))
          clocks[key] = { at, audit_run_id, attempt_id: attempt, mode: context.mode };
      };
      update("last_attempted", j.attempted, j.token);
      update("last_completed_execution", terminal?.at ?? j.completed, j.token);
      for (const c of terminal?.detail.captures ?? []) update("last_successful_source_retrieval", c.retrieved_at, terminal.attempt);
      if (["full_audit", "live"].includes(context.mode) && j.assessment_job)
        update("last_eligible_assessment", j.completed, j.token, true);
      const status = terminal?.state ?? (j.status === "queued" && j.error ? "retrying" : j.status);
      return { audit_run_id, job_id: j.id, request_key: j.request_key, hospital_key: j.hospital, context,
        status, error: j.error, assessment_id: j.assessment_id, scan_id: terminal?.detail.scan_id ?? JSON.parse(j.checkpoint || "{}").scan_id ?? null,
        attempts, events };
    });
    const last = clocks.last_successful_source_retrieval;
    const due = last && new Date(Date.parse(last.at) + 30 * 86400000);
    const unknownLegacyFetch = runs.some((r) => ["live", "full_audit", "discovery_only"].includes(r.context.mode) &&
      r.status === "completed" && !r.events.length);
    const freshness = due ? (asOf >= due ? "overdue" : "current") : (unknownLegacyFetch ? "unknown" : "never");
    db.exec("COMMIT");
    return { hospital_key: hospital, runs, ...clocks, next_due_at: due?.toISOString() ?? null,
      freshness };
  } catch (error) { db.exec("ROLLBACK"); throw error; }
}
