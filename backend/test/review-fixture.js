import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { createHash } from "node:crypto";

export function reviewFixture(root, id = "a".repeat(32), checked = "2026-11-08T12:00:00Z") {
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
  const folder = join(root, "full-reviews", result.review_id, "results");
  mkdirSync(folder, { recursive: true });
  const path = join(folder, `${id}.json`);
  writeFileSync(path, JSON.stringify(result));
  return { result, path, hash, raw };
}
