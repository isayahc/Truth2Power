import { stage } from "./run-history.js";
import { readFileSync, existsSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { execFile } from "node:child_process";
import { rubric, hhs, referenceHash, contextOf, expectedFor, readArtifact, fingerprint, validateSchema, confirmedDocuments, assistancePages } from "../grading/data.js";
import { grade } from "../grading/grade.js";
import { parseProfile, applicationProfileHash, applicationVisualHash } from "../grading/profiles.js";
import { fplComparison } from "../grading/measures.js";
import { sha256, languageTag } from "../review/identity.js";
import { reportingContext } from "../reporting/context.js";
import { localRecords, latestByScope, projectRecord } from "../hospital-page/records.js";
import { immutable, publishPipeline, publishScan, failPipeline } from "./pipeline-store.js";
import { facilityFor, sourceInventory, savedCollection } from "./roster-inventory.js";
import { readClassifications } from "../grading/source-classification.js";
import { postingPaths } from "../grading/posting-paths.js";
import { adaptArtifact } from "../grading/adapter.js";
import { normalizeObservations } from "./normalize-observations.js";

const examples = fileURLToPath(new URL("../../docs/grading/examples/", import.meta.url));
async function bridge(root, request) {
  // execFile's stdin is written explicitly; no shell or model-selected command.
  return new Promise((resolve, reject) => {
    const child = execFile(process.env.T2P_PYTHON || "python", [fileURLToPath(new URL("../../tools/live-audit/pipeline_bridge.py", import.meta.url)), "--root", root],
      { timeout: request.mode === "live" ? 180000 : 120000, maxBuffer: 32 * 1024 * 1024 }, (error, stdout) => {
        if (error) reject(Error("Collection or extraction failed")); else { try { resolve(JSON.parse(stdout)); } catch { reject(Error("Invalid extraction output")); } }
      });
    child.stdin.on("error", () => {});
    child.stdin.end(JSON.stringify(request));
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
  if (job.hospital === "362") {
    const path = "docs/audit-format/changes/362-summary-posting.json";
    pinned.push(projectRecord(readFileSync(new URL("../../" + path, import.meta.url)), path, "posting"));
  }
  const local = localRecords(originalRoot);
  if (local.unavailable.length) gaps.push(`${local.unavailable.length} source-review artifacts could not be read.`);
  const records = [...new Map([...pinned, ...local.records.filter((r) => r.hospital_key === job.hospital)].map((r) => [r.record_id, r])).values()];
  const candidates = records.flatMap((r) => r.findings.flatMap((f) => f.evidence));
  const seeds = (display?.documents ?? []).map((d) => ({ source_id: d.url, role: d.role, language: languageTag(d.language), digest: d.sha256,
    retrieved_at: d.retrieved_at, publisher_updated_at: null }));
  for (const r of pinned) for (const s of r.landing_page || []) {
    const e = candidates.find((e) => e.url === s.url);
    if (e && !seeds.some((d) => d.source_id === s.url)) seeds.push({ source_id: s.url, role: "landing_page", language: "en", digest: e.sha256, retrieved_at: e.retrieved_at });
  }
  const replay = job.context.mode === "replay", scan = job.context.mode === "discovery_only";
  stage(db, job, replay ? "load_saved_evidence" : "collect_sources");
  const collection = replay ? savedCollection(originalRoot, job.hospital) : (await collect(root, {
    mode: "live", hospital_key: job.hospital, bounds: job.context.discovery_bounds, discovery_only: scan,
  })).collection;
  const inventory = sourceInventory(facility, collection, seeds);
  if (collection && !replay) stage(db, job, "collection_saved", { collection_sha256: inventory.collection_sha256,
    captures: inventory.sources.filter((s) => s.capture_status === "saved").map((s) => ({
      source_id: s.source_id, sha256: s.digest, retrieved_at: s.retrieved_at })) });
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
      if (d.final_url && d.final_url !== d.source_id) source.snapshot.final_url = d.final_url;
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
      if (source.role === "unclassified") gaps.push(`Classify document role and campus (${d.campus_applicability}): ${d.source_id}`);
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
  stage(db, job, "extract_documents");
  const analysis = await bridge(root, { mode: "extract", sources: input.sources, application_review_date: job.review_date });
  const extracted = analysis.sources;
  const content = {};
  for (const s of input.sources) if (s.snapshot) {
    const segments = extracted[s.source_id];
    if (s.classification_sha256) {
      const review = classifications.find((c) => c.source_id === s.source_id);
      if (![review, review.applicability].every((c) => segments.some((p) =>
        p.status === "extracted" && p.locator === c.locator && p.text.includes(c.quote)))) throw Error("Unverified classification citation");
    }
    content[s.source_id] = !segments.length ? s.snapshot.sha256 : fingerprint(segments.map((p) => [p.locator, p.text]));
    if (segments.some((p) => p.status !== "extracted")) { s.status = "unreadable"; gaps.push(`Review extraction gaps in ${s.source_id}`); }
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
  for (const m of rubric.measures) {
    const originals = scoped.filter((s) => s.success?.measure_id === m.measure_id).map((s) => s.success);
    const f = { ...contextOf(input), measure_id: m.measure_id, expected: expectedFor(m, job.year), result: "unclear", human_review: "pending", evidence: [], observed: [],
      unresolved_evidence: originals.length ? [...new Set(originals.map((r) => `Source draft ${r.record_id}: ${r.finding.explanation}`))] : [`Collect and review ${m.evidence_requirement}`] };
    for (const review of analysis.application_reviews) {
      const draft = review.findings.find((finding) => finding.measure_id === m.measure_id);
      for (const e of draft?.evidence || []) f.evidence.push({ ...e, source_id: review.source_id, sha256: review.snapshot.sha256 });
    }
    for (const r of originals) for (const e of r.finding.evidence) {
      const s = input.sources.find((s) => s.source_id === e.url && s.snapshot?.sha256 === e.sha256 && m.roles.includes(s.role));
      const segment = s && extracted[s.source_id]?.find((p) => p.locator === e.locator && p.text.includes(e.quote));
      if (!segment) { f.unresolved_evidence.push(`Reverify missing, changed or unsupported citation: ${e.url} · ${e.locator}`); continue; }
      if (!f.evidence.some((c) => c.sha256 === e.sha256 && c.locator === e.locator && c.quote === e.quote)) f.evidence.push({ source_id: s.source_id, snapshot_id: e.sha256, sha256: e.sha256, locator: e.locator, quote: e.quote });
    }
    if (m.evaluator === "posting") {
      f.evidence = [];
      const paths = postingPaths(input.sources, extracted, assistancePages.get(job.hospital), m.expected.any_accessible_role, verified, job.hospital, job.context.discovery_bounds?.depth || 3);
      const links = [...new Set(paths.map((p) => p.target))];
      f.evidence = [...new Map(paths.flatMap((p) => p.evidence).map((e) => [JSON.stringify(e), e])).values()];
      if (links.length) {
        f.result = "yes"; f.unresolved_evidence = [];
        f.observed = [{ evidence_index: f.evidence.findIndex((e) => e.locator.startsWith("link ")), method: "posted_link", value: { links: [...new Set(links)], search_complete: false } }];
      }
    } else if (["fpl", "maximum", "installments"].includes(m.evaluator)) {
      const numeric = [];
      for (const s of input.sources.filter((s) => s.role === "application" && s.snapshot && s.status !== "unreadable")) {
        const matches = extracted[s.source_id].map((p) => ({ p, value: parseProfile(m.evaluator, p.text, s.language) })).filter((v) => v.value);
        if (matches.length !== 1) continue;
        const { p, value } = matches[0];
        const index = f.evidence.push({ source_id: s.source_id, snapshot_id: s.snapshot.sha256, sha256: s.snapshot.sha256, locator: p.locator, quote: p.text }) - 1;
        f.observed.push({ evidence_index: index, method: "text_profile", value });
        numeric.push(m.evaluator === "fpl" ? fplComparison(value, job.year).result : m.evaluator === "maximum" ? value.percent >= 400 ? "yes" : "unclear" : value.percent <= 5 ? "yes" : "no");
      }
      if (numeric.length && new Set(numeric).size === 1 && ["yes", "no"].includes(numeric[0])) {
        f.result = numeric[0]; f.unresolved_evidence = [];
      }
    } else f.unresolved_evidence.push("The saved qualitative draft is not a verified structured observation or human approval. Review its exact evidence under the grading contract.");
    for (const reused of normalization.flatMap((n) => n.accepted).filter((o) => o.measure_id === m.measure_id)) {
      const same = f.observed.find((o) => f.evidence[o.evidence_index].source_id === reused.evidence.source_id);
      if (same && fingerprint(same.value) !== fingerprint(reused.observation.value)) {
        f.unresolved_evidence.push("Conflicting verified historical observation; reconcile the source-specific facts.");
      } else if (!same) {
        const index = f.evidence.push(reused.evidence) - 1;
        f.observed.push({ ...reused.observation, evidence_index: index });
      }
    }
    for (const n of normalization) {
      const decision = n.decisions?.filter((d) => !d.measure_id || d.measure_id === m.measure_id) || [];
      if (decision.some((d) => ["reject", "needs_changes"].includes(d.decision) || ["correct", "request_information"].includes(d.action))) {
        f.unresolved_evidence.push("Reconcile the independent historical review before using these normalized observations.");
      }
    }
    f.unresolved_evidence = [...new Set(f.unresolved_evidence)];
    input.findings.push(f);
  }
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
  try {
    if (!db.prepare("SELECT id FROM jobs WHERE id=? AND token=? AND status='running'").get(job.id, job.token)) return null;
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
    if (job.context.mode === "discovery_only") {
      const scan = { mode: job.context.mode, job: job.id, ...prepared };
      scan.id = fingerprint(scan);
      const path = `pipeline-scans/${scan.id}.json`;
      immutable(job.context.root, path, Buffer.from(JSON.stringify(scan)));
      return publishScan(db, job, scan) ? scan : null;
    }
    prepared.input = { ...prepared.input, ...context(job) };
    prepared.input.findings = prepared.input.findings.map((f) => ({ ...f, ...contextOf(prepared.input) }));
    stage(db, job, "grade");
    const report = grade(prepared.input, { root: job.context.root });
    validateSchema(report, "grading-report-v1.schema.json");
    const bundle = { pipeline: 1, mode: job.context.mode, root: job.context.root, rubric_sha256: fingerprint(rubric), ...prepared, report, content_fingerprint: fingerprint(prepared.content) };
    bundle.id = fingerprint({ input: bundle.input, report });
    immutable(job.context.root, `pipeline-assessments/${bundle.id}.json`, Buffer.from(JSON.stringify(bundle, null, 2) + "\n"));
    return publishPipeline(db, job, bundle) ? bundle : null;
  } catch (error) {
    failPipeline(db, job);
    console.error("pipeline_failed", job.id, error.name);
    throw error;
  }
}
