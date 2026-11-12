// Saved 17-measure assessment (Phase 3) — port of the old app's
// GradingPanel.jsx, with English and Spanish chrome (the old panel was
// English-only). Loads only when the button is clicked; never polls.
// The 404 case keeps its own message, so this uses fetch directly instead
// of getJson (which does not expose the HTTP status).
import React, { useState } from "react";
import { useLocale } from "../../i18n/locale.jsx";

export default function GradingPanel({ hospitalKey }) {
  const { t } = useLocale();
  const [report, setReport] = useState(null);
  const [status, setStatus] = useState("");
  async function load() {
    setStatus(t("Loading saved assessment…"));
    try {
      const response = await fetch("/api/grading/hospitals/" + encodeURIComponent(hospitalKey));
      if (!response.ok) throw Error(response.status === 404 ? t("No saved assessment with available evidence.") : t("Saved assessment could not be verified."));
      setReport(await response.json());
      setStatus("");
    } catch (error) { setStatus(error.message); }
  }
  return <section aria-label={t("Saved compliance assessment")}>
    <button className="plain" onClick={load}>{t("Check for a saved 17-measure assessment")}</button>
    {status && <p role="status">{status}</p>}
    {report && <>
      <h3>{report.synthetic ? t("Synthetic draft assessment") : t("Draft assessment")}</h3>
      <p>{t("Assessment date")} {report.review_date} · {t("Guideline year")} {report.guideline_year}</p>
      <p>{t("Institutional grade pending")} · {t("Human review")} {report.human_review_status}</p>
      <p>{report.verified_errors} {t("verified errors")} · {report.unresolved_measures.length} {t("unresolved measures")}</p>
      <p>{report.calculated_grade ? t("Calculated grade") + " " + report.calculated_grade : t("Possible grades") + " " + report.possible_grades.join(", ")}</p>
      <details><summary>{t("Evidence and coverage")}</summary>
        {report.coverage_gaps.map((g) => <p key={g}>{g}</p>)}
        {report.findings.map((f) => <p key={f.measure_id}><strong>{f.css_column} · {f.result}</strong> {f.reason}</p>)}
        {report.reasons.map((r) => <p key={r}>{r}</p>)}
      </details>
    </>}
  </section>;
}
