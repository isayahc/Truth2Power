import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { latestByScope, localRecords, validDate } from "./records.js";

const load = (path) => JSON.parse(readFileSync(new URL(path, import.meta.url), "utf8"));
const rubric = load("../../rubrics/css-17-v1.json");
const baseline = ["1002", "362"].flatMap((key) => load(`../../docs/hospital-pages/${key}.json`).records);
const law = "https://www.nysenate.gov/legislation/laws/PBH/2807-K";
const explanations = {
  R: ["Can patients find a financial assistance application?", "§ 2807-k(9), (9-a)(e)", "The law requires the state form and help applying. Website posting is the CSS audit check."],
  S: ["Can patients find a plain-language summary?", "§ 2807-k(9-a)(c)", "Patients must be able to get a clear summary of the hospital's financial aid policy."],
  T: ["Can patients find the financial assistance policy?", "§ 2807-k(9-a)(a), (c)", "Hospitals must have written financial aid policies. Posting the full policy is the CSS audit check."],
  U: ["Do the documents give patients the same information?", "§ 2807-k(9-a)(c), (d)", "Policies must be understandable and applied consistently. The audit compares documents for conflicting terms."],
  V: ["Does the hospital's service area follow the applicable rules?", "§ 2807-k(9-a)(f)", "Statewide emergency coverage and primary-service-area rules apply. An independent boundary reference is needed to decide this check."],
  W: ["Can patients apply throughout the collection process?", "§ 2807-k(9-a)(e)", "Patients must be allowed to apply at any time during the collection process."],
  Y: ["Is assistance free of an asset eligibility check?", "§ 2807-k(9-a)(b), (f) — related income rules", "This CSS check looks for asset-based eligibility barriers. The exact legal interpretation remains subject to policy review."],
  Z: ["Can patients qualify regardless of immigration status?", "§ 2807-k(9-a)(a)", "Immigration status must not be used to decide financial assistance eligibility."],
  AD: ["Does the hospital use the full New York State application?", "§ 2807-k(9)", "Hospitals must use the uniform financial assistance form provided by the state."],
  AE: ["Does the application tell patients whom to contact?", "§ 2807-k(9), (9-a)(e)", "Hospitals must help patients understand the policy and apply. The audit checks the form's contact information."],
  AG: ["Does the application show income and discount tables?", "§ 2807-k(9), (9-a)(b)", "The state form and income-based discounts help patients understand what they may pay."],
  AH: ["Does the application use the review year's poverty guidelines?", "§ 2807-k(9-a)(b)", "Discounts depend on federal poverty levels. This audit compares the form with the review year's federal amounts."],
  AI: ["Does assistance cover incomes through 400% of the poverty level?", "§ 2807-k(9-a)(b), (f)", "The required income-based assistance reaches the 400% federal poverty level threshold."],
  AJ: ["Are monthly installments capped at 5% of gross monthly income?", "§ 2807-k(9-a)(d)", "Monthly payments under the financial aid installment plan cannot exceed 5% of income before deductions."],
  AL: ["Does the summary describe the area the hospital serves?", "§ 2807-k(9-a)(c)", "The summary must describe the hospital's primary service area."],
  AM: ["Does the summary explain how to apply?", "§ 2807-k(9-a)(c)", "The summary must explain the means of applying for assistance."],
  AN: ["Does the summary state the income levels for assistance?", "§ 2807-k(9-a)(c)", "The summary must include the income levels used to decide eligibility."],
};

export function hospitalPage(key, { root = process.env.T2P_REVIEW_DIRECTORY || fileURLToPath(new URL("../../.audit/live/", import.meta.url)), records, year = 2026 } = {}) {
  if (!["1002", "362"].includes(key)) return null;
  const local = records ? { records, unavailable: [] } : localRecords(root);
  const merged = new Map([...local.records, ...(records ? [] : baseline)].map((r) => [r.record_id, r]));
  const all = [...merged.values()].filter((r) => r.hospital_key === key && r.guideline_year === year);
  const scopes = latestByScope(all);
  const measures = rubric.measures.map((m) => {
    const versions = scopes.filter((s) => s.latest.measure_id === m.measure_id).map((s) => ({
      scope: s.latest.scope, label: s.success?.scope_label || s.latest.scope_label || s.latest.scope,
      finding: s.success?.finding ?? null, assessed_at: s.success?.checked_at ?? null,
      review_date: s.success?.review_date ?? null, record_id: s.success?.record_id ?? null,
      human_review_status: "Original draft; see review inbox for separate human decisions",
      failures: s.failures.map((f) => ({ attempted_at: f.checked_at, reason: s.success ? f.error : "The recheck failed; no successful finding is available for this scope." })),
    }));
    const results = new Set(versions.map((v) => v.finding?.result || "unclear"));
    const result = results.size === 1 ? [...results][0] : "unclear";
    const [question, section, plain_language] = explanations[m.css_column];
    return { measure_id: m.measure_id, column: m.css_column, title: m.title, question,
      result, reason: !versions.length ? "No successful saved assessment for this measure. Review needed." :
        results.size > 1 ? "Document or language scopes have different results. Read each scope below." : versions[0].finding?.explanation || "The recheck failed before a successful assessment was saved.",
      law: { url: law, section, plain_language, interpretation_status: "Informational mapping; subject-matter review pending (#67)", revision: "2026-05-29" },
      versions };
  });
  const successes = scopes.map((s) => s.success?.checked_at).filter(Boolean).sort((a, b) => Date.parse(b) - Date.parse(a));
  const landing = all.flatMap((r) => r.landing_page || []).filter((s) => validDate(s.retrieved_at)).sort((a,b) => Date.parse(b.retrieved_at)-Date.parse(a.retrieved_at))[0];
  return { hospital_key: key, guideline_year: year, current_grade: null,
    grade_note: "Current institutional grade pending. These source-scoped drafts are not a single approved hospital assessment.",
    latest_successful_assessment_at: successes[0] ?? null,
    publisher_updated_at: landing?.publisher_updated_at ?? null, publisher_page_url: landing?.url ?? null,
    landing_retrieved_at: landing?.retrieved_at ?? null,
    unavailable_records: local.unavailable.length, measures,
    failed_measures: measures.filter((m) => m.versions.some((v) => v.finding?.result === "no")).map((m) => m.measure_id),
  };
}
