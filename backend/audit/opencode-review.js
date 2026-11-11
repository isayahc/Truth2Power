// Local snapshots remain authoritative. Agents exchange IDs for bounded, verbatim passages.
import { rubric, expectedFor } from "../grading/data.js";
import { AgentError, invokeAuditAgent } from "./opencode-transport.js";
export { agentReviewConfig } from "./opencode-transport.js";

const packetLimit = 36 * 1024;
const maximumQuote = 700;
const roles = ["website", "documents", "coordinator"];
const fileRoles = new Set(["application", "policy_summary", "policy_statement", "supplement"]);
const measures = new Map(rubric.measures.map(m => [m.measure_id, m]));
const normalize = text => text.normalize("NFKD").replace(/\p{M}/gu, "").toLowerCase().replace(/[^\p{L}\p{N}]+/gu," ").trim();
const negativeScope = /\b(?:excludes?|excluding|except(?:ion)?|does not apply|superseded|sample|draft)\b/i;

function collectPassages(input, analysis) {
  const groups = { website: [], documents: [] };
  for (const source of input.sources) {
    const review = analysis.reviews[source.source_id];
    if (!source.snapshot || !review || review.sha256 !== source.snapshot.sha256 || review.source_id !== source.source_id) continue;
    const passages = [];
    const seen = new Set();
    function add({ locator, quote }) {
      if (typeof locator !== "string" || !locator.length || typeof quote !== "string" || !quote.trim()) return;
      const clipped = quote.slice(0, maximumQuote);
      const key = JSON.stringify([locator, clipped]);
      if (seen.has(key)) return;
      seen.add(key);
      passages.push({ source_id: source.source_id, sha256: review.sha256, role: source.role, campus: review.campus_applicability,
        language: source.language, locator, quote: clipped });
    }
    for (const p of Object.values(review.campus_mentions ?? {})) add(p);
    for (const p of Object.values(review.role_candidates ?? {})) add(p);
    for (const p of review.sample_passages ?? []) add(p);
    const segments = (analysis.sources[source.source_id] ?? []).filter(p => p.status === "extracted" && p.text?.trim());
    if (segments.length) {
      for (const index of new Set([0, Math.floor(segments.length / 2), segments.length - 1])) {
        add({ locator: segments[index].locator, quote: segments[index].text });
      }
    }
    for (const hits of Object.values(review.observations)) for (const p of hits) add(p);
    const role = source.snapshot.artifact_path.endsWith(".html") ? "website" : "documents";
    if (passages.length) groups[role].push(passages);
  }
  return groups;
}

function boundedPassages(groups, byId) {
  // Interleave sources; one long document must not consume the whole packet.
  const passages = [];
  let bytes = 0;
  let omitted = 0;
  const longest = Math.max(0, ...groups.map(g => g.length));
  for (let i = 0; i < longest; i++) for (const g of groups) {
    if (!g[i]) continue;
    const item = { id: byId.size + 1, ...g[i] };
    const size = Buffer.byteLength(JSON.stringify(item)) + 1;
    if (bytes + size > packetLimit) { omitted++; continue; }
    bytes += size;
    passages.push(item);
    byId.set(item.id, item);
  }
  return { passages, omitted };
}

function reviewFailure(error) {
  const code = error instanceof AgentError ? error.code :
    error?.name === "TimeoutError" || error?.name === "AbortError" ? "agent_timeout" :
    ["budget_exhausted","quota_exceeded","unknown_price"].includes(error?.code) ? error.code : "provider_error";
  return { status: "unavailable", reason: code };
}

function nominations(answer, allowed, byId, analysis, hospital) {
  const result = new Map();
  const conflicted = new Set();
  for (const nom of Array.isArray(answer.identities) ? answer.identities.slice(0, 100) : []) {
    if (!nom || !fileRoles.has(nom.role) || !allowed.has(nom.role_id) || !allowed.has(nom.campus_id)) continue;
    const role = byId.get(nom.role_id), campus = byId.get(nom.campus_id);
    if (role.source_id !== campus.source_id || role.role !== "unclassified" || role.campus === "other_campus_requires_review") continue;
    const review = analysis.reviews[role.source_id];
    const key = normalize(hospital);
    const namesOthers = Object.keys(review.campus_mentions ?? {}).some(name => normalize(name) !== key);
    const explicitCoverage = /\b(?:appl(?:ies|icable) to|covers|covered (?:hospitals|facilities)|participating (?:hospitals|facilities))\b/i.test(campus.quote);
    if (!key || !(" " + normalize(campus.quote) + " ").includes(" " + key + " ") || negativeScope.test(campus.quote)
      || negativeScope.test(role.quote) || review.unreadable?.length || (namesOthers && !explicitCoverage)) continue;
    if (result.has(role.source_id) && result.get(role.source_id).role !== nom.role) conflicted.add(role.source_id);
    result.set(role.source_id, { role: nom.role, evidence: [role, campus] });
  }
  for (const id of conflicted) result.delete(id);
  return result;
}

const citation = ({ source_id, sha256, locator, quote }) => ({ source_id, sha256, locator, quote });

