import { BudgetStop, deadline, defaults } from "./budgets.js";
import { meterAttempt, meterStage, measure } from "./usage-ledger.js";
import { documentAttempts, failureDiagnostic } from "./failure-diagnostic.js";
import { stage } from "./run-history.js";
import { readFileSync, existsSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { execFile } from "node:child_process";
import { rubric, hhs, referenceHash, contextOf, expectedFor, readArtifact, fingerprint, validateSchema, confirmedDocuments } from "../grading/data.js";
import { grade } from "../grading/grade.js";
import { applicationProfileHash, applicationVisualHash } from "../grading/profiles.js";
import { sha256, languageTag } from "../review/identity.js";
import { reportingContext } from "../reporting/context.js";
import { localRecords, latestByScope, projectRecord } from "../hospital-page/records.js";
import { immutable, publishPipeline, publishScan, failPipeline } from "./pipeline-store.js";
import { facilityFor, sourceInventory, savedCollection } from "./roster-inventory.js";
import { readClassifications } from "../grading/source-classification.js";
import { reviewCapturedSources, attachWebsiteLinks } from "./evidence-workers.js";
import { reconcileFindings } from "./assessment-coordinator.js";
import { adaptArtifact } from "../grading/adapter.js";
import { normalizeObservations } from "./normalize-observations.js";

const examples = fileURLToPath(new URL("../../docs/grading/examples/", import.meta.url));
async function bridge(root, request) {
  // execFile's stdin is written explicitly; no shell or model-selected command.
  const remaining = request.deadline - Date.now();
  if (remaining <= 0) throw new BudgetStop("budget_exhausted","seconds");
  return new Promise((resolve, reject) => {
    const child = execFile(process.env.T2P_PYTHON || "python", [fileURLToPath(new URL("../../tools/live-audit/pipeline_bridge.py", import.meta.url)), "--root", root],
      { timeout: Math.min(remaining, request.mode === "live" ? 180000 : 120000), maxBuffer: 32 * 1024 * 1024 }, (error, stdout) => {
        try {
          if (error?.killed && error.code !== "ERR_CHILD_PROCESS_STDIO_MAXBUFFER") {
            measure({ telemetry_missing: 1 });
            return reject(new BudgetStop("budget_exhausted", "seconds"));
          }
          if (error) throw Error();
          const packet = JSON.parse(stdout);
          measure(packet.usage);
           if (packet.failed) {
             const error = Error("Collection or extraction failed");
             if (failureDiagnostic(packet.error_code, packet.diagnostic)) {
               error.code = packet.error_code;
               error.diagnostic = packet.diagnostic;
             }
             return reject(error);
           }
          resolve(packet.result);
        } catch {
          measure({ telemetry_missing: 1 });
          reject(Error("Bridge terminated without complete usage"));
        }
      });
    child.stdin.on("error", () => {});
    child.stdin.end(JSON.stringify({ ...request, meter: true }));
  });
}
function context(job) {
  return { schema_version: "grading-input-v1", synthetic: job.context.mode === "synthetic", hospital_key: job.hospital,
    assessment_id: `audit-${job.id}`, scope_id: "hospital-pilot-v1", rubric_version: rubric.version, reference_version: hhs.reference_version,
    guideline_year: job.year, review_date: job.review_date, attempt: { attempt_id: job.token, attempted_at: job.attempted, status: "completed" },
    last_successful_assessment_at: new Date().toISOString(), refresh_status: "current" };
}

function synthetic(job) {
  const seed = JSON.parse(readFileSync(join(examples, job.context.variant === "multilingual" ? "SYN-multilingual.json" : `SYN-${job.year}.json`)));
  const input = { ...seed, ...context(job) }, content = {};
  for (const source of input.sources) {
    if (!source.snapshot) continue;
    let raw = readArtifact(examples, source.snapshot.artifact_path);
    if (sha256(raw) !== source.snapshot.sha256) throw Error("Fixture snapshot checksum mismatch");
    const published = JSON.parse(raw);
    if (job.context.variant === "corrected" && source.role === "application" && published.fields.fpl) {
      published.fields.fpl.published_year = job.year;
      for (const cell of published.fields.fpl.cells) cell.amount = hhs.years[job.year].household_amounts[cell.household_size - 1] * cell.fpl_percent / 100;
      raw = Buffer.from(JSON.stringify(published, null, 2) + "\n");
    }
    const digest = sha256(raw), path = `snapshots/${digest}.json`;
    immutable(job.context.root, path, raw);
    source.snapshot = { ...source.snapshot, snapshot_id: digest, sha256: digest, artifact_path: path, retrieved_at: job.attempted };
    content[source.source_id] = fingerprint(published);
    for (const f of input.findings) {
      const measure = rubric.measures.find((m) => m.measure_id === f.measure_id);
      for (const e of f.evidence.filter((e) => e.source_id === source.source_id)) {
        e.sha256 = digest; e.snapshot_id = digest; e.quote = JSON.stringify(published.fields[measure.evaluator]);
      }
      for (const o of f.observed) if (f.evidence[o.evidence_index].source_id === source.source_id) o.value = JSON.parse(f.evidence[o.evidence_index].quote);
      if (job.context.variant === "corrected" && measure.evaluator === "fpl") f.result = "yes";
    }
  }
  input.findings = input.findings.map((f) => ({ ...f, ...contextOf(input), expected: expectedFor(rubric.measures.find((m) => m.measure_id === f.measure_id), job.year), human_review: "pending" }));
  return { input, content, producer_records: [], extraction: { mode: "published-fields-v1", note: "Synthetic original structured publications; not a PDF transcription." } };
}

async function real(db, job, collect) {
  const root = job.context.root, originalRoot = job.context.evidence_root;
  const display = reportingContext(job.hospital), gaps = ["Complete website/online-application discovery and governing interpretations require review; direct links do not prove absence."];
  const facility = facilityFor(job.hospital);
  if (job.context.roster_sha256 && fingerprint(facility) !== job.context.roster_sha256) throw Error("Roster changed; enqueue a new job");
  const curated = new URL(`../../docs/hospital-pages/${job.hospital}.json`, import.meta.url);
  const pinned = existsSync(curated) ? JSON.parse(readFileSync(curated)).records : [];
  const postingPath = `docs/audit-format/changes/${facility.hospital_key}-summary-posting.json`;
  const postingFile = new URL("../../" + postingPath, import.meta.url);
  if (existsSync(postingFile)) {
    const prior = projectRecord(readFileSync(postingFile), postingPath, "posting");
    if (prior?.hospital_key === facility.hospital_key) pinned.push(prior);
  }
  const local = localRecords(originalRoot);
  if (local.unavailable.length) gaps.push(`${local.unavailable.length} source-review artifacts could not be read.`);
  const records = [...new Map([...pinned, ...local.records.filter((r) => r.hospital_key === job.hospital)].map((r) => [r.record_id, r])).values()];
  const candidates = records.flatMap((r) => r.findings.flatMap((f) => f.evidence));
  const seeds = (display?.documents ?? []).map((d) => ({ source_id: d.url, role: d.role, language: languageTag(d.language), digest: d.sha256,
    retrieved_at: d.retrieved_at, publisher_updated_at: null }));
  if (job.context.manual_import) {
    const raw = readArtifact(root, `human-imports/${job.context.manual_import}.json`);
    if (sha256(raw) !== job.context.manual_import) throw Error('Human import checksum mismatch');
    const imported = JSON.parse(raw);
    if (imported.hospital_key !== job.hospital) throw Error('Human import hospital mismatch');
    seeds.length = 0;
    seeds.push(...imported.documents.map(d => ({source_id:d.source_url, role:'unclassified', language:d.language,
      digest:d.sha256, artifact_path:d.artifact_path, retrieved_at:d.retrieved_at, provenance:'human_import', campus_applicability:'unknown'})));
    gaps.push('Human-supplied public documents. Retrieval dates are operator-attested; campus, role and discovery completeness require review.');
  }
  for (const r of pinned) for (const s of r.landing_page || []) {
    const e = candidates.find((e) => e.url === s.url);
    if (e && !seeds.some((d) => d.source_id === s.url)) seeds.push({ source_id: s.url, role: "landing_page", language: "en", digest: e.sha256, retrieved_at: e.retrieved_at });
  }
  const replay = job.context.mode === "replay", scan = job.context.mode === "discovery_only";
  meterStage(replay ? "load_saved_evidence" : "collect_sources");
  stage(db, job, replay ? "load_saved_evidence" : "collect_sources");
  const end = deadline(db,job);
  const collected = replay ? null : await collect(root, {
    deadline:end, run_budget:{job:job.id,token:job.token,limits:job.context.budget??defaults,deadline:end,
      database:db.prepare("PRAGMA database_list").all().find(row=>row.name==="main").file},
    mode: "live", hospital_key: job.hospital, bounds: job.context.discovery_bounds, discovery_only: scan,
  });
  if (collected?.budget_stop) {
    stage(db,job,"collection_stopped",{manifest:collected.manifest, document_attempts:documentAttempts(collected.collection), captures:[...(collected.collection.pages??[]),...collected.collection.documents]
      .filter(s=>s.status==="saved").map(s=>({sha256:s.sha256,retrieved_at:s.retrieved_at}))});
    throw new BudgetStop(collected.budget_stop==="seconds"?"budget_exhausted":"quota_exceeded",collected.budget_stop);
  }
  const collection = job.context.manual_import ? null : replay ? savedCollection(originalRoot,job.hospital) : collected.collection;
  if (collection && !replay) stage(db, job, "collection_saved", { collection_sha256: fingerprint(collection), document_attempts: documentAttempts(collection),
    captures: [...(collection.pages || []), ...collection.documents].filter(s => s.status === "saved").map(s => ({
      source_id: s.source_url, sha256: s.sha256, retrieved_at: s.retrieved_at })) });
  const inventory = sourceInventory(facility, collection, seeds, replay ? originalRoot : root);
  const documents = inventory.sources;
  gaps.push(...inventory.gaps);
  const classifications = readClassifications(root, job.context.classification_sha256, job.hospital);
  const verified = [...confirmedDocuments];
  const input = { ...context(job), scope: { inventory_status: "partial", online_application: "unknown", required_sources: [], gaps }, sources: [], findings: [] };
  for (const d of documents) {
    const source = { source_id: d.source_id, hospital_key: job.hospital, role: d.role, language: d.language, status: "unavailable", snapshot: null };
    const from = replay ? originalRoot : root;
    const suffix = [".pdf", ".docx", ".html"].find((ext) => d.digest && (!d.artifact_path || d.artifact_path.endsWith(ext)) && existsSync(join(from, `snapshots/${d.digest}${ext}`)));
    if (suffix) {
      const path = `snapshots/${d.digest}${suffix}`, raw = readArtifact(from, path);
      Object.assign(d, { artifact_path: path, capture_status: "saved" });
      if (sha256(raw) !== d.digest) throw Error("Source snapshot checksum mismatch");
      immutable(root, path, raw);
      source.snapshot = { snapshot_id: d.digest, sha256: d.digest, artifact_path: path, url: d.source_id, retrieved_at: d.retrieved_at, publisher_updated_at: null };
      if (d.published_link) source.snapshot.published_link = d.published_link;
      if (d.final_url && d.final_url !== d.source_id) {
        source.snapshot.final_url = d.final_url;
        source.snapshot.redirects = d.redirects;
      }
      source.status = "available";
      const review = classifications.find((c) => c.source_id === d.source_id && c.sha256 === d.digest);
      if (review && d.role === "unclassified" && d.campus_applicability !== "other_campus_requires_review") {
        source.role = review.role;
        source.language = review.language;
        source.classification_sha256 = job.context.classification_sha256;
        Object.assign(d, { role: review.role, language: review.language, campus_applicability: "applicable",
          provenance: "operator_classification", classification_sha256: source.classification_sha256 });
        verified.push(review);
      }
      if (scan && source.role === "unclassified") gaps.push(`Classify document role and campus (${d.campus_applicability}): ${d.source_id}`);
      if (source.language === "und") gaps.push(`Unknown language: ${d.source_id}`);
    } else {
      if (d.digest) d.capture_status = "snapshot_unavailable";
      gaps.push(`Obtain original snapshot or recollect unavailable source: ${d.source_id}`);
    }
    input.sources.push(source);
  }
  if (!documents.some((d) => d.role === "psa_reference")) gaps.push("Independent governing service-area reference unavailable.");
  for (const review of classifications) {
    if (!documents.some((d) => d.source_id === review.source_id && d.classification_sha256)) gaps.push(`Classification did not bind to the captured document: ${review.source_id}`);
  }
  inventory.gaps = [...new Set(gaps)];
  if (scan) return { inventory, discovery: collection };
  input.scope.required_sources = input.sources.map((s) => s.source_id);
  meterStage("extract_documents");
  stage(db, job, "extract_documents");
  const analysis = await reviewCapturedSources(input.sources, documents, sources =>
    bridge(root, { mode: "extract", deadline: end, sources, application_review_date: job.review_date }));
  attachWebsiteLinks(analysis, collection);
  const extracted = analysis.sources;
  for (const doc of documents) {
    if (doc.capture_status !== "saved" || !doc.artifact_path) continue;
    const review = analysis.reviews[doc.source_id];
    if (review?.sha256 !== doc.digest || review.source_id !== doc.source_id) throw Error("Unbound specialist evidence");
    review.campus_applicability = review.explicit_identity ? "applicable" : doc.campus_applicability;
    doc.review = review;
    if (review.explicit_identity) {
      const identity = review.explicit_identity;
      const source = input.sources.find(s => s.source_id === doc.source_id);
      Object.assign(source, { role: identity.role, language: identity.language, identity_method: "explicit-scope-v1" });
      Object.assign(doc, { role: identity.role, language: identity.language, campus_applicability: "applicable",
        provenance: source.identity_method });
      verified.push({ ...identity, source_id: source.source_id, sha256: doc.digest });
    }
    if (doc.role === "unclassified") gaps.push(`Classify document role and campus (${doc.campus_applicability}): ${doc.source_id}`);
    if (analysis.file_text_status[doc.digest]) doc.text_status = analysis.file_text_status[doc.digest];
  }
  const content = {};
  for (const s of input.sources) if (s.snapshot) {
    const segments = extracted[s.source_id];
    if (s.classification_sha256) {
      const review = classifications.find((c) => c.source_id === s.source_id);
      if (![review, review.applicability].every((c) => segments.some((p) =>
        p.status === "extracted" && p.locator === c.locator && p.text.includes(c.quote)))) throw Error("Unverified classification citation");
    }
    content[s.source_id] = !segments.length ? s.snapshot.sha256 : fingerprint(segments.map((p) => [p.locator, p.text]));
    if (analysis.file_text_status?.[s.snapshot.sha256] === "needs_review" || segments.some((p) => p.status !== "extracted")) { s.status = "unreadable"; gaps.push(`Review extraction gaps in ${s.source_id}`); }
    else if (s.language !== "en" && !(s.snapshot.artifact_path.endsWith(".html") && s.language === "und")) { s.status = "translation_needed"; gaps.push(`Qualified language/measure interpretation needed: ${s.source_id} [${s.language}]`); }
    else if (s.role === "application" && records.some((r) => r.kind === "application-reviews" && r.findings.some((f) => f.evidence.some((e) => e.url === s.source_id && e.sha256 === s.snapshot.sha256)))) s.status = "reviewed";
  }
  const scoped = latestByScope(records.filter((r) => r.guideline_year === job.year));
  const normalization = [];
  for (const record of [...new Map(scoped.filter((s) => s.success?.kind === "application-reviews").map((s) => [s.success.record_id, s.success])).values()]) {
    try {
      const raw = readArtifact(originalRoot, record.artifact_path);
      if (sha256(raw) !== record.record_id) throw Error("Producer artifact identity changed");
      const adapted = adaptArtifact(raw, { root: originalRoot, reviewDate: record.review_date || job.review_date });
      const normalized = normalizeObservations(adapted.input, input, originalRoot);
      const producer = JSON.parse(raw);
      normalization.push({ producer_sha256: record.record_id, ...normalized,
        reference_binding: { observed_version: producer.reference_version || null, observed_sha256: producer.reference_sha256 || null,
          expected_version: hhs.reference_version, expected_sha256: referenceHash },
        reference_compatibility: adapted.provenance.reference_compatibility || null,
        decisions: adapted.provenance.decisions || [], blockers: adapted.blockers });
    } catch (error) { normalization.push({ producer_sha256: record.record_id, accepted: [], rejected: [error.message] }); }
  }
  stage(db, job, "reconcile_evidence");
  meterStage("reconcile_evidence");
  reconcileFindings({ input, analysis, scoped, normalization, verified,
    maxDepth: job.context.discovery_bounds?.depth || 3, collection });
  for (const review of analysis.application_reviews) {
    if (review.template_comparison?.result !== "yes") gaps.push(`Template equivalence requires review: ${review.source_id}`);
  }
  input.scope.gaps = [...new Set(gaps)];
  inventory.gaps = input.scope.gaps;
  input.scope.inventory_sha256 = fingerprint(inventory);
  return { input, content, inventory, producer_records: records, normalization, application_reviews: analysis.application_reviews, discovery: collection,
    extraction: { parser: "document-text-v5", collection_status: collection?.status ?? "saved_evidence_replay" } };
}

export async function runPipeline(db, job, collect = bridge) {
  if (!db.prepare("SELECT id FROM jobs WHERE id=? AND token=? AND status='running'").get(job.id, job.token)) return null;
  return meterAttempt(db, job, () => executePipeline(db, job, collect));
}

async function executePipeline(db, job, collect) {
  try {
    deadline(db,job);
    if (job.context.engine_version !== "multilingual-v1") throw Error("Pipeline engine changed; enqueue a new job");
    if (job.context.application_profile_sha256 !== applicationProfileHash) throw Error("Application profile changed; enqueue a new job");
    if (job.context.application_visual_sha256 !== applicationVisualHash) throw Error("Application visual review changed; enqueue a new job");
    if (job.context.reference_sha256 !== referenceHash || job.context.rubric_version !== rubric.version || job.context.rubric_sha256 !== fingerprint(rubric)) throw Error("Pinned rules changed; enqueue a new job");
    let prepared;
    if (job.checkpoint) {
      const checkpoint = JSON.parse(job.checkpoint);
      if (checkpoint.pipeline) {
        stage(db, job, "restore_checkpoint");
        const raw = readArtifact(job.context.root, checkpoint.path);
        if (sha256(raw) !== checkpoint.sha256) throw Error("Checkpoint changed");
        measure({ checkpoint_hits: 1 });
        prepared = JSON.parse(raw);
        if (prepared.job_context_sha256 !== fingerprint(job.context)) throw Error("Checkpoint context mismatch");
      }
    }
    if (!prepared) {
      prepared = job.context.mode === "synthetic" ? synthetic(job) : await real(db, job, collect);
      prepared.job_context_sha256 = fingerprint(job.context);
      const raw = Buffer.from(JSON.stringify(prepared)), digest = sha256(raw), path = `pipeline-checkpoints/${digest}.json`;
      immutable(job.context.root, path, raw);
      db.prepare("UPDATE jobs SET checkpoint=? WHERE id=? AND token=? AND status='running'").run(JSON.stringify({ pipeline: 1, path, sha256: digest }), job.id, job.token);
    }
    deadline(db,job);
    if (job.context.mode === "discovery_only") {
      meterStage("publish");
      const scan = { mode: job.context.mode, job: job.id, ...prepared };
      scan.id = fingerprint(scan);
      const path = `pipeline-scans/${scan.id}.json`;
      immutable(job.context.root, path, Buffer.from(JSON.stringify(scan)));
      deadline(db,job);
      return publishScan(db, job, scan) ? scan : null;
    }
    prepared.input = { ...prepared.input, ...context(job) };
    prepared.input.findings = prepared.input.findings.map((f) => ({ ...f, ...contextOf(prepared.input) }));
    meterStage("grade");
    stage(db, job, "grade");
    const report = grade(prepared.input, { root: job.context.root });
    deadline(db,job);
    validateSchema(report, "grading-report-v1.schema.json");
    const bundle = { pipeline: 1, mode: job.context.mode, root: job.context.root, rubric_sha256: fingerprint(rubric), ...prepared, report, content_fingerprint: fingerprint(prepared.content) };
    bundle.id = fingerprint({ input: bundle.input, report });
    meterStage("publish");
    immutable(job.context.root, `pipeline-assessments/${bundle.id}.json`, Buffer.from(JSON.stringify(bundle, null, 2) + "\n"));
    deadline(db,job);
    return publishPipeline(db, job, bundle) ? bundle : null;
  } catch (error) {
    failPipeline(db, job, error);
    const diagnostic = failureDiagnostic(error.code, error.diagnostic);
    const last = db.prepare("SELECT json_extract(detail,'$.name') stage FROM audit_run_events WHERE job=? AND attempt=? AND state='stage' ORDER BY seq DESC LIMIT 1").get(job.id, job.token);
    console.error("pipeline_failed", JSON.stringify({
      job_id: job.id, stage: last?.stage ?? "prepare", reason: diagnostic?.code ?? (error instanceof BudgetStop ? error.code : "audit_failed"),
      source_url: diagnostic?.source_url, http_status: diagnostic?.http_status, manifest_id: diagnostic?.manifest_id,
    }));
    throw error;
  }
}
