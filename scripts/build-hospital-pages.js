// Public, previously reviewed evidence only. This creates a display projection, never a new assessment.
import { readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { resolve } from "node:path";
import { localRecords, projectRecord, latestByScope, readBounded } from "../backend/hospital-page/records.js";
import { sha256 } from "../backend/review/identity.js";

const root = resolve(process.env.T2P_REVIEW_DIRECTORY || ".audit/live");
const local = localRecords(root);
if (local.unavailable.length) throw Error("Unreadable review artifacts; inspect before exporting");
const records = local.records;
for (const key of ["1002", "362"]) for (const kind of ["posting", "summaries"]) {
  const path = `docs/audit-format/${kind}/${key}.json`;
  records.push(projectRecord(readFileSync(path), path, kind));
}
mkdirSync("docs/hospital-pages", { recursive: true });
for (const key of ["1002", "362"]) {
  const scoped = latestByScope(records.filter((r) => r.hospital_key === key && r.guideline_year === 2026));
  const ids = new Set(scoped.flatMap((s) => [s.success?.record_id, ...s.failures.map((f) => f.record_id)]));
  const selected = records.filter((r) => ids.has(r.record_id));
  for (const record of selected) {
    const raw = record.artifact_path.startsWith("docs/") ? readFileSync(record.artifact_path) : readBounded(root, record.artifact_path);
    if (sha256(raw) !== record.record_id) throw Error("Original artifact changed");
    const original = JSON.parse(raw);
    for (const f of record.findings) for (const e of f.evidence) {
      const s = original.snapshots.find((s) => s.snapshot_id === e.snapshot_id);
      try {
        if (sha256(readBounded(root, s.artifact_path)) !== e.sha256) throw Error("Evidence hash mismatch");
        e.export_verification = "snapshot_hash_verified";
      } catch (error) {
        if (error.code !== "ENOENT") throw error;
        e.export_verification = "original_snapshot_unavailable";
      }
    }
  }
  writeFileSync(`docs/hospital-pages/${key}.json`, JSON.stringify({ version: 1, hospital_key: key, guideline_year: 2026, records: selected }, null, 2) + "\n");
  console.log(`${key}: exported ${selected.length} hash-bound assessment records; ${selected.flatMap((r) => r.findings.flatMap((f) => f.evidence)).filter((e) => e.export_verification === "original_snapshot_unavailable").length} citations lack local snapshot bytes`);
}
