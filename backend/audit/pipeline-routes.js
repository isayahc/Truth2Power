import { openStore } from "./store.js";
import { enqueuePipeline, publications, pipelineRoot } from "./pipeline-store.js";
import { readArtifact } from "../grading/data.js";
import { sha256 } from "../review/identity.js";

const json = (statusCode, data) => ({ statusCode, headers: { "Content-Type": "application/json", "Cache-Control": "no-store" }, body: JSON.stringify(data) });
export function pipelineRoute(event) {
  const method = event.requestContext?.http?.method;
  const match = /^\/api\/pilot\/hospitals\/(\d{1,8})$/.exec(event.rawPath);
  if (match && method === "POST") {
    if (event.headers?.["x-review-request"] !== "1") return json(403, { error: "Local request header required." });
    let db;
    try {
      const options = JSON.parse(event.body || "{}");
      if (options.mode === "synthetic" && process.env.T2P_PILOT_DEMO !== "1") return json(403, { error: "Synthetic runs require the isolated demo mode." });
      if (!Object.keys(options).every((key) => ["year", "review_date", "mode", "variant", "request_key"].includes(key))) return json(400, { error: "Unsupported audit option." });
      db = openStore();
      const id = enqueuePipeline(db, { ...options, hospital_key: match[1] });
      return json(202, { id });
    } catch { return json(400, { error: "Invalid or conflicting audit request." }); }
    finally { db?.close(); }
  }
  if (method !== "GET") return json(405, { error: "Use GET or a supported queue request." });
  const data = publications(pipelineRoot());
  if (match) {
    const job = data.jobs.find((j) => j.hospital === match[1]);
    const publicJob = job && Object.fromEntries(["id", "status", "attempted", "attempts", "error", "year"].map((k) => [k, job[k]]));
    return json(200, { job: publicJob ?? null, latest: data.bundles.find((b) => b.input.hospital_key === match[1])?.id ?? null });
  }
  const assessment = /^\/api\/pilot\/assessments\/([a-f0-9]{64})$/.exec(event.rawPath);
  if (assessment) {
    const b = data.bundles.find((b) => b.id === assessment[1]);
    return b ? json(200, b) : json(404, { error: "Assessment not found." });
  }
  const snapshot = /^\/api\/pilot\/snapshots\/([a-f0-9]{64})$/.exec(event.rawPath);
  if (snapshot) {
    const s = data.bundles.flatMap((b) => b.input.sources).find((s) => s.snapshot?.sha256 === snapshot[1])?.snapshot;
    if (!s) return json(404, { error: "Snapshot not referenced by a committed assessment." });
    try {
      const bytes = readArtifact(pipelineRoot(), s.artifact_path);
      if (sha256(bytes) !== snapshot[1]) return json(422, { error: "Snapshot integrity check failed." });
      return { statusCode: 200, isBase64Encoded: true, body: bytes.toString("base64"), headers: { "Content-Type": "application/octet-stream",
        "Content-Disposition": `attachment; filename="${s.artifact_path.split("/").at(-1)}"`, "Content-Security-Policy": "sandbox", "X-Content-Type-Options": "nosniff" } };
    } catch { return json(404, { error: "Snapshot unavailable." }); }
  }
  return json(404, { error: "Unknown pipeline endpoint." });
}
