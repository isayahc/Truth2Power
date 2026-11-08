import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { createHash } from "node:crypto";

export function reviewFixture(root, id = "a".repeat(32), checked = "2026-11-08T12:00:00Z", namespace = "full-reviews") {
  const raw = "<h1>SYNTHETIC financial assistance policy</h1><p>Patients may apply at any time.</p>";
  const hash = createHash("sha256").update(raw).digest("hex");
  mkdirSync(join(root, "snapshots"), { recursive: true });
  writeFileSync(join(root, "snapshots", `${hash}.html`), raw);
  const citation = { snapshot_id: hash, locator: "HTML text", quote: "Patients may apply at any time." };
  const measure = "posted_materials.no_submission_time_limit";
  const result = { synthetic: true, review_id: "b".repeat(32), result_id: id, hospital_key: "1002", checked_at: checked,
    findings: [{ measure_id: measure, result: "unclear", explanation: "SYNTHETIC: verify the application timing language.",
      expected: "No submission deadline", unresolved_questions: ["Does this synthetic policy allow applications during collections?"], evidence: [citation] }],
    snapshots: [{ snapshot_id: hash, sha256: hash, artifact_path: `snapshots/${hash}.html`, url: "https://example.org/synthetic-policy.html",
      document_type: "policy_statement", retrieved_at: checked }],
    coverage: [{ source_id: "s1", language: "English", status: "reviewed", total_pages: 1, reviewed_pages: ["s1-p1"], url: "https://example.org/synthetic-policy.html", notes: "Synthetic fixture." }],
    gaps: [], source_reviews: [{ source_id: "s1", review: { observations: [{ measure_id: measure, position: "supports", context: "application_submission", explanation: "Synthetic favorable evidence.", evidence: [citation] }] } }] };
  const folder = join(root, namespace, result.review_id, "results");
  mkdirSync(folder, { recursive: true });
  const path = join(folder, `${id}.json`);
  writeFileSync(path, JSON.stringify(result));
  return { result, path, hash, raw };
}

export function applicationFixture(root, id = "c".repeat(32), checked = "2026-11-08T13:00:00Z") {
  const fixture = reviewFixture(root, id, checked, "application-reviews");
  const base = fixture.result.findings[0];
  fixture.result.review_type = "application";
  fixture.result.scope_label = "Selected application only; English profile";
  fixture.result.guideline_year = 2026;
  fixture.result.other_application_versions_not_assessed = ["https://example.org/SYN-spanish.pdf"];
  fixture.result.findings = ["uniform_application", "contact_information", "income_discount_tables", "fpl_guidelines", "maximum_fpl", "installments_cap"]
    .map((name) => ({ ...base, measure_id: `application.${name}`, result: name === "uniform_application" ? "unclear" : name === "fpl_guidelines" ? "no" : "yes",
      explanation: "SYNTHETIC application-only test finding.", unresolved_questions: [] }));
  const fpl = fixture.result.findings.find((f) => f.measure_id === "application.fpl_guidelines");
  fpl.observed = { published_year: 2025, currency: "USD", period: "annual", cells: [{ household_size: 1, fpl_percent: 400, observed: 62600, expected: 63840 }] };
  fpl.expected = { guideline_year: 2026, one_person_400_percent: 63840, authority_url: "https://example.org/SYN-reference" };
  writeFileSync(fixture.path, JSON.stringify(fixture.result));
  return fixture;
}
