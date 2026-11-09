import React, { useEffect, useState } from "react";

const roles = { application: "Application", policy_summary: "Plain-language summary", policy_statement: "Policy statement", supplement: "Supplement" };
const safeUrl = (url) => typeof url === "string" && /^https:\/\//.test(url) ? url : undefined;
function Citation({ evidence, url, label = "Source" }) {
  return <details className="context-citation"><summary>{label} · {evidence.locator}</summary>
    <blockquote>{evidence.quote}</blockquote>
    {safeUrl(url) && <a href={url} target="_blank" rel="noreferrer">Open source ↗</a>}
  </details>;
}

export default function ReportingContext({ hospitalKey }) {
  const [state, setState] = useState({ loading: true });
  useEffect(() => {
    const controller = new AbortController();
    setState({ loading: true });
    fetch(`/api/hospitals/${encodeURIComponent(hospitalKey)}/reporting-context`, { signal: controller.signal })
      .then(async (r) => {
        if (r.status === 404) return { unavailable: true };
        if (!r.ok) throw new Error("Reporting context could not be loaded.");
        return { data: await r.json() };
      }).then((next) => { if (!controller.signal.aborted) setState(next); })
      .catch(() => { if (!controller.signal.aborted) setState({ error: true }); });
    return () => controller.abort();
  }, [hospitalKey]);
  if (state.loading) return <p role="status">Loading languages and service area…</p>;
  if (state.unavailable) return <p>Document languages and service area: not yet assessed.</p>;
  if (state.error) return <p role="alert">Languages and service-area context could not be loaded.</p>;
  const { documents, psa, reviewed_at } = state.data;
  const { comparison } = psa;
  return <section className="reporting-context" aria-label="Languages and service area — not graded">
    <h3>Languages and service area</h3>
    <p><strong>Informational — excluded from grade count.</strong></p>
    <p className="context-note">Source review: {reviewed_at.slice(0, 10)}. Saved document inventory; language identification is not translation certification.</p>
    <h4>Hospital-reported PSA counties</h4>
    <p>{psa.reported_counties?.length ? psa.reported_counties.join(", ") : "No explicit county list in the reviewed policy; it names localities instead."}</p>
    {!psa.reported_counties && <p><strong>Reported places:</strong> {Array.from(new Set(psa.statements.flatMap((s) => s.reported_places))).join(", ")}. These are not converted into counties.</p>}
    <p>{psa.summary_note}</p>
    <details><summary>Hospital statements and exact quotes ({psa.statements.length})</summary>
      {psa.statements.map((s) => <article key={s.evidence.sha256}>
        <h4>{roles[s.document_type]} · {s.language}</h4><p>{s.note}</p>
        <Citation evidence={s.evidence} url={s.evidence.url} />
      </article>)}
    </details>
    <h4>Expected PSA counties</h4>
    <p>{comparison.expected_counties ? comparison.expected_counties.join(", ") : "Pending review — no independent county reference established."}</p>
    <p>{comparison.note}</p>
    {comparison.reference && <Citation evidence={comparison.reference} url={comparison.reference.url} label={`Independent reference: ${comparison.reference.publisher}`} />}
    {comparison.status === "differs_from_reference" && <div><strong>Reported counties differ from the independent reference.</strong>
      {comparison.differences.map((d) => <p key={`${d.url}-${d.language}`}>{d.language}: missing {d.missing.join(", ") || "none"}; additional {d.additional.join(", ") || "none"}.</p>)}
    </div>}
    <h4>Document languages</h4>
    {Object.entries(roles).map(([role, label]) => <details key={role} className="document-languages"><summary>{label} languages ({documents.filter((d) => d.role === role).length} documents)</summary>
      <ul>{documents.filter((d) => d.role === role).map((d) => <li key={d.url}>
        <strong>{d.language}</strong> — <a href={safeUrl(d.url)} target="_blank" rel="noreferrer">{d.name}</a>
        <p>{d.note}</p>
        {d.evidence && <Citation evidence={d.evidence} url={d.url} label="Language evidence" />}
      </li>)}</ul>
    </details>)}
    <p className="context-note">The separate graded checks still assess whether the summary describes its service area and whether stated boundaries comply. These reporting fields add no errors or measures.</p>
  </section>;
}
