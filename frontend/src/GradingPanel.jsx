import React, { useState } from "react";

export default function GradingPanel({ hospitalKey }) {
  const [report, setReport] = useState(null);
  const [status, setStatus] = useState("");
  async function load() {
    setStatus("Loading saved assessment…");
    try {
      const response = await fetch("/api/grading/hospitals/" + encodeURIComponent(hospitalKey));
      if (!response.ok) throw Error(response.status === 404 ? "No saved assessment with available evidence." : "Saved assessment could not be verified.");
      setReport(await response.json());
      setStatus("");
    } catch (error) { setStatus(error.message); }
  }
  return <section aria-label="Saved compliance assessment">
    <button className="plain" onClick={load}>View saved 17-measure assessment</button>
    {status && <p role="status">{status}</p>}
    {report && <>
      <h3>{report.synthetic ? "Synthetic draft assessment" : "Draft assessment"}</h3>
      <p>Assessment date {report.review_date} · Guideline year {report.guideline_year}</p>
      <p>Institutional grade pending · Human review {report.human_review_status}</p>
      <p>{report.verified_errors} verified errors · {report.unresolved_measures.length} unresolved measures</p>
      <p>{report.calculated_grade ? "Calculated grade " + report.calculated_grade : "Possible grades " + report.possible_grades.join(", ")}</p>
      <details><summary>Evidence and coverage</summary>
        {report.coverage_gaps.map((g) => <p key={g}>{g}</p>)}
        {report.findings.map((f) => <p key={f.measure_id}><strong>{f.css_column} · {f.result}</strong> {f.reason}</p>)}
        {report.reasons.map((r) => <p key={r}>{r}</p>)}
      </details>
    </>}
  </section>;
}
