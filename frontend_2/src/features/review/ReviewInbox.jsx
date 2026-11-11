import React, { useEffect, useRef, useState } from "react";
import { getJson, reviewRequest } from "../../api/client.js";
import { useLocale } from "../../i18n/locale.jsx";

// Port of the old app's ReviewInbox.jsx (Phase 2). Same logic and behaviour;
// every user-facing string goes through t() so the inbox is bilingual.
// Hospital names, identifiers and evidence quotations stay untranslated.

const date = (value) => new Date(value).toLocaleString();

function Evidence({ evidence }) {
  const { t } = useLocale();
  return <div className="review-evidence">{evidence.map((e, i) => <article key={i}>
    <strong>{e.document || t('Source document')}</strong>
    <div className="review-meta">{e.locator} · {e.retrieved_at ? `${t('Retrieved')} ${date(e.retrieved_at)}` : t('Retrieval date unknown')}</div>
    <blockquote>{e.quote}</blockquote>
    <div className="review-links">
      {e.saved_url && <a href={e.saved_url} target="_blank" rel="noreferrer">{t('Open saved source')}{e.locator?.startsWith("page ") ? ` · ${e.locator}` : ""} ↗</a>}
      {e.url && <a href={e.url} target="_blank" rel="noreferrer">{t('Current website / document ↗')}</a>}
      {e.unavailable && <span>{t('Saved source reference unavailable')}</span>}
    </div>
  </article>)}</div>;
}

function WholeFormReview({ review }) {
  const { t } = useLocale();
  if (!review) return null;
  return <section aria-label={t('Rendered whole-form interpretation')}>
    <h4>{t('Rendered whole-form interpretation')}</h4>
    <p className="review-meta">{review.reviewed_at} · {review.reviewer} · {review.reference_units_reviewed} {t('reference text units accounted for')}</p>
    <p>{review.conclusion}</p><p><strong>{t('Recommendation pending approval:')}</strong> {review.recommendation}</p>
    <details><summary>{t('Visual section-by-section comparison')}</summary>
      <p>{review.limitations}</p>
      {review.visual_sections.map((s) => <article key={s.section}><h4>{s.section}</h4><p>{s.observation}</p>
        <div className="review-links">{["reference", "application"].map((role) => <span key={role}>{role === "reference" ? t('Official reference') : t('Hospital application')}: {s[`${role}_pages`].map((page) =>
          review.renders[role].saved_url ? <a key={page} href={`${review.renders[role].saved_url}#page=${page}`} target="_blank" rel="noreferrer">{t('page')} {page} ↗ </a> : <span key={page}>{t('page')} {page} ({t('unavailable')}) </span>)}</span>)}</div>
      </article>)}
    </details>
    <details><summary>{t('Resolved points and authority')}</summary>
      <ul>{review.resolved_points.map((point) => <li key={point}>{point}</li>)}</ul>
      <p>{review.authority.locator}</p><blockquote>{review.authority.quote}</blockquote>
      <p>{review.authority.interpretation}</p>
      {review.authority.url && <a href={review.authority.url} target="_blank" rel="noreferrer">{t('Statutory source ↗')}</a>}
    </details>
  </section>;
}

function DecisionForm({ item, onSaved }) {
  const { t } = useLocale();
  const outcome = (value) => value === "n_a" ? "N/A" : value ?? t('Not recorded');
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
      const updated = await reviewRequest(`/api/reviews/${item.id}/decisions`,
        { action, result, reviewer_role: role, notes, revision: item.revision });
      onSaved(updated);
    } catch (e) { setError(e.message); } finally { setBusy(false); }
  }
  return <form className="review-form" onSubmit={submit}>
    <h3>{t('Record a human decision')}</h3>
    <p>{t('Confirming an unclear finding records agreement with its uncertainty. It does not turn it into a pass.')}</p>
    <label>{t('Decision')}<select aria-label={t('Decision')} value={action} onChange={(e) => setAction(e.target.value)} disabled={busy}>
      <option value="confirm">{t('Confirm draft finding')} ({outcome(item.draft_result)})</option>
      <option value="correct">{t('Correct the finding')}</option>
      <option value="request_information">{t('Request information / leave unresolved')}</option>
    </select></label>
    {action === "correct" && <label>{t('Corrected result')}<select aria-label={t('Corrected result')} value={result} onChange={(e) => setResult(e.target.value)} disabled={busy}>
      {["yes", "no", "unclear", "n_a"].map((r) => <option key={r} value={r}>{outcome(r)}</option>)}
    </select></label>}
    <label>{t('Reviewer role')}<input required maxLength={100} value={role} onChange={(e) => setRole(e.target.value)} placeholder={t('e.g. Policy reviewer')} disabled={busy} /></label>
    <label>{t('Reason / information needed')}<textarea required maxLength={2000} rows={4} value={notes} onChange={(e) => setNotes(e.target.value)} disabled={busy}
      placeholder={t('Explain the interpretation and cite the document/page. For N/A, identify the rubric exemption. Do not include patient information.')} /></label>
    <p className="review-meta">{t('Local review: role is self-attested. This updates the reviewed finding, not the original draft or statewide rating.')}</p>
    {error && <p role="alert">{error} <button type="button" className="plain" onClick={() => onSaved(null)}>{t('Reload item')}</button></p>}
    <button className="review-primary" disabled={busy || !role.trim() || !notes.trim()}>{busy ? t('Saving…') : t('Save review decision')}</button>
  </form>;
}

