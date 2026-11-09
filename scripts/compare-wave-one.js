// Reproduce #38 from checked-in inputs only; never mix in a machine's local review inbox.
import { readFileSync } from "node:fs";
import { pathToFileURL } from "node:url";
import { hospitalPage } from "../backend/hospital-page/service.js";

const load = (path) => JSON.parse(readFileSync(new URL("../" + path, import.meta.url)));
const sample = [
  ["1002", "1002-ellenville-regional-hospital"],
  ["362", "362-little-falls-hospital"],
];
const fields = {
  R: "posted_materials.application_posted", S: "posted_materials.policy_summary_posted",
  T: "posted_materials.policy_statement_posted", U: "posted_materials.consistent_across_documents",
  V: "posted_materials.primary_service_area_boundaries_compliant", W: "posted_materials.no_submission_time_limit",
  Y: "posted_materials.no_evidence_of_asset_checks", Z: "posted_materials.no_immigration_status_barrier",
  AD: "application.entire_uniform_application", AE: "application.contact_information_included",
  AG: "application.income_and_discount_tables_included", AH: "application.uses_2025_fpl_guidelines",
  AI: "application.maximum_fpl", AJ: "application.installments_capped_at_five_percent",
  AL: "policy_summary.primary_service_area_described", AM: "policy_summary.means_of_applying_explained",
  AN: "policy_summary.income_levels_included",
};

export function historicalResult(column, raw) {
  if (column === "AI") {
    const match = typeof raw === "string" && /^(\d+(?:\.\d+)?)%$/.exec(raw.trim());
    return match ? (Number(match[1]) >= 400 ? "yes" : "no") : null;
  }
  return typeof raw === "boolean" ? (raw ? "yes" : "no") : null;
}

export function compareCell(column, historical, measure, guidelineYear) {
  if (!["yes", "no"].includes(historical)) return "baseline unavailable";
  if (!measure.versions.some((s) => s.finding)) return "no completed finding";
  if (column === "AH" && guidelineYear !== 2025) return "different FPL reference years";
  if (!["yes", "no"].includes(measure.result)) return "unresolved draft";
  if (!measure.versions.every((s) => s.finding?.evidence?.some((e) => e.sha256 && e.url && e.locator && e.quote)))
    return "missing citation";
  return historical === measure.result ? "agree" : "differ";
}

export function summarize(pairs) {
  const agree = pairs.filter((p) => p.outcome === "agree").length;
  const differ = pairs.filter((p) => p.outcome === "differ").length;
  return { agree, differ, comparable: agree + differ, excluded: pairs.length - agree - differ, total: pairs.length };
}

export function comparison() {
  const rubric = load("rubrics/css-17-v1.json");
  const rows = rubric.measures.map((m) => ({column:m.css_column, title:m.title, measure_id:m.measure_id, pairs:[]}));
  for (const [key, slug] of sample) {
    const historical = load("data/" + slug + ".json");
    const projection = load("docs/hospital-pages/" + key + ".json");
    if (historical.hospital.permanent_facility_identifier !== key || historical.source.review_month !== "2025-09" ||
        projection.hospital_key !== key || projection.records.some((r) => r.hospital_key !== key))
      throw Error("Hospital or baseline mismatch: " + key);
    const page = hospitalPage(key, {records:projection.records, year:projection.guideline_year});
    const rowNumber = /&range=A(\d+):AQ\1$/.exec(historical.source.row_url)?.[1];
    if (!rowNumber) throw Error("Unknown spreadsheet row: " + key);
    for (const row of rows) {
      const [group, field] = fields[row.column].split(".");
      if (!Object.hasOwn(historical[group], field)) throw Error("Missing CSS field: " + fields[row.column]);
      const raw = historical[group][field], css = historicalResult(row.column, raw);
      const m = page.measures.find((m) => m.measure_id === row.measure_id);
      row.pairs.push({hospital_key:key, hospital:historical.hospital.name, baseline_field:fields[row.column],
        baseline_cell:historical.source.row_url.replace(/range=.*$/, "range=" + row.column + rowNumber),
        baseline_raw:raw, baseline_result:css, draft:m.result, guideline_year:page.guideline_year,
        outcome:compareCell(row.column, css, m, page.guideline_year), reason:m.reason,
        scopes:m.versions.map((s) => ({label:s.label, record_id:s.record_id, assessed_at:s.assessed_at,
          review_date:s.review_date, result:s.finding?.result ?? null,
          citations:(s.finding?.evidence ?? []).map(({url,sha256,locator,export_verification}) => ({url,sha256,locator,export_verification}))}))});
    }
  }
  return {rows: rows.map((r) => ({...r,...summarize(r.pairs)})), totals:summarize(rows.flatMap((r) => r.pairs))};
}

