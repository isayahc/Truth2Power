import React, { useEffect, useState } from "react";
import { AgentFinding } from "./AgentReview.jsx";
import {CriterionCoverage} from './CriterionCoverage.jsx';

const labels = { yes: "Yes", no: "No", unclear: "Unclear", n_a: "Not applicable" };
const date = (value) => value ? new Date(value).toISOString().replace("T", " ").replace(/\.\d+Z$/, " UTC") : "Unknown";
const safeUrl = (url) => typeof url === "string" && /^https:\/\//.test(url) ? url : undefined;

export default function HospitalAssessment({ hospitalKey, hospitalName, publishedRevision }) {
  const [state, setState] = useState({ loading: true });
  const [reload, setReload] = useState(0);
  const revision = new URLSearchParams(window.location.search).get("revision");
  useEffect(() => {
    const controller = new AbortController();
    setState({ loading: true });
    fetch(`/api/hospitals/${encodeURIComponent(hospitalKey)}/page${revision ? "?revision=" + encodeURIComponent(revision) : ""}`, { signal: controller.signal }).then(async (r) => {
      if (r.status === 409) return { changed: true };
      if (r.status === 404) return { unavailable: true };
      if (!r.ok) throw Error();
      return { data: await r.json() };
    }).then((next) => { if (!controller.signal.aborted) setState(next); })
      .catch(() => { if (!controller.signal.aborted) setState({ error: true }); });
    return () => controller.abort();
  }, [hospitalKey, reload, revision, publishedRevision]);
  useEffect(() => {
    const hash = window.location.hash.slice(1);
    if (state.data && hash.startsWith("measure-" + hospitalKey + "-")) {
      const target = document.getElementById(hash);
      if (target) { target.open = true; target.scrollIntoView(); }
    }
  }, [state.data, hospitalKey]);
  if (state.changed) return <p role="alert">The assessment changed since this overview. <a href="?view=overview">Refresh the overview</a></p>;
  if (state.loading) return <p role="status">Loading hospital findings…</p>;
  if (state.unavailable) return <p>The current review has no measure-by-measure findings yet.</p>;
  if (state.error) return <div role="alert">Hospital findings could not be loaded. <button onClick={() => setReload((n) => n + 1)}>Try again</button></div>;
  const report = state.data;
  return <section className="hospital-assessment" aria-label="Current hospital findings">
    {report.synthetic && <p role="status"><strong>SYNTHETIC DEMO — fabricated evidence, not hospital compliance findings.</strong></p>}
    <details className="assessment-context"><summary>Current financial assistance findings</summary>
    {report.integrated_report_url && <p><a href={report.integrated_report_url}>Inspect immutable 17-measure assessment</a> · revision {report.revision.slice(0, 12)}</p>}
    {report.integrated_report_url && <p>Evidence coverage: {report.evidence_complete ? "complete for this scope" : "partial — see blockers"}. Source freshness clock: {date(report.monitoring_at)}. Replaying saved bytes does not reset their retrieval date.</p>}
    <p><strong>Current grade: pending</strong></p><p>{report.grade_note}</p>
    <CriterionCoverage hospitalKey={hospitalKey} />
    <dl className="assessment-dates">
      <dt>Latest successful assessment</dt><dd>{date(report.latest_successful_assessment_at)}</dd>
      <dt>Hospital page retrieved</dt><dd>{date(report.landing_retrieved_at)}</dd>
      <dt>Publisher’s page update date</dt><dd>{date(report.publisher_updated_at)}</dd>
    </dl>
    <p>The publisher’s update date is not the date we retrieved or assessed the page. Each measure has its own assessment date and scope.</p>
    {report.unavailable_records > 0 && <p role="status">Some local review records could not be read. Saved findings remain visible; refresh coverage is incomplete.</p>}
    <h4>Checks with a “No” finding ({report.failed_measures.length})</h4>
    <p>Draft findings below identify the affected check and related law. Human review remains separate.</p>
    <ul>{report.failed_measures.map((id) => { const m = report.measures.find((m) => m.measure_id === id); return <li key={id}><a href={`#measure-${hospitalKey}-${m.column}`} onClick={() => { const target = document.getElementById(`measure-${hospitalKey}-${m.column}`); if (target) target.open = true; }}>{m.question}</a></li>; })}</ul>
    {!report.failed_measures.length && <p>No “No” finding in the available drafts. Unclear or unassessed checks are not passes.</p>}
    </details>
    <h4>All 17 measures · {report.guideline_year} review</h4>
    {report.measures.map((m) => <details className="measure-card" id={`measure-${hospitalKey}-${m.column}`} key={m.measure_id}>
      <summary><span>{m.column} · {m.question}</span> <strong className={`measure-result result-${m.result}`}>{labels[m.result]}{m.versions.length ? " · draft" : " · not assessed"}</strong></summary>
      <div className="measure-body">
      <p>{m.reason}</p>
      {m.agent_finding && <AgentFinding finding={m.agent_finding} revision={report.revision} heading />}
      {m.versions.filter((v) => v.finding?.result === "no" && v.finding.evidence.length > 0).map((v) => {
        const e = v.finding.evidence[0];
        return <details key={v.record_id + v.scope} className="correction-draft"><summary>Draft a correction request · {v.label}</summary>
          <label>Editable letter to the financial assistance office<textarea rows={8}
            defaultValue={`To the financial assistance office at ${hospitalName},\n\nPlease review this draft finding about ${m.title.toLowerCase()}. The review dated ${v.review_date || v.assessed_at} recorded the following for ${v.label}:\n\n${v.finding.explanation}\n\nSource: ${e.url} (${e.locator})\n\nCould you clarify the current policy or provide an updated public document?`} /></label>
        </details>;
      })}
      {m.versions.flatMap((v) => v.failures.map((f) => ({ ...f, scope: v.scope, retained: Boolean(v.finding) }))).map((f, i) =>
        <p className="recheck-failed" key={`${f.scope}-${i}`}><strong>Failed recheck · {date(f.attempted_at)}</strong> — {f.retained ? "Last successful finding retained below." : "No successful finding yet."}</p>)}
      <p><a href={m.law.url} target="_blank" rel="noreferrer">{m.law.section}</a>: {m.law.plain_language}</p>
      <details><summary>Evidence, dates and scope ({m.versions.length})</summary>
        <p>{m.law.interpretation_status}. Law revision: {m.law.revision}.</p>
        {m.versions.map((v) => <section key={v.scope} className="measure-scope">
          <h5>{v.label}</h5>
          {v.failures.map((f, i) => <p className="recheck-failed" key={i}><strong>Failed recheck · {date(f.attempted_at)}</strong> — {f.reason}</p>)}
          <p>Latest successful assessment: {date(v.assessed_at)}{v.review_date && ` · Review date: ${v.review_date}`}</p>
          <p><strong>{v.finding ? labels[v.finding.result] : "No successful finding"}</strong> — {v.finding?.explanation || "Evidence still needed."}</p>
          <p>{v.human_review_status}</p>
          {v.finding?.evidence.map((e, i) => <details className="measure-evidence" key={`${e.snapshot_id}-${i}`}>
            <summary>Source · {e.locator} · retrieved {date(e.retrieved_at)}</summary>
            <a href={safeUrl(e.url)} target="_blank" rel="noreferrer">Open cited document ↗</a>
            <p>Publisher’s document update date: {date(e.publisher_updated_at)}</p>
            <blockquote>{e.quote}</blockquote>
            <p>Snapshot SHA-256: <code>{e.sha256}</code></p>
            {e.export_verification === "original_snapshot_unavailable" && <p>Original snapshot is unavailable in this checkout. The saved assessment citation is retained; the live link may have changed.</p>}
          </details>)}
          {!!v.finding?.candidate_passages?.length && <details>
            <summary>Candidate passages for review ({v.finding.candidate_passages.length})</summary>
            {v.finding.candidate_passages.map((p, i) => <div key={i}>
              <p>{p.worker === "website_reviewer" ? "Website review" : "Document review"} · {p.locator}</p>
              <blockquote>{p.quote}</blockquote>
              <a href={p.saved_url} download>Download cited snapshot</a> · <a href={safeUrl(p.source_url)} target="_blank" rel="noreferrer">Original source ↗</a>
              <p>Document role: {p.role} · Language: {p.language} · Campus: {p.campus.replaceAll("_", " ")}</p>
            </div>)}
          </details>}
          {!v.finding?.evidence.length && <p>No located evidence supplied; review needed.</p>}
        </section>)}
      </details>
      </div>
    </details>)}
  </section>;
}
