// FPL audit panel for hospital 362 (Phase 3) — port of the old app's
// AuditPanel.jsx, with English and Spanish chrome (the old panel was
// English-only). Polls the status every 1500 ms like the old panel did;
// the recheck POST carries X-Audit-Request: 1 and no body.
import React, { useState, useEffect } from "react";
import { useLocale } from "../../i18n/locale.jsx";
import { auditRequest, getJson } from "../../api/client.js";

const endpoint = "/api/audits/362";
export default function AuditPanel() {
  const { t } = useLocale();
  const [state, setState] = useState(null),
    [year, setYear] = useState("2026"),
    [error, setError] = useState("");
  useEffect(() => {
    let active = true,
      timer;
    async function refresh() {
      try {
        const data = await getJson(endpoint);
        if (active) setState(data);
      } catch {
        if (active) setError(t("Could not load audit status."));
      }
      if (active) timer = setTimeout(refresh, 1500);
    }
    refresh();
    return () => {
      active = false;
      clearTimeout(timer);
    };
  }, []);
  async function queue() {
    try {
      await auditRequest(endpoint + "/" + year);
      setError("");
      setState((old) => ({ ...old, job: { status: "queued" } }));
    } catch {
      setError(t("Could not queue the recheck."));
    }
  }
  const output = state?.latest,
    finding = output?.assessment.findings[0];
  const citation = finding?.evidence[0];
  const snapshot = output?.snapshots.find(
    (s) => s.snapshot_id === citation?.snapshot_id,
  );
  return (
    <section aria-label={t("Synthetic FPL audit")}>
      <h3>{t("FPL audit · synthetic demonstration")}</h3>
      <label>
        {t("Guideline year")}{" "}
        <select value={year} onChange={(e) => setYear(e.target.value)}>
          <option>2025</option>
          <option>2026</option>
        </select>
      </label>
      <button onClick={queue}>{t("Recheck application")}</button>
      <p role="status">{error || state?.job?.error || state?.job?.status}</p>
      {finding && (
        <>
          <p>{t("Last completed check:")} {output.last_successful_assessment_at}</p>
          <p>
            {output.reference_version} · {finding.result}
          </p>
          <p>{finding.explanation}</p>
          {snapshot && (
            <details>
              <summary>{t("Source evidence")}</summary>
              <blockquote>{citation.quote}</blockquote>
              <p>
                {citation.locator} · SHA-256{" "}
                <code style={{ overflowWrap: "anywhere" }}>
                  {snapshot.sha256}
                </code>
              </p>
              <a href={"/api/audits/snapshots/" + snapshot.sha256}>
                {t("Open saved PDF")}
              </a>
            </details>
          )}
        </>
      )}
    </section>
  );
}