function rate(n,d) { return d ? `${n}/${d} (${Math.round(100*n/d)}%)` : "— (0 comparable)"; }

export function markdown(report) {
  const t = report.totals;
  const lines = ["# Wave 1 agreement with the September 2025 CSS audit",
    "", "Sample: Ellenville Regional Hospital (1002) and Little Falls Hospital (362). Each hospital contributes once per measure. Each pair below reads **CSS → November 2026 draft**.",
    "", `Across ${t.total} hospital–measure pairs, **${rate(t.agree,t.comparable)}** of the comparable pairs agree. **${t.differ} differ and ${t.excluded} are excluded**. This describes agreement between dated labels on this two-hospital sample. It cannot establish statewide accuracy or confirm an institutional grade.`,
    "", "| CSS | Measure | Ellenville | Little Falls | Agree / comparable | Excluded |", "|---|---|---|---|---:|---:|"];
  for (const row of report.rows) {
    const cells = row.pairs.map((p) => `[${p.baseline_result ?? "unknown"}](${p.baseline_cell}) → ${p.draft}${["agree","differ"].includes(p.outcome) ? "" : " ("+p.outcome+")"}`);
    lines.push(`| ${row.column} | ${row.title} | ${cells.join(" | ")} | ${rate(row.agree,row.comparable)} | ${row.excluded} |`);
  }
  lines.push("", "## Coverage by hospital", "", "| Hospital | Comparable / sample pairs | Agree | Differ | Excluded |", "|---|---:|---:|---:|---:|");
  for (const [key] of sample) {
    const pairs = report.rows.flatMap((row) => row.pairs.filter((p) => p.hospital_key === key));
    const counts = summarize(pairs);
    lines.push(`| ${pairs[0].hospital} | ${counts.comparable}/${counts.total} | ${counts.agree} | ${counts.differ} | ${counts.excluded} |`);
  }
  lines.push("", "## Interpretation and replay", "",
    "- The baseline uses the repository’s [Ellenville](../../data/1002-ellenville-regional-hospital.json) and [Little Falls](../../data/362-little-falls-hospital.json) exports. The cell links identify the original spreadsheet rows. Direct spreadsheet access was unavailable during implementation.",
    "- The draft uses the [checked-in hospital pages](../hospital-pages/README.md) and their existing latest-successful-finding selection within each scope. A resolved label with a located citation in each contributing scope is comparable. This counts recorded findings in their reviewed scopes, including English-only application findings and Ellenville’s excerpt-based consistency finding. Agreement does not certify other language versions.",
    "- Conflicting or unclear scopes, N/A, missing findings, missing citations and unavailable baseline values contribute no agreement denominator. A zero denominator has no percentage. AH compares different guideline years. AI uses explicit percentage values against the 400% threshold.",
    "- Little Falls S retains the earlier direct-link posting finding. The [later summary review](../audit-format/summaries/README.md) established designated summaries and supports AL–AN. It is a separate assessment. The report uses the saved posting result until a new posting assessment supersedes it.",
    "- Some Ellenville posting citations had unavailable original bytes during the hospital-page export. This comparison uses the saved citations and preserves their verification flags. Even a difference between two resolved labels requires dated source review before attributing it to a changed document or extraction error (#39).",
    "", "Reproduce offline from the repository root. JSON output includes the historical cell and raw value, dated scope records, source locators, hashes, and the reason for each draft.", "",
    "```bash", "node scripts/compare-wave-one.js", "node scripts/compare-wave-one.js --json", "node --test backend/test/css-agreement.test.js", "```", "");
  return lines.join("\n");
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const report = comparison();
  process.stdout.write(process.argv.includes("--json") ? JSON.stringify(report,null,2)+"\n" : markdown(report));
}
