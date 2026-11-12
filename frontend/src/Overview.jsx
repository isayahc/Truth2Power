import React, { useEffect, useState } from "react";
import HospitalMap from "./HospitalMap.jsx";
import {useLocale} from './locale.jsx';

const statuses = { current: "Current", overdue: "Overdue", never: "Never checked" };
const colors = { current: "#087652", overdue: "#b35b16", never: "#747b81" };
import {CriterionCoverage} from './CriterionCoverage.jsx';
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
  const {t,language,localHref}=useLocale();
  const [tab,setTab]=useState('coverage');
  const [page,setPage]=useState(0);
  const [report, setReport] = useState(null);
  const [error, setError] = useState(false);
  const [request, setRequest] = useState(0);
  const [region, setRegion] = useState("");
  const [status, setStatus] = useState("");
  const [measure, setMeasure] = useState("");
  const [draft, setDraft] = useState("");
  const [bucket, setBucket] = useState("");
  const [map, setMap] = useState(false);
  useEffect(()=>setPage(0),[region,status,measure,draft,bucket]);
  useEffect(() => {
    const controller = new AbortController();
    setError(false);
    fetch("/api/overview", { signal: controller.signal }).then(async (r) => {
      if (!r.ok) throw Error();
      return r.json();
    }).then((data) => { if (!controller.signal.aborted) setReport(data); })
      .catch(() => { if (!controller.signal.aborted) setError(true); });
    return () => controller.abort();
  }, [request]);
  if (error) return <p role="alert">{t('Could not load the hospital overview.')} <button onClick={() => setRequest(request + 1)}>{t('Try again')}</button></p>;
  if (!report) return <p role="status">{t('Loading hospital overview…')}</p>;
  const areas = [{region:"", ...report.statewide}, ...report.regions];
  const area = areas.find((a) => a.region === region) || areas[0];
  const regional = report.hospitals.filter((h) => !region || h.region === region);
  const visible = regional.filter((h) => (!status || h.freshness === status) &&
    (!draft || h.finding_bucket === draft) &&
    (!measure || h.failed.some((m) => m.column === measure)) &&
    (!bucket || bucket === "historical-"+h.historical_grade || bucket === "current-"+h.grade_bucket));
  const byKey = new Map(visible.map((h) => [h.hospital_key, h]));
  const pages=Math.max(1,Math.ceil(visible.length/10));
  const currentPage=Math.min(page,pages-1);
  const start=currentPage*10;
  const pageRows=visible.slice(start,start+10);
  const points = features.filter((f) => byKey.has(String(f.id))).map((f) => {
    const row = byKey.get(String(f.id));
    return {...f, markerLabel: t(statuses[row.freshness]), markerColor: colors[row.freshness]};
  });
  const frequent = new Map();
  for (const hospital of regional) for (const m of hospital.failed) {
    const entry = frequent.get(m.column) || {...m, count:0};
    entry.count++;
    frequent.set(m.column,entry);
  }
  function select(r, s = "") { setRegion(r); setStatus(s); setMeasure(""); setBucket(""); setDraft(""); }
  const filterCount = (r, s, count) => <button className="plain" aria-label={`${r || t('Statewide')} · ${t(statuses[s] || 'All')} · ${count}`} onClick={() => select(r,s)}>{count}</button>;
  return <section className="overview" aria-labelledby="overview-title" lang={language}>
    <a href={localHref('?')}>{t('← Back to hospital map')}</a>
    <div className="overview-heading"><h1 id="overview-title">{t('Audit overview')}</h1><button onClick={() => setRequest(request + 1)}>{t('Refresh overview')}</button></div>
    <p>{report.guideline_year} · {report.statewide.total} {t('hospitals')} · {t('Last updated')}: {new Date(report.as_of).toLocaleDateString(language)}</p>
    <p>{t('Recently checked means at least one requirement was checked in the past')} {report.window_days} {t('days. It does not mean every requirement was met.')}</p>
    {!!report.unavailable_records && <p role="alert">{report.unavailable_records} · {t('Some saved reviews could not be read. The overview may be incomplete.')}</p>}
    <div className="overview-tabs" role="tablist" aria-label={t('Overview sections')} lang={language}>
      {['coverage','findings'].map((id,index)=><button key={id} id={`overview-tab-${id}`} role="tab" aria-selected={tab===id} aria-controls={`overview-panel-${id}`} tabIndex={tab===id?0:-1}
        onClick={()=>setTab(id)} onKeyDown={event=>{
          if(!['ArrowLeft','ArrowRight','Home','End'].includes(event.key))return;
          event.preventDefault();
          const next=event.key==='Home'?'coverage':event.key==='End'?'findings':['coverage','findings'][1-index];
          setTab(next);document.getElementById(`overview-tab-${next}`)?.focus();
        }}>{t(id==='coverage'?'Coverage by region':'Findings')}</button>)}
    </div>
    <section id="overview-panel-coverage" role="tabpanel" aria-labelledby="overview-tab-coverage" hidden={tab!=='coverage'} tabIndex={0}>
    <h2 lang={language}>{t('Coverage by region')}</h2>
    <div className="overview-scroll"><table><thead><tr><th>{t('Region')}</th><th>{t('Hospitals')}</th>{Object.values(statuses).map((label) => <th key={label}>{t(label)}</th>)}</tr></thead>
      <tbody>{areas.map((a) => <tr key={a.region}><th scope="row">{a.region || t('Statewide')}</th><td>{filterCount(a.region,"",a.total)}</td>
        {Object.keys(statuses).map((s) => <td key={s}>{filterCount(a.region,s,a.freshness[s])}</td>)}</tr>)}</tbody></table></div>
    </section>
    <section id="overview-panel-findings" role="tabpanel" aria-labelledby="overview-tab-findings" hidden={tab!=='findings'} tabIndex={0}>
    <h2 lang={language}>{region || t('Statewide')} · {t('Findings')}</h2>
    <p>{t('Requirements marked not met in the saved reviews. A hospital is counted once for each requirement, even if several documents were checked.')}</p>
    {[...frequent.values()].sort((a,b) => b.count-a.count || a.column.localeCompare(b.column)).map((m) => <p key={m.column}>
      <button className="plain" onClick={() => {setMeasure(m.column);setStatus("");setBucket("");setDraft("");}}>{m.column} · {t(m.title)} ({m.count})</button> — {t(impacts[m.column])}</p>)}
    {!frequent.size && <p>{t('No requirements are marked not met in this region.')}</p>}
    </section>
    <h2 lang={language}>{t('Hospital directory')}</h2>
    <div className="overview-controls">
      <label>{t('Region')}<select value={region} onChange={(e) => select(e.target.value)}>{areas.map((a) => <option key={a.region} value={a.region}>{a.region || t('Statewide')}</option>)}</select></label>
      <label>{t('Check status')}<select value={status} onChange={(e) => setStatus(e.target.value)}><option value="">{t('All')}</option>{Object.entries(statuses).map(([s,label]) => <option key={s} value={s}>{t(label)}</option>)}</select></label>
      <label>{t('Draft findings')}<select value={draft} onChange={(e) => {setDraft(e.target.value);setMeasure("");}}>
        <option value="">{t('All')}</option><option value="flagged">{t('Has a requirement marked not met')} ({area.findings.flagged})</option>
        <option value="no_recorded_failure">{t('Checked; none marked not met')} ({area.findings.no_recorded_failure})</option>
        <option value="unassessed">{t('Unassessed')} ({area.findings.unassessed})</option></select></label>
      <label>{t('Grade')}<select value={bucket} onChange={(e) => setBucket(e.target.value)}><option value="">{t('All grades')}</option>
        <optgroup label={t('September 2025 published')}>{grades.map((g) => <option key={g} value={"historical-"+g}>2025 · {g} ({area.historical[g]})</option>)}</optgroup>
        <optgroup label={t('Current institutional')}>{Object.entries(area.current_grades).map(([g,n]) => <option key={g} value={"current-"+g}>{t(g)} ({n})</option>)}</optgroup></select></label>
      <button onClick={() => select("")}>{t('Clear filters')}</button><button aria-pressed={map} onClick={() => setMap(!map)}>{t(map ? 'Hide coverage map' : 'Show coverage map')}</button>
    </div>
    <p aria-live="polite">{visible.length} {t('of')} {area.total} {t('hospitals')}{measure && ` · ${measure} · ${t('Condition not met')}`}</p>
    {map && <><p>{t('Green: recently checked. Orange: check overdue. Gray: never checked.')}</p><HospitalMap hospitals={points} counties={counties} onSelect={(f) => window.location.assign(localHref(urlFor(byKey.get(String(f.id)),measure)))} /></>}
    <div className="overview-scroll"><table aria-label={t('Hospital directory')}><thead><tr>{['Hospital','September 2025 grade','Current institutional grade','Check status','Last successful check (UTC)'].map(label=><th key={label}>{t(label)}</th>)}</tr></thead>
       <tbody>{pageRows.map((h) => <tr key={h.hospital_key}><th scope="row"><a href={localHref(urlFor(h,measure))}>{h.name}</a></th><td>{h.historical_grade}</td>
        <td>{h.current_grade ?? t(h.last_successful_assessment_at ? 'Pending' : 'Unassessed')}<CriterionCoverage hospitalKey={h.hospital_key} historical /></td><td>{t(statuses[h.freshness])}</td>
        <td>{h.last_successful_assessment_at ? new Date(h.last_successful_assessment_at).toISOString().slice(0,10) : "—"}</td></tr>)}</tbody></table></div>
    <nav className="overview-pagination" aria-label={t('Hospital directory pages')} lang={language}>
      <p role="status">{t('Showing')} {visible.length?start+1:0}–{Math.min(start+10,visible.length)} {t('of')} {visible.length} · {t('Page')} {currentPage+1} {t('of')} {pages}</p>
      <button disabled={currentPage===0} onClick={()=>setPage(currentPage-1)}>{t('Previous page')}</button>
      <button disabled={currentPage===pages-1} onClick={()=>setPage(currentPage+1)}>{t('Next page')}</button>
    </nav>
   </section>;
}