export default function ReviewInbox({ inbox, error, onRefresh, hospitalKey, hospitals, onHospital }) {
  const { t, language } = useLocale();
  const reviewStatus = (value) => ({ pending: t('Needs review'), needs_information: t('More information needed'), resolved: t('Reviewed') }[value] ?? value);
  const outcome = (value) => value === "n_a" ? "N/A" : value ?? t('Not recorded');
  const languageNames = new Intl.DisplayNames([language], { type: "language" });
  const languageName = (tag) => tag === "und" ? t('Unknown language') : languageNames.of(tag) || tag;
  const [hospital, setHospital] = useState(hospitalKey || "");
  const [languageFilter, setLanguageFilter] = useState("");
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
    getJson(`/api/reviews/${selected}`, controller.signal).then(setItem).catch((e) => {
      if (!controller.signal.aborted) setDetailError(e.message);
    });
    return () => controller.abort();
  }, [selected, reload]);
  useEffect(() => {
    if (inbox && item?.id === selected && item.is_current && !inbox.items.some((r) => r.id === selected)) setReload((n) => n + 1);
  }, [inbox, selected, item?.id, item?.is_current]);
  const languages = [...new Set((inbox?.items ?? []).flatMap((r) => r.documents.map((d) => d.language)))].sort();
  const visible = (inbox?.items ?? []).filter((r) => (!languageFilter || r.documents.some((d) => d.language === languageFilter)) && (!hospital || r.hospital_key === hospital) &&
    (status === "all" || (status === "open" ? r.status !== "resolved" : r.status === "resolved")));
  const hospitalOptions = [...new Map((inbox?.items ?? []).map((r) => [r.hospital_key, r.hospital_name]))];
  return <section className="review-inbox" aria-labelledby="review-title">
    <div className="review-heading"><div><div className="section-tag">{t('Human review')}</div><h1 id="review-title" tabIndex={-1} ref={heading}>{t('Review inbox')}</h1>
      <p>{t('Hospital findings that need a person’s interpretation. Original evidence stays attached.')}</p></div>
      <button className="plain" onClick={onRefresh}>{t('Refresh inbox')}</button></div>
    <div className="review-filters">
      <label>{t('Hospital')}<select aria-label={t('Hospital')} value={hospital} onChange={(e) => { setHospital(e.target.value); setSelected(null); setItem(null); }}>
        <option value="">{t('All hospitals')}</option>{hospitalOptions.map(([key, name]) => <option key={key} value={key}>{name}</option>)}
      </select></label>
      <label>{t('Document language')}<select value={languageFilter} onChange={(e) => { setLanguageFilter(e.target.value); setSelected(null); setItem(null); }}>
        <option value="">{t('All languages')}</option>{languages.map((tag) => <option key={tag} value={tag}>{languageName(tag)}</option>)}
      </select></label>
      <label>{t('Status')}<select aria-label={t('Status')} value={status} onChange={(e) => setStatus(e.target.value)}><option value="open">{t('Needs attention')}</option><option value="resolved">{t('Reviewed')}</option><option value="all">{t('All statuses')}</option></select></label>
    </div>
    {error && <p role="alert">{error} <button className="plain" onClick={onRefresh}>{t('Try again')}</button></p>}
    {!inbox && !error && <p role="status">{t('Loading review notifications…')}</p>}
    {!!inbox?.unavailable && <p role="alert">{inbox.unavailable} {t('saved result file(s) could not be read. This inbox may be incomplete.')}</p>}
    <div className="review-layout">
      <nav aria-label={t('Review notifications')} className="review-notifications">
        {inbox && !visible.length && <p>{hospital ? t('No matching review items for this hospital.') : t('No matching review items.')}{t(' Completed full-document drafts appear here automatically.')}</p>}
        {visible.map((r) => <button key={r.id} className={`review-notification ${selected === r.id ? "active" : ""}`} aria-current={selected === r.id ? "true" : undefined} onClick={() => setSelected(r.id)}>
          <span className="review-meta">{reviewStatus(r.status)} · {date(r.flagged_at)}</span>
          <strong>{r.hospital_name}</strong><span>{r.title}</span><span className="review-meta">{r.documents.length === 1 ? `${r.documents[0].name} · ${languageName(r.documents[0].language)} · ` : ""}{r.scope_label}</span><small>{r.question}</small>
        </button>)}
      </nav>
      <section className="review-detail" aria-label={t('Selected review')}>
        {!selected && <p>{t('Select a notification to see the question, source documents and review actions.')}</p>}
        {selected && !item && !detailError && <p role="status">{t('Loading source context…')}</p>}
        {detailError && <p role="alert">{detailError} <button className="plain" onClick={() => setReload((n) => n + 1)}>{t('Retry')}</button></p>}
        <p role="status">{message}</p>
        {item && <>
          <div className="section-tag">{reviewStatus(item.status)}</div><h2 tabIndex={-1} ref={detailHeading}>{item.hospital_name}</h2>
          <button className="plain" onClick={() => onHospital(hospitals.find((h) => String(h.id) === item.hospital_key))}>{t('View hospital record')}</button>
          <h3>{item.title}</h3>
          <p className="review-meta">{t('Scope:')} {item.scope_label}{item.guideline_year ? ` · ${t('Review guideline year:')} ${item.guideline_year}` : ""}</p>
          <details><summary>{t('Source identity and revisions')} ({item.version_count})</summary>
            {item.identity_warning && <p>{item.identity_warning}</p>}
            <ul>{item.documents.map((d) => <li key={JSON.stringify([d.source_id, d.role, d.language])}>
              {d.name} · {d.role} · {languageName(d.language)}<br />
              <a href={d.source_id} target="_blank" rel="noreferrer">{d.source_id}</a><br />{t('Snapshot SHA-256')} <code>{d.snapshot_sha256}</code>
            </li>)}</ul>
            {item.document_versions.map((v, i) => <p key={v.result_sha256}>{i ? t('Prior') : t('Current')} · {date(v.checked_at)} · {v.item_id && v.item_id !== item.id
              ? <button className="plain" onClick={() => setSelected(v.item_id)}>{t('View revision')} {v.result_id}</button> : v.result_id}</p>)}
          </details>
          <div className="review-question"><strong>{t('Question for review')}</strong><p>{item.question}</p></div>
          <p><strong>{t('Original draft:')}</strong> {outcome(item.draft_result)} · <strong>{t('Reviewed result:')}</strong> {outcome(item.reviewed_result)}</p>
          <p>{item.explanation}</p>
          <p><strong>{t('Criterion:')}</strong> {typeof item.expected === "string" ? item.expected : item.expected?.guideline_year ?
            `${item.expected.guideline_year} ${t('annual HHS guidelines; one-person 400% amount:')} $${item.expected.one_person_400_percent.toLocaleString()}.` : item.expected?.condition ?? JSON.stringify(item.expected)}</p>
          {item.authority_url && <p><a href={item.authority_url} target="_blank" rel="noreferrer">{t('Reference source ↗')}</a></p>}
          {item.template_comparison && <section aria-label={t('Verified template comparison')}>
            <h3>{t('Verified template comparison')}</h3>
            <p>{t('Text evidence verified against saved originals. Whole-form approval remains pending.')}</p>
            <WholeFormReview review={item.template_comparison.whole_form_review} />
            <p className="review-meta">{item.template_comparison.reference_version} · {t('Retrieved')} {date(item.template_comparison.reference_retrieved_at)} · {item.template_comparison.parser_version}</p>
            {item.template_comparison.numeric_authority_url && <p><a href={item.template_comparison.numeric_authority_url} target="_blank" rel="noreferrer">{t('HHS dollar-check authority ↗')}</a> · {item.template_comparison.numeric_reference_version}</p>}
            <details><summary>{t('Official reference part coverage')} ({item.template_comparison.reference_parts.length})</summary>
              <p>{item.template_comparison.retrieval_method}</p>
              <ul>{item.template_comparison.reference_parts.map((p) => <li key={p.locator}>{p.locator}: {p.status}{p.empty ? ` · ${t('Empty part verified')}` : ""}{p.reason ? ` · ${p.reason}` : ""}</li>)}</ul>
            </details>
            {item.template_comparison.observations.map((o, i) => <details key={i}>
              <summary>{o.title}</summary><p className="review-meta">{o.kind.replaceAll("_", " ")}</p>
              <p>{o.explanation}</p><Evidence evidence={o.evidence} />
            </details>)}
            <h4>{t('Remaining interpretation questions')}</h4><ul>{item.template_comparison.unresolved_questions.map((q) => <li key={q}>{q}</li>)}</ul>
          </section>}
          {!!item.observed?.cells?.length && <details><summary>{t('Published vs expected FPL amounts')} ({item.observed.cells.length} {t('cells')})</summary>
            <p>{t('Published year:')} {item.observed.published_year ?? t('Unverified')} · {item.observed.currency} · {item.observed.period}</p>
            <div className="review-table-scroll"><table><caption>{t('Dollar comparison by household size and FPL percentage')}</caption>
              <thead><tr><th scope="col">{t('Household size')}</th><th scope="col">{t('FPL %')}</th><th scope="col">{t('Published')}</th><th scope="col">{t('Expected')}</th><th scope="col">{t('Match')}</th></tr></thead>
              <tbody>{item.observed.cells.map((cell, i) => <tr key={i}><td>{cell.household_size}</td><td>{cell.fpl_percent}%</td><td>${cell.observed.toLocaleString()}</td><td>${cell.expected.toLocaleString()}</td><td>{cell.observed === cell.expected ? t('Yes') : t('No')}</td></tr>)}</tbody>
            </table></div></details>}
          {!!item.extraction_details?.drawings?.length && <details><summary>{t('Drawing extraction evidence')} ({item.extraction_details.drawings.length})</summary>
            <p>{t('Parser:')} {item.extraction_details.parser_version}. {item.extraction_details.limitations}</p>
            <ul>{item.extraction_details.drawings.map((drawing) => <li key={drawing.locator}>
              <strong>{drawing.name || t('Unnamed drawing')}</strong> · {drawing.locator}<br />
              {drawing.explanation}<br /><small>{t('Drawing XML SHA-256:')} {drawing.xml_sha256}</small>
            </li>)}</ul>
          </details>}
          {!!item.other_application_versions_not_assessed?.length && <details><summary>{t('Other application versions not assessed')} ({item.other_application_versions_not_assessed.length})</summary>
            <p>{t('These findings cover only the selected application, not all language versions.')}</p><ul>{item.other_application_versions_not_assessed.map((url) => <li key={url}><a href={url} target="_blank" rel="noreferrer">{url.split("/").at(-1)} ↗</a></li>)}</ul>
          </details>}
          <p className="review-meta">{t('Flagged')} {date(item.flagged_at)} · {t('Hospital')} {item.hospital_key} · {t('Result')} {item.result_id}</p>
          <h3>{t('Quoted evidence')}</h3>
          {!item.evidence.length && <p>{t('No quoted evidence was saved. Request the missing source before making an evidence-backed decision.')}</p>}
          <Evidence evidence={item.evidence} />
          {!!item.gaps.length && <><h3>{t('Missing evidence')}</h3><ul>{item.gaps.map((g, i) => <li key={i}>{g.reason}: {g.detail || t('Source could not be fully reviewed.')} {g.url && <a href={g.url} target="_blank" rel="noreferrer">{t('Source ↗')}</a>}</li>)}</ul></>}
          <details><summary>{t('Full source and language coverage')} ({item.coverage.length})</summary><ul>{item.coverage.map((c) => <li key={c.source_id}>
            {c.language} · {c.status} · {c.reviewed_pages}/{c.total_pages} {c.locator_unit ?? t('pages')}. {c.url && <a href={c.url} target="_blank" rel="noreferrer">{t('Current document ↗')}</a>}{" "}
            {c.saved_url && <a href={c.saved_url} target="_blank" rel="noreferrer">{t('Saved source ↗')}</a>}<p>{c.notes}</p>
          </li>)}</ul></details>
          <details><summary>{t('Source-by-source reasoning')}</summary>{item.observations.map((o, i) => <article key={i}><h4>{o.source_id} · {o.position} · {o.context}</h4><p>{o.explanation}</p><Evidence evidence={o.evidence} /></article>)}</details>
          {item.is_current ? <DecisionForm key={`${item.id}:${item.revision}`} item={item} onSaved={(updated) => {
            if (updated) { setItem(updated); setMessage(t('Decision saved. The original draft is preserved.')); onRefresh(); }
            else setReload((n) => n + 1);
          }} /> : <p>{t('Historical revision · read only')}</p>}
          <details open={item.history.length > 0}><summary>{t('Decision history')} ({item.history.length})</summary>
            {item.history.length ? item.history.map((d) => <article key={d.decision_id}><h4>{d.reviewer_role} · {date(d.recorded_at)}</h4><p>{d.action} · {outcome(d.result)}</p><p>{d.notes}</p></article>) : <p>{t('No human decision recorded for this exact draft.')}</p>}
          </details>
        </>}
      </section>
    </div>
  </section>;
}
