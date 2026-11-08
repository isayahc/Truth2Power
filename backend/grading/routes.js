import { fileURLToPath } from "node:url";
import { resolve } from "node:path";
import { grade } from "./grade.js";
import { readArtifact } from "./data.js";

const demoRoot = fileURLToPath(new URL("../../docs/grading/examples/", import.meta.url));
const defaultRoot = fileURLToPath(new URL("../../.audit/grading/", import.meta.url));
const response = (statusCode, data) => ({ statusCode, headers: { "Content-Type": "application/json", "Cache-Control": "no-store" }, body: JSON.stringify(data) });

/** Read only a specifically staged assessment or the named synthetic demo. No path parameters reach the filesystem unchecked. */
export function gradingRoute(event) {
  if (event.requestContext?.http?.method !== "GET") return response(405, { error: "Use GET." });
  const key = /^\/api\/grading\/hospitals\/(\d{1,8}|t2p-\d+)$/.exec(event.rawPath)?.[1];
  const demo = event.rawPath === "/api/grading/demo";
  if (!demo && !key) return response(404, { error: "Unknown assessment." });
  const root = demo ? demoRoot : resolve(process.env.T2P_GRADING_DIRECTORY || defaultRoot);
  try {
    const input = JSON.parse(readArtifact(root, demo ? "SYN-multilingual.json" : key + ".json"));
    if (!demo && key !== input.hospital_key) return response(422, { error: "Assessment hospital mismatch." });
    return response(200, grade(input, { root, decisions: demo ? undefined : process.env.T2P_OBSERVATION_DECISIONS }));
  } catch (error) {
    if (error.code === "ENOENT") return response(404, { error: "Saved assessment or evidence unavailable." });
    return response(422, { error: "Saved assessment could not be validated. Run the local grading command for details." });
  }
}
