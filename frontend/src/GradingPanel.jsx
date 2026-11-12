import React, { useState } from "react";
import {CriterionCoverage} from './CriterionCoverage.jsx';
import {useLocale} from './locale.jsx';

export default function GradingPanel({ hospitalKey }) {
  const {t,language}=useLocale();
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
  return <section aria-label={t('Saved compliance assessment')} lang={language}>
    <button className="plain" onClick={load}>{t('Check for a saved 17-measure assessment')}</button>
    {status && <p role="status">{t(status)}</p>}
    {report && <>
      <h3>{t(report.synthetic ? 'Synthetic draft assessment' : 'Draft assessment')}</h3>
      <p>{t('Assessment date')}: {report.review_date} · {t('Guideline year')}: {report.guideline_year}</p>
      <p>{t('Hospital grade is awaiting review.')}</p>
      <p>{t('Review status')}: {t({complete:'Review complete',partial:'Some results reviewed',pending:'Awaiting review'}[report.human_review_status] ?? 'Awaiting review')}</p>
      <CriterionCoverage hospitalKey={hospitalKey} />
      <p>{report.verified_errors} {t('confirmed problems')} · {report.unresolved_measures.length} {t('requirements needing review')}</p>
      <p>{report.calculated_grade ? t('Calculated grade') + ' ' + report.calculated_grade : t('Possible grades') + ' ' + report.possible_grades.join(', ')}</p>
      <details><summary>{t('Supporting information and missing details')}</summary>
        {language==='es' && <p>{t('Detailed explanations below are in English.')}</p>}
        <div lang="en">
        {report.coverage_gaps.map((g) => <p key={g}>{g}</p>)}
        {report.findings.map((f) => <p key={f.measure_id}><strong>{f.css_column} · {f.result}</strong> {f.reason}</p>)}
        {report.reasons.map((r) => <p key={r}>{r}</p>)}
        </div>
      </details>
    </>}
  </section>;
}
