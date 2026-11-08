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
  fixture.result.extraction_details = {
    parser_version: "document-text-v4", snapshot_id: fixture.hash,
    limitations: "SYN: structural classification does not verify rendered layout or entire-form equivalence.",
    drawings: [1, 2].map((number) => ({
      locator: `word/document.xml drawing ${number} (paragraph ${number})`,
      name: `SYN signature line ${number}`, classification: "text_free_line", xml_sha256: String(number).repeat(64),
      explanation: "SYN: single preset line with no text, image, alternate text or relationship. Rendered layout is unverified.",
    })),
  };
  fixture.result.other_application_versions_not_assessed = ["https://example.org/SYN-spanish.pdf"];
  fixture.result.template_comparison = {
    comparison_id: "e".repeat(32), reference_version: "SYN-2026-English", parser_version: "document-text-v5",
    reference_url: "https://example.org/SYN-reference.docx", reference_retrieved_at: checked,
    retrieval_method: "SYN hash-verified capture", reference_parts: [
      { locator: "DOCX word/footnotes.xml", status: "extracted", empty: false },
      { locator: "DOCX word/footer1.xml", status: "extracted", empty: true },
    ],
    observations: [{ kind: "reference_discrepancy", title: "SYN official numeric discrepancy",
      explanation: "SYN: use HHS arithmetic for dollar correctness.", evidence: [base.evidence[0]] }],
    unresolved_questions: ["SYN: Are the added fields permitted customizations?"],
    whole_form_review: {
      reviewed_at: "2026-11-08", reviewer: "SYN model review; not human approval", reference_units_reviewed: 1,
      conclusion: "SYN visual review complete; customization rule pending.", recommendation: "SYN rubric owner must decide.",
      limitations: "SYN derived visual artifact.", resolved_points: ["SYN contact fields retained."],
      authority: { url: "https://example.org/SYN-authority", locator: "SYN section 9", quote: "SYN uniform form", interpretation: "SYN rule pending." },
      renders: { reference: { snapshot_id: fixture.hash, pages: 1 }, application: { snapshot_id: fixture.hash, pages: 1 } },
      visual_sections: [{ section: "SYN signature area", observation: "SYN fields visible.", reference_pages: [1], application_pages: [1] }],
    },
  };
  fixture.result.findings = ["uniform_application", "contact_information", "income_discount_tables", "fpl_guidelines", "maximum_fpl", "installments_cap"]
    .map((name) => ({ ...base, measure_id: `application.${name}`, result: name === "uniform_application" ? "unclear" : name === "fpl_guidelines" ? "no" : "yes",
      explanation: "SYNTHETIC application-only test finding.", unresolved_questions: [] }));
  const fpl = fixture.result.findings.find((f) => f.measure_id === "application.fpl_guidelines");
  fpl.observed = { published_year: 2025, currency: "USD", period: "annual", cells: [{ household_size: 1, fpl_percent: 400, observed: 62600, expected: 63840 }] };
  fpl.expected = { guideline_year: 2026, one_person_400_percent: 63840, authority_url: "https://example.org/SYN-reference" };
  writeFileSync(fixture.path, JSON.stringify(fixture.result));
  return fixture;
}
