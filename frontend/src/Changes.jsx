import React, { useEffect, useState } from "react";

import rubric from "../../rubrics/css-17-v1.json";

const measures = new Map(rubric.measures.map((m) => [m.measure_id,m]));

function Evidence({ label, evidence }) {
  return <section><h3>{label}{evidence.result && ` · ${evidence.result}`}</h3>
    <p>Retrieved {evidence.retrieved_at} · Publisher update {evidence.publisher_updated_at || "unknown"}</p>
    <p>{evidence.locator}</p><blockquote>{evidence.excerpt}</blockquote>
    <a href={evidence.url} target="_blank" rel="noreferrer">Open publisher source</a>
    {evidence.saved_url && <> · <a href={evidence.saved_url}>Download saved bytes</a></>}
    <p>SHA-256 <code>{evidence.sha256}</code></p>
    {evidence.assessment_id && <p><a href={evidence.assessment_url} target="_blank" rel="noreferrer">Saved assessment {evidence.assessment_id}</a></p>}</section>;
}

export default function Changes() {
  const [data,setData] = useState(null);
  const [error,setError] = useState(false);
  const [attempt,setAttempt] = useState(0);
  useEffect(() => {
    const controller = new AbortController();
    setError(false); setData(null);
    fetch("/api/changes",{signal:controller.signal}).then(async (r) => {
      if (!r.ok) throw Error();
      const json = await r.json();
      if (!controller.signal.aborted) setData(json);
    }).catch(() => { if (!controller.signal.aborted) setError(true); });
    return () => controller.abort();
  }, [attempt]);
  return <section className="changes-feed"><a href="?view=overview">← Audit overview</a>
    <h1>Recent changes</h1>
    <button onClick={() => setAttempt(attempt+1)}>Refresh changes</button>
    {error && <p role="alert">Saved captures could not be compared. Please retry.</p>}
    {!data && !error && <p role="status">Comparing saved captures…</p>}
    {data && <>
      {!!data.warnings.length && <details><summary>Incomplete evidence ({data.warnings.length})</summary>
        <ul>{data.warnings.map((w) => <li key={w}>{w}</li>)}</ul></details>}
      {!data.events.length && <p>No verified changes in the available captures.</p>}
      {data.events.map((e) => <article key={e.id}>
        <h2><a href={`?hospital=${encodeURIComponent(e.hospital_key)}`}>{e.hospital_name}</a></h2>
        <p><strong>{e.kind === "newly_verified" ? "Newly verified by the audit" : "Published material changed"}</strong> · Detected {e.detected_at}</p>
        <p>{e.description}</p><p>Related checks: {e.measures.length ? e.measures.map((id) => <a className="change-measure" key={id} href={`?hospital=${e.hospital_key}#measure-${e.hospital_key}-${measures.get(id)?.css_column}`}>{measures.get(id)?.title ?? id}</a>) : "Impact requires review"}</p>
        {["added_links","removed_links"].map((key) => !!e[key]?.length && <details key={key}><summary>{key === "added_links" ? "Added" : "Removed"} links ({e[key].length})</summary>
          <ul>{e[key].map((url) => <li key={url}>{url}</li>)}</ul></details>)}
        <details><summary>Earlier and later evidence</summary>
          <Evidence label="Earlier" evidence={e.before}/><Evidence label="Later" evidence={e.after}/>
        </details></article>)}
    </>}
  </section>;
}
