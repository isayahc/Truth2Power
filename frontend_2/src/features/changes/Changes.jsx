import React, { useEffect, useState } from "react";
import { useLocale } from "../../i18n/locale.jsx";

import rubric from "../../assets/rubrics/css-17-v1.json";

// Port of the old app's Changes.jsx (Phase 2). Same logic and behaviour;
// every user-facing string goes through t() so the feed is bilingual.
// Hospital names, identifiers and evidence quotations stay untranslated.

const measures = new Map(rubric.measures.map((m) => [m.measure_id, m]));

function Evidence({ label, evidence }) {
  const { t } = useLocale();
  return <section><h3>{label}{evidence.result && ` · ${evidence.result}`}</h3>
    <p>{t('Retrieved')} {evidence.retrieved_at} · {t('Publisher update')} {evidence.publisher_updated_at || t('unknown')}</p>
    <p>{evidence.locator}</p><blockquote>{evidence.excerpt}</blockquote>
    <a href={evidence.url} target="_blank" rel="noreferrer">{t('Open publisher source')}</a>
    {evidence.saved_url && <> · <a href={evidence.saved_url}>{t('Download saved bytes')}</a></>}
    <p>SHA-256 <code>{evidence.sha256}</code></p>
    {evidence.assessment_id && <p><a href={evidence.assessment_url} target="_blank" rel="noreferrer">{t('Saved assessment')} {evidence.assessment_id}</a></p>}</section>;
}

export default function Changes() {
  const { t, localHref } = useLocale();
  const [data, setData] = useState(null);
  const [error, setError] = useState(false);
  const [attempt, setAttempt] = useState(0);
  useEffect(() => {
    const controller = new AbortController();
    setError(false); setData(null);
    fetch("/api/changes", { signal: controller.signal }).then(async (r) => {
      if (!r.ok) throw Error();
      const json = await r.json();
      if (!controller.signal.aborted) setData(json);
    }).catch(() => { if (!controller.signal.aborted) setError(true); });
    return () => controller.abort();
  }, [attempt]);
  return <section className="changes-feed"><a href={localHref('?view=overview')}>← {t('Audit overview')}</a>
    <h1>{t('Recent changes')}</h1>
    <button onClick={() => setAttempt(attempt + 1)}>{t('Refresh changes')}</button>
    {error && <p role="alert">{t('Saved captures could not be compared. Please retry.')}</p>}
    {!data && !error && <p role="status">{t('Comparing saved captures…')}</p>}
    {data && <>
      {!!data.warnings.length && <details><summary>{t('Incomplete evidence')} ({data.warnings.length})</summary>
        <ul>{data.warnings.map((w) => <li key={w}>{w}</li>)}</ul></details>}
      {!data.events.length && <p>{t('No verified changes in the available captures.')}</p>}
      {data.events.map((e) => <article key={e.id}>
        <h2><a href={`?hospital=${encodeURIComponent(e.hospital_key)}`}>{e.hospital_name}</a></h2>
        <p><strong>{e.kind === "newly_verified" ? t('Newly verified by the audit') : t('Published material changed')}</strong> · {t('Detected')} {e.detected_at}</p>
        <p>{e.description}</p><p>{t('Related checks:')} {e.measures.length ? e.measures.map((id) => <a className="change-measure" key={id} href={`?hospital=${e.hospital_key}#measure-${e.hospital_key}-${measures.get(id)?.css_column}`}>{measures.get(id)?.title ?? id}</a>) : t('Impact requires review')}</p>
        {["added_links", "removed_links"].map((key) => !!e[key]?.length && <details key={key}><summary>{key === "added_links" ? t('Added') : t('Removed')} {t('links')} ({e[key].length})</summary>
          <ul>{e[key].map((url) => <li key={url}>{url}</li>)}</ul></details>)}
        <details><summary>{t('Earlier and later evidence')}</summary>
          <Evidence label={t('Earlier')} evidence={e.before} /><Evidence label={t('Later')} evidence={e.after} />
        </details></article>)}
    </>}
  </section>;
}