/** Run two independent evidence reviewers and reconcile their cited drafts. No human or calculated grade is overwritten. */
export async function reviewWithAgents({ db, job, input, analysis, deadline, invoke = invokeAuditAgent }) {
  const config = job.context.agent_review ?? { runtime: "offline", model: null, paid: false };
  const agents = Object.fromEntries(roles.map(role => [role, { status: "not_configured" }]));
  const output = { ...config, status: "not_configured", agents, findings: [], omitted_passages: 0 };
  if (config.runtime === "offline") return output;
  const hospital = typeof job.context.facility === "string" ? job.context.facility : job.context.facility?.name ?? "";
  const criteria = rubric.measures.map(m => ({ measure_id: m.measure_id, title: m.title, roles: m.roles,
    expected: expectedFor(m, input.guideline_year), evidence_requirement: m.evidence_requirement }));
  const gaps = input.scope?.gaps ?? [];
  const scope = {
    inventory_status: input.scope?.inventory_status ?? "unknown",
    online_application: input.scope?.online_application ?? "unknown",
    gaps: gaps.slice(0, 16).map(gap => gap.slice(0, 320)),
    omitted_gaps: Math.max(0, gaps.length - 16),
  };
  const base = { hospital, hospital_key: input.hospital_key, review_date: input.review_date, year: input.guideline_year, scope, criteria };
  const groups = collectPassages(input, analysis), byId = new Map(), selected = new Map();
  let identities = new Map();
  await Promise.all(["website", "documents"].map(async role => {
    const { passages, omitted } = boundedPassages(groups[role], byId);
    output.omitted_passages += omitted;
    if (!passages.length) { agents[role] = { status: "no_evidence" }; return; }
    const allowed = new Set(passages.map(p => p.id));
    try {
      const answer = await invoke({ role, config, packet: { ...base, passages, omitted }, db, job, deadline });
      if (!Array.isArray(answer?.selections) || answer.selections.length > measures.size) throw new AgentError("invalid_output");
      const choices = new Map();
      for (const row of answer.selections) {
        if (!measures.has(row?.measure_id) || choices.has(row.measure_id) || !Array.isArray(row.ids) || row.ids.length > 4 || !row.ids.every(id => allowed.has(id))) {
          throw new AgentError("invalid_output");
        }
        choices.set(row.measure_id, new Set(row.ids));
      }
      for (const [measure, ids] of choices) {
        if (!selected.has(measure)) selected.set(measure, new Set());
        for (const id of ids) selected.get(measure).add(id);
      }
      if (role === "documents") identities = nominations(answer, allowed, byId, analysis, hospital);
      agents[role] = { status: "completed" };
    } catch (error) { agents[role] = reviewFailure(error); }
  }));
  const selectedIds = new Set([...selected.values()].flatMap(ids => [...ids]));
  let findings = new Map();
  if (selectedIds.size) {
    try {
      const packet = { ...base, agents, omitted_passages: output.omitted_passages,
        selections: Object.fromEntries([...selected].map(([id, refs]) => [id, [...refs].sort((a,b) => a-b)])),
        passages: [...selectedIds].sort((a,b) => a-b).map(id => byId.get(id)),
        proposed_identities: [...identities].map(([source_id, i]) => ({ source_id, role: i.role, evidence: i.evidence.map(citation) })),
      };
      const answer = await invoke({ role: "coordinator", config, packet, db, job, deadline });
      if (!Array.isArray(answer?.findings) || answer.findings.length > measures.size) throw new AgentError("invalid_output");
      for (const row of answer.findings) {
        if (!measures.has(row?.measure_id) || findings.has(row.measure_id) || !["yes","no","unclear","n_a"].includes(row.result)
          || typeof row.explanation !== "string" || !row.explanation.trim() || row.explanation.length > 600 || !Array.isArray(row.ids)
          || row.ids.length > 4 || !row.ids.every(id => selected.get(row.measure_id)?.has(id))) throw new AgentError("invalid_output");
        findings.set(row.measure_id, row);
      }
      if (findings.size !== measures.size) throw new AgentError("invalid_output");
      agents.coordinator = { status: "completed" };
    } catch (error) { findings = new Map(); agents.coordinator = reviewFailure(error); }
  } else {
    agents.coordinator = { status: "no_evidence" };
  }
  for (const m of rubric.measures) {
    const row = findings.get(m.measure_id);
    const ids = row?.ids ?? [...(selected.get(m.measure_id) ?? [])];
    const refs = [...new Set(ids)].map(id => byId.get(id));
    const separateIdentity = new Map();
    let result = row?.result ?? "unclear";
    let explanation = row?.explanation ?? (agents.coordinator.status === "unavailable"
      ? "Coordinator review unavailable for this criterion." : "No supporting evidence was selected for this criterion.");
    if (result !== "unclear") {
      const matches = refs.length > 0 && refs.every(p => {
        const nomination = identities.get(p.source_id);
        if (nomination && m.roles.includes(nomination.role)) {
          separateIdentity.set(p.source_id, { source_id: p.source_id, proposed_role: nomination.role, evidence: nomination.evidence.map(citation) });
          return true;
        }
        return p.campus === "applicable" && m.roles.includes(p.role);
      });
      if (!matches) { result = "unclear"; explanation = "The cited passages do not establish an applicable document role and campus for this criterion."; }
    }
    output.findings.push({ measure_id: m.measure_id, result, explanation, evidence: refs.map(citation),
      ...(separateIdentity.size ? { identity_basis: [...separateIdentity.values()] } : {}) });
  }
  output.status = agents.coordinator.status === "completed" && !Object.values(agents).some(a => a.status === "unavailable")
    ? "completed" : "partial";
  return output;
}
