import React, { useEffect, useState } from "react";

export default function PilotAudit({ hospitalKey }) {
  const [data, setData] = useState(null), [message, setMessage] = useState("");
  const [mode, setMode] = useState("replay"), [variant, setVariant] = useState("original");
  async function refresh() {
    try {
      const r = await fetch(`/api/pilot/hospitals/${hospitalKey}`);
      if (!r.ok) throw Error();
      setData(await r.json()); setMessage("");
    } catch { setMessage("Audit status unavailable. Saved findings remain unchanged."); }
  }
  useEffect(() => { refresh(); }, [hospitalKey]);
  if (!["1002", "362"].includes(String(hospitalKey))) return null;
  async function queue() {
    setMessage("Queuing audit…");
    try {
      const r = await fetch(`/api/pilot/hospitals/${hospitalKey}`, { method: "POST", headers: { "Content-Type": "application/json", "X-Review-Request": "1" },
        body: JSON.stringify({ year: 2026, review_date: new Date().toISOString().slice(0, 10), mode, variant, request_key: crypto.randomUUID() }) });
      if (!r.ok) throw Error();
      await refresh();
    } catch { setMessage("Could not queue audit. Synthetic runs require the isolated demo server; check the worker setup."); }
  }
  return <section aria-label="Integrated audit job">
    <h3>Run a 17-measure audit</h3>
    <p>Jobs run in the persistent worker after you close this page. A completed job can still have evidence and approval blockers.</p>
    <label>Evidence mode <select value={mode} onChange={(e) => setMode(e.target.value)}>
      <option value="replay">Reverify saved public evidence</option><option value="live">Collect current public documents</option>
      {String(hospitalKey) === "1002" && <option value="synthetic">Synthetic offline demo (isolated server only)</option>}
    </select></label>
    {mode === "synthetic" && <label> Synthetic source version <select value={variant} onChange={(e) => setVariant(e.target.value)}>
      <option value="original">Original outdated table</option><option value="corrected">Corrected table</option><option value="multilingual">Partial multilingual fixture</option>
    </select></label>}
    <button onClick={queue}>Queue 17-measure audit</button> <button onClick={refresh}>Refresh job status</button>
    {message && <p role="status">{message}</p>}
    {data?.job && <p>Job {data.job.id}: <strong>{data.job.status}</strong> · attempts {data.job.attempts}{data.job.error && ` · ${data.job.error}`}</p>}
    {data?.latest && <p>Last committed revision: <a href={`/api/pilot/assessments/${data.latest}`}>{data.latest.slice(0, 12)}</a>. <a href={`?hospital=${hospitalKey}`}>Reload findings from this assessment</a></p>}
  </section>;
}
