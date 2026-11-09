import { readFileSync } from "node:fs";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { fileURLToPath } from "node:url";
import { resolve } from "node:path";
import { readBounded } from "../hospital-page/records.js";
import { sha256 } from "../review/identity.js";

const execute = promisify(execFile);
const script = fileURLToPath(new URL("../../tools/live-audit/changes.py", import.meta.url));
const defaultRoot = fileURLToPath(new URL("../../.audit/live/", import.meta.url));
const assessments = new Map(["posting/362.json", "changes/362-summary-posting.json"].map((path) => {
  const bytes = readFileSync(new URL("../../docs/audit-format/" + path, import.meta.url));
  return [sha256(bytes), bytes.toString("utf8")];
}));
const json = (statusCode, body) => ({ statusCode, headers: {"Content-Type":"application/json","Cache-Control":"no-store"}, body:JSON.stringify(body) });

/** Replay local public evidence; any downloaded snapshot is inert and hash verified. */
export async function changesRoute(event) {
  if (event.requestContext?.http?.method !== "GET") return json(405,{error:"Use GET."});
  const root = resolve(process.env.T2P_REVIEW_DIRECTORY || defaultRoot);
  if (event.rawPath === "/api/changes") {
    try {
      const {stdout} = await execute(process.env.T2P_PYTHON || "python", [script,"--root",root], {timeout:60000,maxBuffer:16*1024*1024});
      return json(200,JSON.parse(stdout));
    } catch { return json(503,{error:"Could not replay the saved captures."}); }
  }
  const assessment = /^\/api\/changes\/assessments\/([a-f0-9]{64})$/.exec(event.rawPath);
  if (assessment && assessments.has(assessment[1])) return {statusCode:200,
    headers:{"Content-Type":"application/json","Cache-Control":"no-store"},body:assessments.get(assessment[1])};
  const match = /^\/api\/changes\/snapshots\/([a-f0-9]{64})\.(html|pdf|docx)$/.exec(event.rawPath);
  if (!match) return json(404,{error:"Unknown change endpoint."});
  const filename = match[1]+"."+match[2];
  try {
    const raw = readBounded(root,"snapshots/"+filename);
    if (sha256(raw) !== match[1]) return json(422,{error:"Snapshot checksum mismatch."});
    return {statusCode:200,isBase64Encoded:true,body:raw.toString("base64"),headers:{
      "Content-Type":"application/octet-stream","Content-Disposition":`attachment; filename="${filename}"`,
      "X-Content-Type-Options":"nosniff","Content-Security-Policy":"sandbox"}};
  } catch { return json(404,{error:"Original snapshot unavailable."}); }
}
