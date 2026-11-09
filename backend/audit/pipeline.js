import { readFileSync, existsSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { execFile } from "node:child_process";
import { rubric, hhs, referenceHash, contextOf, expectedFor, readArtifact, fingerprint, validateSchema, confirmedDocuments, assistancePages } from "../grading/data.js";
import { grade } from "../grading/grade.js";
import { parseProfile } from "../grading/profiles.js";
import { fplComparison } from "../grading/measures.js";
import { sha256, languageTag } from "../review/identity.js";
import { reportingContext } from "../reporting/context.js";
import { localRecords, latestByScope, projectRecord } from "../hospital-page/records.js";
import { immutable, publishPipeline, failPipeline } from "./pipeline-store.js";

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

async function real(job) {
  const root = job.context.root, originalRoot = job.context.evidence_root;
  const display = reportingContext(job.hospital), gaps = ["Complete website/online-application discovery and governing interpretations require review; direct links do not prove absence."];
  const pinned = JSON.parse(readFileSync(new URL(`../../docs/hospital-pages/${job.hospital}.json`, import.meta.url))).records;
  if (job.hospital === "362") {
    const path = "docs/audit-format/changes/362-summary-posting.json";
    pinned.push(projectRecord(readFileSync(new URL("../../" + path, import.meta.url)), path, "posting"));
  }
  const local = localRecords(originalRoot);
  if (local.unavailable.length) gaps.push(`${local.unavailable.length} source-review artifacts could not be read.`);
  const records = [...new Map([...pinned, ...local.records.filter((r) => r.hospital_key === job.hospital)].map((r) => [r.record_id, r])).values()];
  const candidates = records.flatMap((r) => r.findings.flatMap((f) => f.evidence));
  const documents = display.documents.map((d) => ({ source_id: d.url, role: d.role, language: languageTag(d.language), digest: d.sha256,
    retrieved_at: d.retrieved_at, publisher_updated_at: null }));
  for (const r of records) for (const s of r.landing_page || []) {
    const e = candidates.find((e) => e.url === s.url);
    if (e && !documents.some((d) => d.source_id === s.url)) documents.push({ source_id: s.url, role: "landing_page", language: "en", digest: e.sha256, retrieved_at: e.retrieved_at });
  }
  const collectionDir = join(originalRoot, "collections", job.hospital);
  if (job.context.mode === "replay" && existsSync(collectionDir)) {
    const saved = readdirSync(collectionDir).filter((f) => /^[a-f0-9]{32}\.json$/.test(f)).map((f) => JSON.parse(readArtifact(originalRoot, `collections/${job.hospital}/${f}`)))
      .filter((c) => c.hospital_key === job.hospital && c.landing_page).sort((a, b) => Date.parse(b.attempted_at) - Date.parse(a.attempted_at))[0];
    if (saved) {
      const landing = saved.landing_page;
      const d = documents.find((d) => d.source_id === landing.url);
      const captured = { source_id: landing.url, role: "landing_page", language: "en", digest: landing.sha256, retrieved_at: landing.retrieved_at };
      if (d) Object.assign(d, captured); else documents.push(captured);
    }
  }
  let collection;
  if (job.context.mode === "live") {
    const collected = await bridge(root, { mode: "live", hospital_key: job.hospital });
    collection = collected.collection;
    const fetched = [collection.landing_page, ...collection.documents];
    for (const d of documents) {
      const s = fetched.find((s) => s && (s.url === d.source_id || s.source_url === d.source_id));
      if (!s?.sha256) { d.digest = null; gaps.push(`Not captured in this collection: ${d.source_id}`); }
      else { d.digest = s.sha256; d.retrieved_at = s.retrieved_at; }
    }
    for (const s of fetched.filter((s) => s?.sha256 && !documents.some((d) => d.source_id === s.url))) {
      documents.push({ source_id: s.url, role: "supplement", language: "und", digest: s.sha256, retrieved_at: s.retrieved_at });
      gaps.push(`Classify campus, document role and language before evaluation: ${s.url}`);
    }
  }
  const input = { ...context(job), scope: { inventory_status: "partial", online_application: "unknown", required_sources: [], gaps }, sources: [], findings: [] };
  for (const d of documents) {
    const source = { source_id: d.source_id, hospital_key: job.hospital, role: d.role, language: d.language, status: "unavailable", snapshot: null };
    const from = collection ? root : originalRoot;
    const suffix = [".pdf", ".docx", ".html"].find((ext) => d.digest && existsSync(join(from, `snapshots/${d.digest}${ext}`)));
    if (suffix) {
      const path = `snapshots/${d.digest}${suffix}`, raw = readArtifact(from, path);
      if (sha256(raw) !== d.digest) throw Error("Source snapshot checksum mismatch");
      immutable(root, path, raw);
      source.snapshot = { snapshot_id: d.digest, sha256: d.digest, artifact_path: path, url: d.source_id, retrieved_at: d.retrieved_at, publisher_updated_at: null };
      source.status = "available";
    } else gaps.push(`Obtain original snapshot or recollect unavailable source: ${d.source_id}`);
    input.sources.push(source);
  }
  input.scope.required_sources = input.sources.map((s) => s.source_id);
  const extracted = await bridge(root, { mode: "extract", sources: input.sources });
  const content = {};
  for (const s of input.sources) if (s.snapshot) {
    const segments = extracted[s.source_id];
    content[s.source_id] = fingerprint(segments.map((p) => [p.locator, p.text]));
    if (segments.some((p) => p.status !== "extracted")) { s.status = "unreadable"; gaps.push(`Review extraction gaps in ${s.source_id}`); }
    else if (s.language !== "en") { s.status = "translation_needed"; gaps.push(`Qualified language/measure interpretation needed: ${s.source_id} [${s.language}]`); }
    else if (s.role === "application" && records.some((r) => r.kind === "application-reviews" && r.findings.some((f) => f.evidence.some((e) => e.url === s.source_id && e.sha256 === s.snapshot.sha256)))) s.status = "reviewed";
  }
  const scoped = latestByScope(records.filter((r) => r.guideline_year === job.year));
  for (const m of rubric.measures) {
    const originals = scoped.filter((s) => s.success?.measure_id === m.measure_id).map((s) => s.success);
    const f = { ...contextOf(input), measure_id: m.measure_id, expected: expectedFor(m, job.year), result: "unclear", human_review: "pending", evidence: [], observed: [],
      unresolved_evidence: originals.length ? [...new Set(originals.map((r) => `Source draft ${r.record_id}: ${r.finding.explanation}`))] : [`Collect and review ${m.evidence_requirement}`] };
    for (const r of originals) for (const e of r.finding.evidence) {
      const s = input.sources.find((s) => s.source_id === e.url && s.snapshot?.sha256 === e.sha256 && m.roles.includes(s.role));
      const segment = s && extracted[s.source_id]?.find((p) => p.locator === e.locator && p.text.includes(e.quote));
      if (!segment) { f.unresolved_evidence.push(`Reverify missing, changed or unsupported citation: ${e.url} · ${e.locator}`); continue; }
      if (!f.evidence.some((c) => c.sha256 === e.sha256 && c.locator === e.locator && c.quote === e.quote)) f.evidence.push({ source_id: s.source_id, snapshot_id: e.sha256, sha256: e.sha256, locator: e.locator, quote: e.quote });
    }
    if (m.evaluator === "posting") {
      f.evidence = [];
      const landing = input.sources.find((s) => s.role === "landing_page" && s.source_id === assistancePages.get(job.hospital) && s.snapshot);
      const links = [];
      if (landing) for (const anchor of extracted[landing.source_id].filter((p) => p.locator.startsWith("link "))) {
        const target = input.sources.find((s) => s.source_id === anchor.locator.slice(5) && s.snapshot && m.expected.any_accessible_role.includes(s.role));
        const known = target && confirmedDocuments.find((d) => d.hospital_key === job.hospital && d.sha256 === target.snapshot.sha256 && d.role === target.role);
        if (!known || !extracted[target.source_id].some((p) => p.locator === known.locator && p.text.includes(known.quote))) continue;
        links.push(target.source_id);
        f.evidence.push({ source_id: landing.source_id, snapshot_id: landing.snapshot.sha256, sha256: landing.snapshot.sha256, locator: anchor.locator, quote: anchor.text },
          { source_id: target.source_id, snapshot_id: target.snapshot.sha256, sha256: target.snapshot.sha256, locator: known.locator, quote: known.quote });
      }
      if (links.length) {
        f.result = "yes"; f.unresolved_evidence = [];
        f.observed = [{ evidence_index: f.evidence.findIndex((e) => e.locator.startsWith("link ")), method: "posted_link", value: { links: [...new Set(links)], search_complete: false } }];
      }
    } else if (["fpl", "maximum", "installments"].includes(m.evaluator)) {
      const numeric = [];
      for (const s of input.sources.filter((s) => s.role === "application" && s.language === "en" && s.snapshot && s.status !== "unreadable")) {
        const matches = extracted[s.source_id].map((p) => ({ p, value: parseProfile(m.evaluator, p.text) })).filter((v) => v.value);
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
    f.unresolved_evidence = [...new Set(f.unresolved_evidence)];
    input.findings.push(f);
  }
  return { input, content, producer_records: records, extraction: { parser: "document-text-v5", collection_status: collection?.status ?? "saved_evidence_replay" } };
}

export async function runPipeline(db, job) {
  try {
    if (!db.prepare("SELECT id FROM jobs WHERE id=? AND token=? AND status='running'").get(job.id, job.token)) return null;
    if (job.context.reference_sha256 !== referenceHash || job.context.rubric_version !== rubric.version || job.context.rubric_sha256 !== fingerprint(rubric)) throw Error("Pinned rules changed; enqueue a new job");
    let prepared;
    if (job.checkpoint) {
      const checkpoint = JSON.parse(job.checkpoint);
      if (checkpoint.pipeline) {
        const raw = readArtifact(job.context.root, checkpoint.path);
        if (sha256(raw) !== checkpoint.sha256) throw Error("Checkpoint changed");
        prepared = JSON.parse(raw);
        if (prepared.job_context_sha256 !== fingerprint(job.context)) throw Error("Checkpoint context mismatch");
      }
    }
    if (!prepared) {
      prepared = job.context.mode === "synthetic" ? synthetic(job) : await real(job);
      prepared.job_context_sha256 = fingerprint(job.context);
      const raw = Buffer.from(JSON.stringify(prepared)), digest = sha256(raw), path = `pipeline-checkpoints/${digest}.json`;
      immutable(job.context.root, path, raw);
      db.prepare("UPDATE jobs SET checkpoint=? WHERE id=? AND token=? AND status='running'").run(JSON.stringify({ pipeline: 1, path, sha256: digest }), job.id, job.token);
    }
    prepared.input = { ...prepared.input, ...context(job) };
    prepared.input.findings = prepared.input.findings.map((f) => ({ ...f, ...contextOf(prepared.input) }));
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
