// Trusted model transports for one source-review turn. Files and prompts never enter the event log.
import { execFile } from "node:child_process";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { reservePaid } from "./budgets.js";
import { providerEvent, measure } from "./usage-ledger.js";
import { fingerprint } from "../grading/data.js";

const execute = promisify(execFile);
const projectConfig = JSON.parse(readFileSync(new URL("../../opencode.json", import.meta.url)));
const outputLimit = 4096;
const responseLimit = 256 * 1024;
const validModel = /^[A-Za-z0-9][A-Za-z0-9._:/-]{0,126}$/;

export function agentReviewConfig(env = process.env) {
  const local = env.T2P_OPENCODE_LOCAL_MODEL?.trim();
  const model = local || env.T2P_OPENROUTER_MODEL?.trim() || (env.OPENROUTER_API_KEY && "openrouter/free");
  if (!model) return { runtime: "offline", model: null, paid: false };
  if (!validModel.test(model) || model.includes("..")) throw Error("Invalid audit model ID");
  return { runtime: local ? "opencode" : "openrouter", model, paid: !local && !freeModel(model) };
}

const freeModel = model => model === "openrouter/free" || model.endsWith(":free");

export class AgentError extends Error {
  constructor(code) { super(code); this.code = code; }
}

function promptFor(role) {
  return readFileSync(new URL("../../tools/live-audit/prompts/audit-" + role + ".md", import.meta.url), "utf8");
}

function parseReply(text) {
  if (typeof text !== "string" || text.length > responseLimit) throw new AgentError("invalid_output");
  try { return JSON.parse(text.trim().replace(/^\x60\x60\x60(?:json)?\s*/i, "").replace(/\s*\x60\x60\x60$/, "")); }
  catch { throw new AgentError("invalid_output"); }
}

async function localAgent({ role, config, packet }, timeout) {
  const root = await mkdtemp(join(tmpdir(), "truth2power-review-"));
  const name = "audit-" + role;
  // Only the selected local provider, no project MCP tools, shared provider credentials or writable checkout.
  const env = Object.fromEntries(["PATH","Path","PATHEXT","SystemRoot","WINDIR","TMP","TEMP","TMPDIR","LANG","LD_LIBRARY_PATH"]
    .filter(key => process.env[key]).map(key => [key, process.env[key]]));
  Object.assign(env, { XDG_CONFIG_HOME: join(root, "config"), XDG_DATA_HOME: join(root, "data"),
    XDG_STATE_HOME: join(root, "state"), XDG_CACHE_HOME: join(root, "cache"), APPDATA: join(root, "config"),
    LOCALAPPDATA: join(root, "data"), NO_PROXY: "127.0.0.1,localhost", T2P_LOCAL_PROVIDER: "local" });
  try {
    const model = config.model;
    const project = {
      model: "audit-local/" + model,
      providers: { "audit-local": { name: "Audit local", env: ["T2P_LOCAL_PROVIDER"],
        package: "@opencode/ai/providers/openai-compatible", settings: { baseURL: "http://127.0.0.1:11434/v1" },
        body: { max_tokens: outputLimit }, models: { [model]: { name: model } } } },
      agents: { [name]: { ...projectConfig.agents[name], model: "audit-local/" + model, system: promptFor(role) } },
    };
    await writeFile(join(root, "opencode.json"), JSON.stringify(project));
    await writeFile(join(root, "evidence.txt"), JSON.stringify(packet), { mode: 0o600 });
    const { stdout } = await execute(process.env.T2P_OPENCODE_BIN || "opencode",
      ["run","--standalone","--title",name,"--format","json","--agent",name,"--model","audit-local/" + model,
       "--file","evidence.txt","Review the attached evidence packet. Return the requested JSON."],
      { cwd: root, env, timeout, maxBuffer: responseLimit, windowsHide: true, killSignal: "SIGKILL" });
    const events = stdout.trim().split(/\r?\n/).filter(Boolean).map(line => JSON.parse(line));
    if (events.some(e => e.type === "error")) throw new AgentError("provider_error");
    const parts = events.filter(e => e.type === "text").map(e => e.part?.text ?? e.text ?? "");
    return parseReply(parts.join(""));
  } catch (error) {
    if (error instanceof AgentError) throw error;
    throw new AgentError(error.code === "ENOENT" ? "opencode_missing" : error.killed ? "agent_timeout" : "opencode_failed");
  } finally {
    await rm(root, { recursive: true, force: true, maxRetries: 3 });
  }
}

