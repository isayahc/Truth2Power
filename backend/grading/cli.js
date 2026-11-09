import { readFileSync } from "node:fs";
import { resolve, dirname } from "node:path";
import { parseArgs } from "node:util";
import { grade } from "./grade.js";
import { adaptArtifact } from "./adapter.js";

try {
  const { positionals: [command, file, ...extra], values } = parseArgs({ allowPositionals: true, options: {
    root: { type: "string" }, decisions: { type: "string" }, "review-date": { type: "string" }, previous: { type: "string" },
  } });
  if (!["grade", "adapt"].includes(command) || !file || extra.length) throw Error("Usage: npm run grade -- grade|adapt FILE [--root EVIDENCE_DIR] [--decisions TRUSTED_DIR] [--review-date YYYY-MM-DD] [--previous PRIOR_INPUT]");
  const raw = readFileSync(file), root = resolve(values.root ?? dirname(file));
  const previous = values.previous && JSON.parse(readFileSync(values.previous));
  const saved = command === "grade" ? JSON.parse(raw) : null;
  const output = command === "grade" ? grade(saved.status === "partial" ? saved.input : saved, { root, decisions: values.decisions, previous }) :
    adaptArtifact(raw, { root, reviewDate: values["review-date"], previous });
  process.stdout.write(JSON.stringify(output, null, 2) + "\n");
  if (output.status === "blocked") process.exitCode = 2;
} catch (error) {
  process.stderr.write(JSON.stringify({ status: "invalid_input", error: error.message }) + "\n");
  process.exitCode = 2;
}
