import React, { useEffect, useState } from "react";
import HospitalMap from "../atlas/HospitalMap.jsx";
import { overview } from "../../api/overview.js";

const statuses = { current: "Current", overdue: "Overdue", never: "Never checked" };
const colors = { current: "#087652", overdue: "#b35b16", never: "#747b81" };
const grades = ["A","B","C","D","F"];
const impacts = {
  R: "Patients may have difficulty finding the application.", S: "Patients may lack a short explanation of their options.",
  T: "Patients may have difficulty checking the full policy.", U: "Patients may receive conflicting instructions.",
  V: "Where a patient lives may affect access to assistance.", W: "Patients may miss a chance to apply.",
  Y: "Patients may face an asset test when applying.", Z: "Immigration requirements may discourage applications.",
  AD: "Patients may encounter different forms or additional requirements.", AE: "Patients may have difficulty reaching someone for help.",
  AG: "Patients may have difficulty estimating their discount.", AH: "Outdated income amounts may mislead patients about eligibility.",
  AI: "Patients near the income limit may miss assistance.", AJ: "Patients may face unaffordable monthly payments.",
  AL: "Patients may have difficulty determining whether their community is covered.", AM: "Patients may have difficulty submitting an application.",
  AN: "Patients may have difficulty determining whether their income qualifies.",
};
const urlFor = (h, column) => `?hospital=${encodeURIComponent(h.hospital_key)}&revision=${encodeURIComponent(h.revision)}${column ? "#measure-"+h.hospital_key+"-"+column : ""}`;

