import React, { useEffect, useRef, useState } from 'react';
import { useLocale } from './locale.jsx';

const states = { queued: 'Queued', running: 'Running', completed: 'Completed', failed: 'Needs review' };
const progressStates = { running: 'Running', succeeded: 'Completed', reused: 'Saved evidence reused', failed: 'Needs review' };
const outcomeLabels = { met: 'Condition met', unmet: 'Condition not met', unclear: 'Unclear', unrun: 'Not run', running: 'Running', queued: 'Queued' };
const safeLink = value => { try { const url = new URL(value); return url.protocol === 'https:' ? url.href : null; } catch { return null; } };

export default function CriterionAudits({ hospitalKey }) {
  const { t, language } = useLocale();
  const url = `/api/hospitals/${hospitalKey}/criteria`;
  const storageKey = `criterion-request-${hospitalKey}`;
  const [data, setData] = useState(null), [error, setError] = useState(false);
  const [tick, refresh] = useState(0), [busy, setBusy] = useState(false), [submitError, setSubmitError] = useState(false);
  const [chosenStep, setChosenStep] = useState(null);
  const [intent, setIntent] = useState(() => {
    try { return JSON.parse(sessionStorage.getItem(storageKey)); } catch { return null; }
  });
  const lock = useRef(false), alive = useRef(true);
  const confirmation = useRef(null);
  useEffect(() => {
    if (!intent || !confirmation.current) return;
    confirmation.current.focus({ preventScroll: true });
    confirmation.current.scrollIntoView({ block: 'nearest' });
  }, [intent?.step, !!data]);
  useEffect(() => { alive.current = true; return () => { alive.current = false; }; }, []);
  useEffect(() => {
    const controller = new AbortController();
    fetch(url, { signal: controller.signal }).then(async r => {
      if (!r.ok) throw Error();
      const result = await r.json();
      if (!controller.signal.aborted) { setData(result); setError(false); }
    }).catch(() => { if (!controller.signal.aborted) setError(true); });
    return () => controller.abort();
  }, [url, tick]);
  useEffect(() => {
    if (!data?.active) return;
    const timer = setTimeout(() => refresh(n => n + 1), 3000);
    return () => clearTimeout(timer);
  }, [data, tick]);
  async function choose(item) {
    if (lock.current) return;
    lock.current = true; setBusy(true); setSubmitError(false); setChosenStep(item.id);
    try {
      const response = await fetch(`${url}/${item.id}/plan`);
      if (!response.ok) throw Error();
      const plan = await response.json();
      if (alive.current) setIntent({ step: item.id, plan, request_key: crypto.randomUUID(), rerun: !!item.saved });
    } catch { if (alive.current) setSubmitError(true); }
    finally { lock.current = false; if (alive.current) setBusy(false); }
  }
  async function submit() {
    if (lock.current || !intent) return;
    lock.current = true; setBusy(true); setSubmitError(false);
    try {
      // Keep the same key after a lost response, including a page reload.
      sessionStorage.setItem(storageKey, JSON.stringify(intent));
      const response = await fetch(`${url}/${intent.step}`, {
        method: 'POST', headers: { 'Content-Type': 'application/json', 'X-Review-Request': '1' },
        body: JSON.stringify({ request_key: intent.request_key, rerun: intent.rerun, approved_steps: intent.plan.run }),
      });
      if (!response.ok) throw Error();
      sessionStorage.removeItem(storageKey);
      if (alive.current) {
        confirmation.current?.closest('.criterion-card').querySelector('h3').focus({ preventScroll: true });
        setIntent(null); refresh(n => n + 1);
      }
    } catch { if (alive.current) setSubmitError(true); }
    finally { lock.current = false; if (alive.current) setBusy(false); }
  }
  const formatDate = value => new Date(value).toLocaleString(language);
  return <section id="audit-runs" className="criterion-audits ops" aria-labelledby="criterion-audits-title">
    <h2 id="criterion-audits-title">{t('Run one criterion at a time')}</h2>
    <p>{t('Viewing results is free of model calls. Run only the criterion you choose; saved documents and prerequisite results are reused.')}</p>
    <p>{t('These are draft findings, separate from the published rating. Unreadable sources or model errors require review, not a hospital failure.')}</p>
    <button type="button" onClick={() => refresh(n => n + 1)}>{t('Refresh')}</button>
    {error && <p role="alert">{t('Unable to load criterion results. Refresh to try again.')}</p>}
    {!data && !error && <p role="status">{t('Loading criterion results…')}</p>}
    <ol className="criterion-list">{data?.items.map(item => {
      const progress = data.active?.progress[item.id];
      const activeStatus = data.active?.step === item.id ? data.active.status : progress?.status === 'running' ? 'running' : null;
      const outcome = activeStatus || (item.latest?.status === 'failed' ? 'unclear' :
        item.saved ? (item.saved.value === true ? 'met' : item.saved.value === false ? 'unmet' : 'unclear') : 'unrun');
      return <li key={item.id} className="criterion-card" data-criterion={item.id}>
        <div className="criterion-card-heading">
          <h3 tabIndex={-1}>{item.id.toUpperCase()} · {t(item.title)}</h3>
          <span className={`criterion-status criterion-status--${outcome}`}>
            <span className="criterion-dot" aria-hidden="true" />{t(outcomeLabels[outcome])}
          </span>
          <button type="button" disabled={busy || !!intent || !!data.active || error} onClick={() => choose(item)}
            aria-expanded={intent?.step === item.id} aria-controls={`criterion-request-${item.id}`}
            aria-label={`${t(item.saved || item.latest ? 'Run again' : 'Run criterion')} ${item.id.toUpperCase()}`}>
            {t(item.saved || item.latest ? 'Run again' : 'Run criterion')}
          </button>
        </div>
    {data.active?.step === item.id && <div className="criterion-progress" role="status">
      <strong>{data.active.step.toUpperCase()} · {t(states[data.active.status])}</strong>
      <p>{t('Only the criterion and prerequisites you approved will run. The job continues after you close the page.')}</p>
      {data.active.status === 'queued' && <p>{t('Waiting for a worker. The audit has not started yet.')}</p>}
      <ul>{Object.entries(data.active.progress).map(([id, entry]) => <li key={id}>{id.toUpperCase()} · {t(progressStates[entry.status] ?? 'Needs review')}</li>)}</ul>
    </div>}
    <div id={`criterion-request-${item.id}`}>
    {intent?.step === item.id && <div ref={confirmation} tabIndex={-1} className="criterion-confirm" role="region" aria-label={`${t('Review criterion run')} ${item.id.toUpperCase()}`}>
      <h3>{t('Review criterion run')} · {intent.step.toUpperCase()}</h3>
      <p>{t('Criteria to execute, including missing prerequisites')}: {intent.plan.run.map(id => id.toUpperCase()).join(', ')}</p>
      <p>{t('Saved prerequisites to reuse')}: {intent.plan.reuse.map(id => id.toUpperCase()).join(', ') || t('None')}</p>
      <p>{t('Missing source documents may be downloaded. Model calls cost money; this is not a fixed-price quote.')}</p>
      <p>{t('Model')}: {intent.plan.model} · {t('Maximum model tasks')}: {intent.plan.max_model_calls} · {t('Time limit (minutes)')}: {intent.plan.timeout_minutes}</p>
      <p>{t('A run may stop with gaps. Another attempt requires your click.')}</p>
      <button type="button" disabled={busy} onClick={submit}>{t(submitError ? 'Retry same request' : 'Confirm criterion run')}</button>{' '}
      <button type="button" disabled={busy} onClick={() => {
         const button = confirmation.current?.closest('.criterion-card').querySelector('.criterion-card-heading button');
         sessionStorage.removeItem(storageKey); setIntent(null); setSubmitError(false); refresh(n => n + 1);
         requestAnimationFrame(() => button?.focus({ preventScroll: true }));
      }}>{t('Close run request')}</button>
    </div>}
    </div>
    {submitError && (intent?.step ?? chosenStep) === item.id && <p role="alert">{t('Request could not be confirmed. Retry the same request safely, or close it and refresh before choosing again.')}</p>}
        {item.latest?.status === 'failed' && <p>{t('The last attempt stopped. Saved findings below remain available; no automatic retry will run.')}</p>}
        {item.saved && <details>
          <summary>{t('Saved result')} · {t(item.saved.value === true ? 'Condition met' : item.saved.value === false ? 'Condition not met' : 'Unresolved')}</summary>
          <p>{t('Saved at')}: {formatDate(item.saved.completed)}</p>
          <p>{t('Agent explanation is in English. Source quotations keep their original language.')}</p>
          <p lang="en">{item.saved.explanation}</p>
          {!!item.saved.scope && <p lang="en">{item.saved.scope}</p>}
          <h4>{t('Source citations')}</h4>
          {!item.saved.evidence.length && <p>{t('No verified citations saved.')}</p>}
          <ul>{item.saved.evidence.map((e, index) => <li key={index}>
            {safeLink(e.sourceUrl) && <a href={safeLink(e.sourceUrl)} target="_blank" rel="noreferrer">{e.sourceUrl}</a>}
            <p>{e.locator} {e.retrievedAt && <>· {t('Source retrieved')}: {formatDate(e.retrievedAt)}</>}</p>
            <blockquote lang="und">{e.quote}</blockquote>
          </li>)}</ul>
          {!!item.saved.limitations.length && <><h4>{t('Limitations and review needs')}</h4><ul lang="en">{item.saved.limitations.map((text, i) => <li key={i}>{text}</li>)}</ul></>}
        </details>}
      </li>;
    })}</ol>
  </section>;
}
