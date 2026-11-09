import { readFileSync } from "node:fs";
import { hospitalPage, pageInputs } from "../hospital-page/service.js";

const load = (file) => JSON.parse(readFileSync(new URL(file, import.meta.url)));
const roster = load("../../data/maps/hospitals.geojson").features;
const { regions } = load("../../references/ny-economic-regions-v1.json");
const countyKey = (name) => name.replaceAll(".", "").toLowerCase();
const regionByCounty = new Map(Object.entries(regions).flatMap(([name, counties]) =>
  counties.map((county) => [countyKey(county), name])));
const windowDays = 30;
const grades = ["A", "B", "C", "D", "F"];

/** Count each roster entry once in each independent breakdown. */
export function summarize(rows) {
  const freshness = { current: 0, overdue: 0, never: 0 };
  const historical = Object.fromEntries(grades.map((g) => [g, 0]));
  const currentGrades = { ...historical, pending: 0, unassessed: 0 };
  const findings = { flagged: 0, no_recorded_failure: 0, unassessed: 0 };
  for (const row of rows) {
    freshness[row.freshness]++;
    historical[row.historical_grade]++;
    currentGrades[row.grade_bucket]++;
    findings[row.finding_bucket]++;
  }
  return { total: rows.length, freshness, historical, current_grades: currentGrades, findings };
}

/** Reduce one hospital-page revision to the fields needed by the map and directory. */
export function hospitalRow({ id, properties: p }, page, asOf) {
  const key = String(id);
  const last = page?.latest_successful_assessment_at ?? null;
  const monitoring = page && Object.hasOwn(page, "monitoring_at") ? page.monitoring_at : last;
  const due = monitoring ? new Date(Date.parse(monitoring) + windowDays * 86400000) : null;
  const region = regionByCounty.get(countyKey(p.county));
  if (!region) throw Error("Unmapped roster county: " + p.county);
  const failed = page?.measures.filter((m) => page.failed_measures.includes(m.measure_id)).map((m) =>
    ({ column: m.column, title: m.title })) ?? [];
  return { hospital_key: key, name: p.name, county: p.county, region,
    historical_grade: p.grade, current_grade: page?.current_grade ?? null,
    grade_bucket: page?.current_grade ?? (last ? "pending" : "unassessed"),
    last_successful_assessment_at: last, monitoring_at: monitoring, audit_mode: page?.audit_mode ?? "scoped_reviews", evidence_complete: page?.evidence_complete ?? false, next_due_at: due?.toISOString() ?? null,
    freshness: !due ? "never" : asOf >= due ? "overdue" : "current",
    finding_bucket: !last ? "unassessed" : failed.length ? "flagged" : "no_recorded_failure",
    revision: page?.revision ?? "unassessed", failed };
}

/** Aggregate the same latest successful source scopes served by the hospital detail route. */
export function overview({ inputs = pageInputs(), asOf = new Date() } = {}) {
  const byHospital = Map.groupBy(inputs.records, (r) => r.hospital_key);
  const hospitals = roster.map((feature) => {
    const key = String(feature.id);
    const page = hospitalPage(key, { records: byHospital.get(key) ?? [], unavailable: inputs.unavailable });
    return hospitalRow(feature, page, asOf);
  });
  return { as_of: asOf.toISOString(), guideline_year: 2026, window_days: windowDays,
    unavailable_records: inputs.unavailable.length, hospitals, statewide: summarize(hospitals),
    regions: Object.keys(regions).map((region) => ({ region, ...summarize(hospitals.filter((h) => h.region === region)) })) };
}
