import React, { useEffect, useRef, useState } from "react";

export const reviewStatus = (value) => ({ pending: "Needs review", needs_information: "More information needed", resolved: "Reviewed" }[value] ?? value);
const outcome = (value) => value === "n_a" ? "N/A" : value ?? "Not recorded";
const date = (value) => new Date(value).toLocaleString();

export async function reviewRequest(path, options) {
  const response = await fetch(path, options);
  const data = await response.json();
  if (!response.ok) throw new Error(data.error || "The review request failed.");
  return data;
}

function Evidence({ evidence }) {
  return <div className="review-evidence">{evidence.map((e, i) => <article key={i}>
    <strong>{e.document || "Source document"}</strong>
    <div className="review-meta">{e.locator} · {e.retrieved_at ? `Retrieved ${date(e.retrieved_at)}` : "Retrieval date unknown"}</div>
    <blockquote>{e.quote}</blockquote>
    <div className="review-links">
      {e.saved_url && <a href={e.saved_url} target="_blank" rel="noreferrer">Open saved source{e.locator?.startsWith("page ") ? ` · ${e.locator}` : ""} ↗</a>}
      {e.url && <a href={e.url} target="_blank" rel="noreferrer">Current website / document ↗</a>}
      {e.unavailable && <span>Saved source reference unavailable</span>}
    </div>
  </article>)}</div>;
}

function WholeFormReview({ review }) {
  if (!review) return null;
  return <section aria-label="Rendered whole-form interpretation">
    <h4>Rendered whole-form interpretation</h4>
    <p className="review-meta">{review.reviewed_at} · {review.reviewer} · {review.reference_units_reviewed} reference text units accounted for</p>
    <p>{review.conclusion}</p><p><strong>Recommendation pending approval:</strong> {review.recommendation}</p>
    <details><summary>Visual section-by-section comparison</summary>
      <p>{review.limitations}</p>
      {review.visual_sections.map((s) => <article key={s.section}><h4>{s.section}</h4><p>{s.observation}</p>
        <div className="review-links">{["reference", "application"].map((role) => <span key={role}>{role === "reference" ? "Official reference" : "Hospital application"}: {s[`${role}_pages`].map((page) =>
          review.renders[role].saved_url ? <a key={page} href={`${review.renders[role].saved_url}#page=${page}`} target="_blank" rel="noreferrer">page {page} ↗ </a> : <span key={page}>page {page} (unavailable) </span>)}</span>)}</div>
      </article>)}
    </details>
    <details><summary>Resolved points and authority</summary>
      <ul>{review.resolved_points.map((point) => <li key={point}>{point}</li>)}</ul>
      <p>{review.authority.locator}</p><blockquote>{review.authority.quote}</blockquote>
      <p>{review.authority.interpretation}</p>
      {review.authority.url && <a href={review.authority.url} target="_blank" rel="noreferrer">Statutory source ↗</a>}
    </details>
  </section>;
}

function DecisionForm({ item, onSaved }) {
  const [action, setAction] = useState("confirm");
  const [result, setResult] = useState(item.draft_result);
  const [role, setRole] = useState("");
  const [notes, setNotes] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  async function submit(event) {
    event.preventDefault();
    setBusy(true); setError("");
    try {
      const updated = await reviewRequest(`/api/reviews/${item.id}/decisions`, {
        method: "POST", headers: { "Content-Type": "application/json", "X-Review-Request": "1" },
        body: JSON.stringify({ action, result, reviewer_role: role, notes, revision: item.revision }),
      });
      onSaved(updated);
    } catch (e) { setError(e.message); } finally { setBusy(false); }
  }
  return <form className="review-form" onSubmit={submit}>
    <h3>Record a human decision</h3>
    <p>Confirming an unclear finding records agreement with its uncertainty. It does not turn it into a pass.</p>
    <label>Decision<select aria-label="Decision" value={action} onChange={(e) => setAction(e.target.value)} disabled={busy}>
      <option value="confirm">Confirm draft finding ({outcome(item.draft_result)})</option>
      <option value="correct">Correct the finding</option>
      <option value="request_information">Request information / leave unresolved</option>
    </select></label>
    {action === "correct" && <label>Corrected result<select aria-label="Corrected result" value={result} onChange={(e) => setResult(e.target.value)} disabled={busy}>
      {["yes", "no", "unclear", "n_a"].map((r) => <option key={r} value={r}>{outcome(r)}</option>)}
    </select></label>}
    <label>Reviewer role<input required maxLength={100} value={role} onChange={(e) => setRole(e.target.value)} placeholder="e.g. Policy reviewer" disabled={busy} /></label>
    <label>Reason / information needed<textarea required maxLength={2000} rows={4} value={notes} onChange={(e) => setNotes(e.target.value)} disabled={busy}
      placeholder="Explain the interpretation and cite the document/page. For N/A, identify the rubric exemption. Do not include patient information." /></label>
    <p className="review-meta">Local review: role is self-attested. This updates the reviewed finding, not the original draft or statewide rating.</p>
    {error && <p role="alert">{error} <button type="button" className="plain" onClick={() => onSaved(null)}>Reload item</button></p>}
    <button className="review-primary" disabled={busy || !role.trim() || !notes.trim()}>{busy ? "Saving…" : "Save review decision"}</button>
  </form>;
}