async function limitedJson(response) {
  let size = 0;
  const chunks = [];
  for await (const chunk of response.body) {
    size += chunk.length;
    if (size > responseLimit) throw new AgentError("invalid_output");
    chunks.push(chunk);
  }
  try { return JSON.parse(Buffer.concat(chunks).toString("utf8")); }
  catch { throw new AgentError("invalid_output"); }
}

async function routerAgent({ role, packet, config, db, job }, timeout) {
  const key = process.env.OPENROUTER_API_KEY;
  if (!key) throw new AgentError("missing_credentials");
  const messages = [{ role: "system", content: promptFor(role) }, { role: "user", content: JSON.stringify(packet) }];
  const modelKey = "openrouter/global/" + config.model;
  const id = "agent-" + role + "-" + fingerprint({ messages, model: config.model, job: job.id });
  const paid = !freeModel(config.model);
  const maxPrice = { prompt: 0, completion: 0, request: 0 };
  if (paid) {
    if (!job.context.budget?.paid) throw new AgentError("paid_disabled");
    // UTF-8 bytes conservatively bound ordinary text tokens, including extra chat framing allowance.
    const inputBound = Buffer.byteLength(JSON.stringify(messages)) + 512;
    const reserved = reservePaid(db, job, id, modelKey, { input_tokens: inputBound, cached_input_tokens: 0, output_tokens: outputLimit });
    if (!reserved) throw new AgentError("already_reserved");
    const rates = JSON.parse(db.prepare("SELECT card FROM audit_prices WHERE job=?").get(job.id).card).models[modelKey];
    maxPrice.prompt = rates.input_tokens * 1e6;
    maxPrice.completion = rates.output_tokens * 1e6;

  } else {
    measure({ free_model_calls: 1 });
  }
  const event = { job: job.id, attempt: job.token, provider: "openrouter", region: "global", model: config.model,
    stage: "model_review", usage_id: id };
  let usage;
  try {
    const response = await fetch("https://openrouter.ai/api/v1/chat/completions", {
      method: "POST", redirect: "error", signal: AbortSignal.timeout(timeout),
      headers: { Authorization: "Bearer " + key, "Content-Type": "application/json" },
      body: JSON.stringify({ model: config.model, messages, max_tokens: outputLimit,
        provider: { max_price: maxPrice }, plugins: [], stream: false }),
    });
    if (!response.ok) {
      await response.body?.cancel();
      throw new AgentError(response.status === 429 ? "rate_limited" : "provider_error");
    }
    const answer = await limitedJson(response);
    usage = answer.usage;
    return parseReply(answer.choices?.[0]?.message?.content);
  } finally {
    if (paid) {
      // A dispatched request may have been charged even when the connection failed.
      // The ledger counts one provider event as one paid call. Missing quantities remain unknown.
      const actual = {};
      const cached = usage?.prompt_tokens_details?.cached_tokens ?? 0;
      if (Number.isSafeInteger(usage?.prompt_tokens) && Number.isSafeInteger(cached) && cached >= 0 && cached <= usage.prompt_tokens) {
        actual.input_tokens = usage.prompt_tokens - cached;
        actual.cached_input_tokens = cached;
      }
      if (Number.isSafeInteger(usage?.completion_tokens) && usage.completion_tokens >= 0) actual.output_tokens = usage.completion_tokens;
      providerEvent(db, { ...event, usage: actual });
      if (Number.isFinite(usage?.cost) && usage.cost >= 0) providerEvent(db, { ...event, bill: { amount: usage.cost, currency: "USD" } });
    } else if (usage) {
      const counts = {};
      if (Number.isSafeInteger(usage.prompt_tokens) && usage.prompt_tokens >= 0) counts.free_model_input_tokens = usage.prompt_tokens;
      if (Number.isSafeInteger(usage.completion_tokens) && usage.completion_tokens >= 0) counts.free_model_output_tokens = usage.completion_tokens;
      measure(counts);
    }
  }
}

export async function invokeAuditAgent(args) {
  const remaining = Math.floor(args.deadline - Date.now());
  if (remaining <= 0) throw new AgentError("agent_timeout");
  const timeout = Math.min(90_000, remaining);
  if (args.config.runtime === "opencode") return localAgent(args, timeout);
  if (args.config.runtime === "openrouter") return routerAgent(args, timeout);
  throw new AgentError("not_configured");
}