export default function Overview({ features, counties }) {
  const [report, setReport] = useState(null);
  const [error, setError] = useState(false);
  const [request, setRequest] = useState(0);
  const [region, setRegion] = useState("");
  const [status, setStatus] = useState("");
  const [measure, setMeasure] = useState("");
  const [draft, setDraft] = useState("");
  const [bucket, setBucket] = useState("");
  const [map, setMap] = useState(false);
  useEffect(() => {
    const controller = new AbortController();
    setError(false);
    overview(controller.signal).then((data) => { if (!controller.signal.aborted) setReport(data); })
      .catch(() => { if (!controller.signal.aborted) setError(true); });
    return () => controller.abort();
  }, [request]);
  if (error) return <p role="alert">Could not load audit coverage. <button onClick={() => setRequest(request + 1)}>Retry</button></p>;
  if (!report) return <p role="status">Loading audit coverage…</p>;
  const areas = [{region:"", ...report.statewide}, ...report.regions];
  const area = areas.find((a) => a.region === region) || areas[0];
  const regional = report.hospitals.filter((h) => !region || h.region === region);
  const visible = regional.filter((h) => (!status || h.freshness === status) &&
    (!draft || h.finding_bucket === draft) &&
    (!measure || h.failed.some((m) => m.column === measure)) &&
    (!bucket || bucket === "historical-"+h.historical_grade || bucket === "current-"+h.grade_bucket));
  const byKey = new Map(visible.map((h) => [h.hospital_key, h]));
  const points = features.filter((f) => byKey.has(String(f.id))).map((f) => {
    const row = byKey.get(String(f.id));
    return {...f, markerLabel: statuses[row.freshness], markerColor: colors[row.freshness]};
  });
  const frequent = new Map();
  for (const hospital of regional) for (const m of hospital.failed) {
    const entry = frequent.get(m.column) || {...m, count:0};
    entry.count++;
    frequent.set(m.column,entry);
  }
  function select(r, s = "") { setRegion(r); setStatus(s); setMeasure(""); setBucket(""); setDraft(""); }
  const filterCount = (r, s, count) => <button className="plain" aria-label={`${r || "Statewide"} · ${statuses[s] || "All"} · ${count}`} onClick={() => select(r,s)}>{count}</button>;
  return <section className="overview" aria-labelledby="overview-title">
    <a href="?">← Hospital atlas</a>
    <div className="overview-heading"><h1 id="overview-title">Audit overview</h1><button onClick={() => setRequest(request + 1)}>Refresh overview</button></div>
    <p>{report.guideline_year} audit · {report.statewide.total} hospitals · As of {new Date(report.as_of).toLocaleDateString()}</p>
    <p>Current means at least one measure was successfully checked within the last {report.window_days} days. Each finding has its own date and scope.</p>
    {!!report.unavailable_records && <p role="alert">{report.unavailable_records} review records could not be read. Coverage may be incomplete.</p>}
    <h2>Coverage by region</h2>
    <div className="overview-scroll"><table><thead><tr><th>Economic region</th><th>Hospitals</th>{Object.values(statuses).map((label) => <th key={label}>{label}</th>)}</tr></thead>
      <tbody>{areas.map((a) => <tr key={a.region}><th scope="row">{a.region || "Statewide"}</th><td>{filterCount(a.region,"",a.total)}</td>
        {Object.keys(statuses).map((s) => <td key={s}>{filterCount(a.region,s,a.freshness[s])}</td>)}</tr>)}</tbody></table></div>
    <h2>{region || "Statewide"} findings</h2>
    <p>Hospitals with a draft “No” in any reviewed scope. Each hospital counts once per measure.</p>
    {[...frequent.values()].sort((a,b) => b.count-a.count || a.column.localeCompare(b.column)).map((m) => <p key={m.column}>
      <button className="plain" onClick={() => {setMeasure(m.column);setStatus("");setBucket("");setDraft("");}}>{m.column} · {m.title} ({m.count})</button> — {impacts[m.column]}</p>)}
    {!frequent.size && <p>No draft failures recorded in this region.</p>}
    <h2>Hospital directory</h2>
    <div className="overview-controls">
      <label>Region<select value={region} onChange={(e) => select(e.target.value)}>{areas.map((a) => <option key={a.region} value={a.region}>{a.region || "Statewide"}</option>)}</select></label>
      <label>Check status<select value={status} onChange={(e) => setStatus(e.target.value)}><option value="">All</option>{Object.entries(statuses).map(([s,label]) => <option key={s} value={s}>{label}</option>)}</select></label>
      <label>Draft findings<select value={draft} onChange={(e) => {setDraft(e.target.value);setMeasure("");}}>
        <option value="">All</option><option value="flagged">Has a No finding ({area.findings.flagged})</option>
        <option value="no_recorded_failure">Checked, no recorded No ({area.findings.no_recorded_failure})</option>
        <option value="unassessed">Unassessed ({area.findings.unassessed})</option></select></label>
      <label>Grade bucket<select value={bucket} onChange={(e) => setBucket(e.target.value)}><option value="">All grades</option>
        <optgroup label="September 2025 published">{grades.map((g) => <option key={g} value={"historical-"+g}>2025 · {g} ({area.historical[g]})</option>)}</optgroup>
        <optgroup label="Current institutional">{Object.entries(area.current_grades).map(([g,n]) => <option key={g} value={"current-"+g}>Current · {g} ({n})</option>)}</optgroup></select></label>
      <button onClick={() => select("")}>Clear filters</button><button aria-pressed={map} onClick={() => setMap(!map)}>{map ? "Hide coverage map" : "Show coverage map"}</button>
    </div>
    <p aria-live="polite">{visible.length} of {area.total} hospitals{measure && ` · ${measure} draft No`}</p>
    {map && <><p>Green · Current　 Orange · Overdue　 Grey · Never checked</p><HospitalMap hospitals={points} counties={counties} onSelect={(f) => window.location.assign(urlFor(byKey.get(String(f.id)),measure))} /></>}
    <div className="overview-scroll"><table aria-label="Hospital directory"><thead><tr><th>Hospital</th><th>September 2025 grade</th><th>Current institutional grade</th><th>Check status</th><th>Last successful check (UTC)</th></tr></thead>
      <tbody>{visible.map((h) => <tr key={h.hospital_key}><th scope="row"><a href={urlFor(h,measure)}>{h.name}</a></th><td>{h.historical_grade}</td>
        <td>{h.current_grade ?? (h.last_successful_assessment_at ? "Pending" : "Unassessed")}</td><td>{statuses[h.freshness]}</td>
        <td>{h.last_successful_assessment_at ? new Date(h.last_successful_assessment_at).toISOString().slice(0,10) : "—"}</td></tr>)}</tbody></table></div>
  </section>;
}