export default function ReviewInbox({ inbox, error, onRefresh, hospitalKey, hospitals, onHospital }) {
  const [hospital, setHospital] = useState(hospitalKey || "");
  const [language, setLanguage] = useState("");
  const [status, setStatus] = useState("open");
  const [selected, setSelected] = useState(null);
  const [item, setItem] = useState(null);
  const [detailError, setDetailError] = useState("");
  const [reload, setReload] = useState(0);
  const [message, setMessage] = useState("");
  const heading = useRef(null);
  const detailHeading = useRef(null);
  useEffect(() => { heading.current?.focus(); }, []);
  useEffect(() => { if (item) detailHeading.current?.focus(); }, [item?.id]);
  useEffect(() => {
    if (!selected) return;
    const controller = new AbortController();
    setItem(null); setDetailError(""); setMessage("");
    reviewRequest(`/api/reviews/${selected}`, { signal: controller.signal }).then(setItem).catch((e) => {
      if (!controller.signal.aborted) setDetailError(e.message);
    });
    return () => controller.abort();
  }, [selected, reload]);
  const languages = [...new Set((inbox?.items ?? []).flatMap((r) => r.documents.map((d) => d.language)))].sort();
  const visible = (inbox?.items ?? []).filter((r) => (!language || r.documents.some((d) => d.language === language)) && (!hospital || r.hospital_key === hospital) &&
    (status === "all" || (status === "open" ? r.status !== "resolved" : r.status === "resolved")));
  const hospitalOptions = [...new Map((inbox?.items ?? []).map((r) => [r.hospital_key, r.hospital_name]))];
  return <section className="review-inbox" aria-labelledby="review-title">
    <div className="review-heading"><div><div className="section-tag">Human review</div><h1 id="review-title" tabIndex={-1} ref={heading}>Review inbox</h1>
      <p>Hospital findings that need a person’s interpretation. Original evidence stays attached.</p></div>
      <button className="plain" onClick={onRefresh}>Refresh inbox</button></div>
    <div className="review-filters">
      <label>Hospital<select aria-label="Hospital" value={hospital} onChange={(e) => { setHospital(e.target.value); setSelected(null); setItem(null); }}>
        <option value="">All hospitals</option>{hospitalOptions.map(([key, name]) => <option key={key} value={key}>{name}</option>)}
      </select></label>
      <label>Document language<select value={language} onChange={(e) => { setLanguage(e.target.value); setSelected(null); setItem(null); }}>
        <option value="">All languages</option>{languages.map((tag) => <option key={tag} value={tag}>{tag === "und" ? "Unknown" : tag}</option>)}
      </select></label>
      <label>Status<select aria-label="Status" value={status} onChange={(e) => setStatus(e.target.value)}><option value="open">Needs attention</option><option value="resolved">Reviewed</option><option value="all">All statuses</option></select></label>
    </div>
    {error && <p role="alert">{error} <button className="plain" onClick={onRefresh}>Try again</button></p>}
    {!inbox && !error && <p role="status">Loading review notifications…</p>}
    {!!inbox?.unavailable && <p role="alert">{inbox.unavailable} saved result file(s) could not be read. This inbox may be incomplete.</p>}
    <div className="review-layout">
      <nav aria-label="Review notifications" className="review-notifications">
        {inbox && !visible.length && <p>{hospital ? "No matching review items for this hospital." : "No matching review items."} Completed full-document drafts appear here automatically.</p>}
        {visible.map((r) => <button key={r.id} className={`review-notification ${selected === r.id ? "active" : ""}`} aria-current={selected === r.id ? "true" : undefined} onClick={() => setSelected(r.id)}>
          <span className="review-meta">{reviewStatus(r.status)} · {date(r.flagged_at)}</span>
          <strong>{r.hospital_name}</strong><span>{r.title}</span><span className="review-meta">{r.documents.length === 1 ? `${r.documents[0].name} · ${r.documents[0].language} · ` : ""}{r.scope_label}</span><small>{r.question}</small>
        </button>)}
      </nav>
      <section className="review-detail" aria-label="Selected review">
        {!selected && <p>Select a notification to see the question, source documents and review actions.</p>}
        {selected && !item && !detailError && <p role="status">Loading source context…</p>}
        {detailError && <p role="alert">{detailError} <button className="plain" onClick={() => setReload((n) => n + 1)}>Retry</button></p>}
        <p role="status">{message}</p>
        {item && <>
          <div className="section-tag">{reviewStatus(item.status)}</div><h2 tabIndex={-1} ref={detailHeading}>{item.hospital_name}</h2>
          <button className="plain" onClick={() => onHospital(hospitals.find((h) => String(h.id) === item.hospital_key))}>View hospital on map</button>
          <h3>{item.title}</h3>
          <p className="review-meta">Scope: {item.scope_label}{item.guideline_year ? ` · Review guideline year: ${item.guideline_year}` : ""}</p>
          <details><summary>Source identity and revisions ({item.version_count})</summary>
            {item.identity_warning && <p>Historical identity is ambiguous. {item.identity_warning}</p>}
            <ul>{item.documents.map((d) => <li key={JSON.stringify([d.source_id, d.role, d.language])}>
              {d.name} · {d.role} · {d.language === "und" ? "Unknown language" : d.language}<br />
              <a href={d.source_id} target="_blank" rel="noreferrer">{d.source_id}</a><br />Snapshot SHA-256 <code>{d.snapshot_sha256}</code>
            </li>)}</ul>
            {item.document_versions.map((v, i) => <p key={v.result_sha256}>{i ? "Prior" : "Current"} · {date(v.checked_at)} · {v.item_id && v.item_id !== item.id
              ? <button className="plain" onClick={() => setSelected(v.item_id)}>View revision {v.result_id}</button> : v.result_id}</p>)}
          </details>
          <div className="review-question"><strong>Question for review</strong><p>{item.question}</p></div>
          <p><strong>Original draft:</strong> {outcome(item.draft_result)} · <strong>Reviewed result:</strong> {outcome(item.reviewed_result)}</p>
          <p>{item.explanation}</p>
          <p><strong>Criterion:</strong> {typeof item.expected === "string" ? item.expected : item.expected?.guideline_year ?
            `${item.expected.guideline_year} annual HHS guidelines; one-person 400% amount: $${item.expected.one_person_400_percent.toLocaleString()}.` : item.expected?.condition ?? JSON.stringify(item.expected)}</p>
          {item.authority_url && <p><a href={item.authority_url} target="_blank" rel="noreferrer">Reference source ↗</a></p>}
          {item.template_comparison && <section aria-label="Verified template comparison">
            <h3>Verified template comparison</h3>
            <p>Text evidence verified against saved originals. Whole-form approval remains pending.</p>
            <WholeFormReview review={item.template_comparison.whole_form_review} />
            <p className="review-meta">{item.template_comparison.reference_version} · Retrieved {date(item.template_comparison.reference_retrieved_at)} · {item.template_comparison.parser_version}</p>
            {item.template_comparison.numeric_authority_url && <p><a href={item.template_comparison.numeric_authority_url} target="_blank" rel="noreferrer">HHS dollar-check authority ↗</a> · {item.template_comparison.numeric_reference_version}</p>}
            <details><summary>Official reference part coverage ({item.template_comparison.reference_parts.length})</summary>
              <p>{item.template_comparison.retrieval_method}</p>
              <ul>{item.template_comparison.reference_parts.map((p) => <li key={p.locator}>{p.locator}: {p.status}{p.empty ? " · Empty part verified" : ""}{p.reason ? ` · ${p.reason}` : ""}</li>)}</ul>
            </details>
            {item.template_comparison.observations.map((o, i) => <details key={i}>
              <summary>{o.title}</summary><p className="review-meta">{o.kind.replaceAll("_", " ")}</p>
              <p>{o.explanation}</p><Evidence evidence={o.evidence} />
            </details>)}
            <h4>Remaining interpretation questions</h4><ul>{item.template_comparison.unresolved_questions.map((q) => <li key={q}>{q}</li>)}</ul>
          </section>}
          {!!item.observed?.cells?.length && <details><summary>Published vs expected FPL amounts ({item.observed.cells.length} cells)</summary>
            <p>Published year: {item.observed.published_year ?? "Unverified"} · {item.observed.currency} · {item.observed.period}</p>
            <div className="review-table-scroll"><table><caption>Dollar comparison by household size and FPL percentage</caption>
              <thead><tr><th scope="col">Household size</th><th scope="col">FPL %</th><th scope="col">Published</th><th scope="col">Expected</th><th scope="col">Match</th></tr></thead>
              <tbody>{item.observed.cells.map((cell, i) => <tr key={i}><td>{cell.household_size}</td><td>{cell.fpl_percent}%</td><td>${cell.observed.toLocaleString()}</td><td>${cell.expected.toLocaleString()}</td><td>{cell.observed === cell.expected ? "Yes" : "No"}</td></tr>)}</tbody>
            </table></div></details>}
          {!!item.extraction_details?.drawings?.length && <details><summary>Drawing extraction evidence ({item.extraction_details.drawings.length})</summary>
            <p>Parser: {item.extraction_details.parser_version}. {item.extraction_details.limitations}</p>
            <ul>{item.extraction_details.drawings.map((drawing) => <li key={drawing.locator}>
              <strong>{drawing.name || "Unnamed drawing"}</strong> · {drawing.locator}<br />
              {drawing.explanation}<br /><small>Drawing XML SHA-256: {drawing.xml_sha256}</small>
            </li>)}</ul>
          </details>}
          {!!item.other_application_versions_not_assessed?.length && <details><summary>Other application versions not assessed ({item.other_application_versions_not_assessed.length})</summary>
            <p>These findings cover only the selected application, not all language versions.</p><ul>{item.other_application_versions_not_assessed.map((url) => <li key={url}><a href={url} target="_blank" rel="noreferrer">{url.split("/").at(-1)} ↗</a></li>)}</ul>
          </details>}
          <p className="review-meta">Flagged {date(item.flagged_at)} · Hospital {item.hospital_key} · Result {item.result_id}</p>
          <h3>Quoted evidence</h3>
          {!item.evidence.length && <p>No quoted evidence was saved. Request the missing source before making an evidence-backed decision.</p>}
          <Evidence evidence={item.evidence} />
          {!!item.gaps.length && <><h3>Missing evidence</h3><ul>{item.gaps.map((g, i) => <li key={i}>{g.reason}: {g.detail || "Source could not be fully reviewed."} {g.url && <a href={g.url} target="_blank" rel="noreferrer">Source ↗</a>}</li>)}</ul></>}
          <details><summary>Full source and language coverage ({item.coverage.length})</summary><ul>{item.coverage.map((c) => <li key={c.source_id}>
            {c.language} · {c.status} · {c.reviewed_pages}/{c.total_pages} {c.locator_unit ?? "pages"}. {c.url && <a href={c.url} target="_blank" rel="noreferrer">Current document ↗</a>}{" "}
            {c.saved_url && <a href={c.saved_url} target="_blank" rel="noreferrer">Saved source ↗</a>}<p>{c.notes}</p>
          </li>)}</ul></details>
          <details><summary>Source-by-source reasoning</summary>{item.observations.map((o, i) => <article key={i}><h4>{o.source_id} · {o.position} · {o.context}</h4><p>{o.explanation}</p><Evidence evidence={o.evidence} /></article>)}</details>
          {item.is_current ? <DecisionForm key={`${item.id}:${item.revision}`} item={item} onSaved={(updated) => {
            if (updated) { setItem(updated); setMessage("Decision saved. The original draft is preserved."); onRefresh(); }
            else setReload((n) => n + 1);
          }} /> : <p>Historical revision · read only</p>}
          <details open={item.history.length > 0}><summary>Decision history ({item.history.length})</summary>
            {item.history.length ? item.history.map((d) => <article key={d.decision_id}><h4>{d.reviewer_role} · {date(d.recorded_at)}</h4><p>{d.action} · {outcome(d.result)}</p><p>{d.notes}</p></article>) : <p>No human decision recorded for this exact draft.</p>}
          </details>
        </>}
      </section>
    </div>
  </section>;
}
