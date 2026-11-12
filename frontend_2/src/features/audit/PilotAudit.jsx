// Pilot 17-measure audit (Phase 3) — port of the old app's PilotAudit.jsx,
// with English and Spanish chrome (the old panel was English-only).
// Renders nothing unless this is hospital 1002 and the demo is enabled.
import React, { useEffect, useState } from "react";
import { useLocale } from "../../i18n/locale.jsx";
import { getJson, reviewRequest } from "../../api/client.js";

export default function PilotAudit({ hospitalKey }) {
  const { t } = useLocale();
  const [data, setData] = useState(null), [message, setMessage] = useState("");
  const [mode, setMode] = useState("synthetic"), [variant, setVariant] = useState("original");
  async function refresh() {
    try {
      setData(await getJson(`/api/pilot/hospitals/${hospitalKey}`)); setMessage("");
    } catch { setMessage(t("Audit status unavailable. Saved findings remain unchanged.")); }
  }
  useEffect(() => { refresh(); }, [hospitalKey]);
  async function queue() {
    setMessage(t("Queuing audit…"));
    try {
      await reviewRequest(`/api/pilot/hospitals/${hospitalKey}`,
        { year: 2026, review_date: new Date().toISOString().slice(0, 10), mode, variant, request_key: crypto.randomUUID() });
      await refresh();
    } catch { setMessage(t("Could not queue audit. Synthetic runs require the isolated demo server; check the worker setup.")); }
  }
  if (String(hospitalKey) !== "1002" || !data?.demo_enabled) return null;
  return <section aria-label={t("Integrated audit job")}>
    <h3>{t("Run a 17-measure audit")}</h3>
    <p>{t("Jobs run in the persistent worker after you close this page. A completed job can still have evidence and approval blockers.")}</p>
    <label>{t("Evidence mode")} <select value={mode} onChange={(e) => setMode(e.target.value)}>
      {String(hospitalKey) === "1002" && <option value="synthetic">{t("Synthetic offline demo (isolated server only)")}</option>}
    </select></label>
    {mode === "synthetic" && <label> {t("Synthetic source version")} <select value={variant} onChange={(e) => setVariant(e.target.value)}>
      <option value="original">{t("Original outdated table")}</option><option value="corrected">{t("Corrected table")}</option><option value="multilingual">{t("Partial multilingual fixture")}</option>
    </select></label>}
    <button onClick={queue}>{t("Queue 17-measure audit")}</button> <button onClick={refresh}>{t("Refresh job status")}</button>
    {message && <p role="status">{message}</p>}
    {data?.job && <p>{t("Job")} {data.job.id}: <strong>{data.job.status}</strong> · {t("Attempts")} {data.job.attempts}{data.job.error && ` · ${data.job.error}`}</p>}
    {data?.latest && <p>{t("Last committed revision:")} <a href={`/api/pilot/assessments/${data.latest}`}>{data.latest.slice(0, 12)}</a>. <a href={`?hospital=${hospitalKey}`}>{t("Reload findings from this assessment")}</a></p>}
  </section>;
}
