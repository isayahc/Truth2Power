import { readFileSync } from "node:fs";

const load = (path) => JSON.parse(readFileSync(new URL(path, import.meta.url), "utf8"));
const inventory = load("../../docs/audit-format/wave-one-document-inventory.json");
const context = load("../../references/wave-one-reporting-context-v1.json");
const summaries = new Map(["1002", "362"].map((key) => [key, load(`../../docs/audit-format/summaries/${key}.json`)]));
const reviews = load("../../docs/audit-format/summaries/review.json");
const collections = new Map(["1002", "362"].map((key) => [key, load(`../../docs/audit-format/posting/collections/${key}.json`)]));
const https = (url) => typeof url === "string" && /^https:\/\//.test(url);
const strings = (items) => Array.isArray(items) && items.length > 0 && items.every((s) => typeof s === "string" && s.trim());

/** Descriptive comparison only. No expected set without a cited independent reference. */
export function compareCounties(psa) {
  const ref = psa.expected_reference;
  const ready = ref?.independent === true && strings(ref.counties) && https(ref.url) &&
    [ref.publisher, ref.locator, ref.quote, ref.applicability].every((s) => typeof s === "string" && s.trim());
  if (!ready) return { status: "pending_review", expected_counties: null, reference: null, differences: [],
    note: "Independent county reference not established. Expected counties and correctness comparison are pending review." };
  const statements = psa.statements.filter((s) => s.geography_type === "counties" && strings(s.reported_counties));
  const differences = statements.map((s) => ({ url: s.evidence.url, language: s.language,
    missing: ref.counties.filter((c) => !s.reported_counties.includes(c)),
    additional: s.reported_counties.filter((c) => !ref.counties.includes(c)) }));
  const mismatch = differences.some((d) => d.missing.length || d.additional.length);
  return { status: statements.length ? mismatch ? "differs_from_reference" : "matches_reference" : "pending_review",
    expected_counties: ref.counties, reference: ref, differences,
    note: statements.length ? "Reported and independently referenced counties compared for information only." :
      "The hospital has not supplied an explicit county set to compare with this reference." };
}

/** Public reporting context lives outside assessment findings and is never passed to the grader. */
export function reportingContext(hospitalKey) {
  const hospital = inventory.hospitals.find((h) => h.hospital_key === hospitalKey);
  if (!hospital || !context.hospitals[hospitalKey]) return null;
  const collection = collections.get(hospitalKey);
  const documents = hospital.documents.map((d) => {
    const record = collection.documents.find((r) => d.sha256 ? r.sha256 === d.sha256 : r.source_url.endsWith("/" + d.filename));
    if (!record) throw new Error("Document inventory and collection differ");
    const confirmed = Boolean(d.sha256 && record.status === "saved");
    return { name: d.filename, role: d.type, language: confirmed ? d.language_label : "Unknown",
      language_status: confirmed ? "observed_in_document" : "unverified_filename_label",
      note: confirmed ? "Language identification only; translation quality and measure review are separate." :
        `${d.language_label}; linked document unavailable (${record.http_status ?? "retrieval failed"}).`,
      url: record.url ?? record.source_url, sha256: d.sha256 ?? null, retrieved_at: record.retrieved_at ?? null,
      evidence: confirmed ? { locator: d.locator, quote: d.quote } : null };
  });
  for (const source of summaries.get(hospitalKey).snapshots) {
    if (documents.some((d) => d.sha256 === source.sha256 && d.url === source.url)) continue;
    const review = reviews.hospitals[hospitalKey].documents.find((d) => d.snapshot_id === source.snapshot_id);
    documents.push({ name: source.url.split("/").at(-1), role: "policy_summary", language: review.language,
      language_status: "observed_in_document", note: "Designated summary discovered on the linked PLS page under #24. Language review is not translation certification.",
      url: source.url, sha256: source.sha256, retrieved_at: source.retrieved_at,
      evidence: { locator: review.title_evidence.locator, quote: review.title_evidence.quote } });
  }
  const psa = context.hospitals[hospitalKey];
  return { hospital_key: hospitalKey, version: context.version, reviewed_at: context.reviewed_at,
    included_in_grade: false, scope: context.scope, documents,
    psa: { ...psa, expected_reference: undefined, comparison: compareCounties(psa) },
    graded_checks: ["policy_summary.primary_service_area_described", "posted_materials.primary_service_area_boundaries_compliant"] };
}
