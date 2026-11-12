// grade-wrapper.mjs — runs the repo's deterministic Node grader on behalf of
// backend_2, which cannot run Node code in-process. The wrapper itself lives
// in backend_2's resources; the grading logic stays in backend/grading/
// (never ported to Java, per the plan). Usage:
//   node grade-wrapper.mjs <grade.js path> <input.json path> <root dir> [decisions dir]
// Prints the grading report JSON to stdout. Exits 2 when grade() throws
// (matching the grading CLI's invalid-input exit code).
import { readFileSync } from "node:fs";
import { pathToFileURL } from "node:url";

const gradePath = process.argv[2];
const inputPath = process.argv[3];
const root = process.argv[4];
const decisions = process.argv[5] || undefined;
try {
  const { grade } = await import(pathToFileURL(gradePath).href);
  const input = JSON.parse(readFileSync(inputPath, "utf8"));
  const report = grade(input, { root, decisions });
  process.stdout.write(JSON.stringify(report));
} catch (error) {
  process.stderr.write("grade_failed: " + (error?.message ?? error) + "\n");
  process.exit(2);
}
