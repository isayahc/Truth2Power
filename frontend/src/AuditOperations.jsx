import React, { useEffect, useRef, useState } from "react";
import { useLocale } from "./locale.jsx";

const api = "/api/pilot/v1";
const modes = {
  discovery_only: "Scan documents",
  full_audit: "Full audit",
  replay: "Replay saved evidence",
  live: "Full audit",
};
const statusNames = {
  queued: "Queued",
  running: "Running",
  retrying: "Retrying",
  partial: "Partial",
  failed: "Failed",
  completed: "Completed",
  cancelled: "Cancelled",
  unknown: "Unknown",
  complete: "Complete",
  started: "Started",
  stage: "Stage",
  interrupted: "Interrupted",
};
const stageNames = {
  prepare: "Preparation",
  load_saved_evidence: "Load saved evidence",
  collect_sources: "Collect sources",
  collection_saved: "Collection saved",
  extract_documents: "Extract documents",
  restore_checkpoint: "Restore checkpoint",
  grade: "Evaluate findings",
  publish: "Publish results",
  external: "External service",
};
const clockLabels = {
  last_attempted: "Last attempt",
  last_completed_execution: "Last completed execution",
  last_successful_source_retrieval: "Last source fetch",
  last_eligible_assessment: "Last eligible assessment",
  next_due_at: "Next due",
};
const unitNames = {
  elapsed_ms: "Worker time",
  network_bytes: "Downloaded bytes",
  storage_bytes: "Storage growth",
  input_tokens: "Input tokens",
  cached_input_tokens: "Cached input tokens",
  output_tokens: "Output tokens",
};
const active = (s) => ["running", "queued", "retrying"].includes(s);
const date = (v, lang, t) =>
  v
    ? new Date(v).toLocaleString(lang, {
        dateStyle: "medium",
        timeStyle: "short",
      })
    : t("Not recorded");
const money = (n, lang, t, currency = "USD") =>
  n == null
    ? t("Unknown")
    : new Intl.NumberFormat(lang, {
        style: "currency",
        currency,
        maximumFractionDigits: 8,
      }).format(n);

function useJson(url, refresh = 0) {
  const [result, set] = useState({});
  useEffect(() => {
    if (!url) return;
    const controller = new AbortController();
    fetch(url, { signal: controller.signal })
      .then((r) => {
        if (!r.ok) throw Error();
        return r.json();
      })
      .then((data) => {
        if (!controller.signal.aborted) set({ url, data });
      })
      .catch(() => {
        if (!controller.signal.aborted) set({ url, error: true });
      });
    return () => controller.abort();
  }, [url, refresh]);
  return result.url === url ? result : {};
}
function Notice({ resource, retry }) {
  const { t } = useLocale();
  return resource.error ? (
    <p role="alert">
      {t("Unable to load audit records.")}{" "}
      <button onClick={retry}>{t("Try again")}</button>
    </p>
  ) : !resource.data ? (
    <p role="status">{t("Loading audit records…")}</p>
  ) : null;
}
function Paged({ url, field = "items", refresh, children }) {
  const { t } = useLocale(),
    [pages, setPages] = useState([""]),
    [tick, bump] = useState(0);
  const cursor = pages.at(-1);
  const r = useJson(
    url + "?limit=20" + (cursor ? "&cursor=" + cursor : ""),
    refresh + tick,
  );
  return (
    <>
      <Notice resource={r} retry={() => bump((n) => n + 1)} />
      {r.data && (
        <>
          {children(r.data[field], r.data)}
          {pages.length > 1 && (
            <button onClick={() => setPages((p) => p.slice(0, -1))}>
              {t("Previous page")}
            </button>
          )}
          {r.data.next_cursor && (
            <button onClick={() => setPages((p) => [...p, r.data.next_cursor])}>
              {t("Next page")}
            </button>
          )}
        </>
      )}
    </>
  );
}
export function AuditOperations() {
  const { t, language, localHref } = useLocale(),
    [tick, bump] = useState(0),
    [query, search] = useState(""),
    [sort, setSort] = useState("name"),
    [offset, setOffset] = useState(0);
  const r = useJson(api + "/operations", tick),
    totals = useJson(api + "/summary", tick);
  const rows = (r.data?.items ?? []).filter((h) =>
    (h.name + " " + h.hospital_key + " " + h.region)
      .toLowerCase()
      .includes(query.trim().toLowerCase()),
  );
  rows.sort((a, b) => {
    if (sort === "name") return a.name.localeCompare(b.name, language);
    if (sort === "status")
      return (
        (a.latest?.status ?? "").localeCompare(b.latest?.status ?? "") ||
        a.name.localeCompare(b.name)
      );
    return (
      (b.clocks[sort] ?? "").localeCompare(a.clocks[sort] ?? "") ||
      a.name.localeCompare(b.name)
    );
  });
  return (
    <section className="ops">
      <a href={localHref("?")}>{t("← Back to hospital map")}</a>
      <h1>{t("Audit operations")}</h1>
      <Notice resource={totals} retry={() => bump((n) => n + 1)} />
      {totals.data && (
        <dl className="ops-totals">
          {Object.entries({
            runs: "Recorded runs",
            known_billed_usd: "Known billed",
            estimated_local_usd: "Local estimate",
            calculated_provider_usd: "Provider estimate",
            incomplete_receipts: "Incomplete receipts",
          }).map(([k, label]) => (
            <div key={k}>
              <dt>{t(label)}</dt>
              <dd>
                {k.endsWith("_usd")
                  ? money(totals.data[k], language, t)
                  : totals.data[k]}
              </dd>
            </div>
          ))}
        </dl>
      )}
      <div className="ops-controls">
        <label>
          {t("Find a hospital")}{" "}
          <input
            type="search"
            value={query}
            onChange={(e) => {
              search(e.target.value);
              setOffset(0);
            }}
          />
        </label>
        <label>
          {t("Sort by")}{" "}
          <select
            value={sort}
            onChange={(e) => {
              setSort(e.target.value);
              setOffset(0);
            }}
          >
            {Object.entries({
              name: "Hospital",
              status: "Run status",
              ...clockLabels,
            }).map(([k, v]) => (
              <option key={k} value={k}>
                {t(v)}
              </option>
            ))}
          </select>
        </label>
        <button onClick={() => bump((n) => n + 1)}>{t("Refresh")}</button>
      </div>
      <Notice resource={r} retry={() => bump((n) => n + 1)} />
      {r.data && (
        <>
          <p role="status">
            {rows.length} / {r.data.items.length} {t("hospitals")}
          </p>
          <div
            className="ops-scroll"
            tabIndex={0}
            role="region"
            aria-label={t("Hospital run records")}
          >
            <table>
              <thead>
                <tr>
                  {[
                    "Hospital",
                    "Run status",
                    "Last attempt",
                    "Last source fetch",
                    "Last eligible assessment",
                    "Next due",
                    "Unresolved measures",
                    "Coverage gaps",
                    "Cost availability",
                  ].map((l) => (
                    <th key={l} scope="col">
                      {t(l)}
                    </th>
                  ))}
                </tr>
              </thead>
              <tbody>
                {rows.slice(offset, offset + 20).map((h) => (
                  <tr key={h.hospital_key}>
                    <th scope="row">
                      <a
                        href={localHref(
                          "?hospital=" + h.hospital_key + "#audit-runs",
                        )}
                      >
                        {h.name}
                      </a>
                    </th>
                    <td>
                      {t(statusNames[h.latest?.status] ?? "Not recorded")}
                    </td>
                    {[
                      "last_attempted",
                      "last_successful_source_retrieval",
                      "last_eligible_assessment",
                      "next_due_at",
                    ].map((k) => (
                      <td key={k}>
                        {date(h.clocks[k], language, t)}{" "}
                        {k === "next_due_at" &&
                          h.clocks[k] &&
                          Date.parse(h.clocks[k]) < Date.now() &&
                          t("Overdue")}
                      </td>
                    ))}
                    <td>{h.latest?.unresolved_measures ?? t("Unknown")}</td>
                    <td>{h.latest?.coverage_gaps ?? t("Unknown")}</td>
                    <td>{t(statusNames[h.cost_status])}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          <div className="ops-controls">
            <button disabled={!offset} onClick={() => setOffset(offset - 20)}>
              {t("Previous page")}
            </button>
            <button
              disabled={offset + 20 >= rows.length}
              onClick={() => setOffset(offset + 20)}
            >
              {t("Next page")}
            </button>
          </div>
        </>
      )}
    </section>
  );
}
function Receipt({ run, refresh }) {
  const { t, language } = useLocale(),
    [tick, bump] = useState(0),
    r = useJson(run.receipt, refresh + tick),
    c = r.data;
  return (
    <section>
      <h4>{t("Cost receipt")}</h4>
      <Notice resource={r} retry={() => bump((n) => n + 1)} />
      {c && (
        <>
          <dl>
            {Object.entries({
              known_billed_usd: "Known billed",
              calculated_provider_usd: "Provider estimate",
              estimated_local_usd: "Local estimate",
            }).map(([k, l]) => (
              <React.Fragment key={k}>
                <dt>{t(l)}</dt>
                <dd>{money(c[k], language, t)}</dd>
              </React.Fragment>
            ))}
            <dt>{t("Checkpoint reuses")}</dt>
            <dd>
              {c.units.checkpoint_hits ??
                (c.units.elapsed_ms != null ? 0 : t("Unknown"))}
            </dd>
            <dt>{t("Downloaded bytes")}</dt>
            <dd>{c.units.network_bytes ?? t("Unknown")}</dd>
            <dt>{t("Parsed documents (PDF and DOCX)")}</dt>
            <dd>
              {c.units.pdf_parsed == null || c.units.docx_parsed == null
                ? t("Unknown")
                : c.units.pdf_parsed + c.units.docx_parsed}
            </dd>
          </dl>
          {c.zero_incremental_api && <p>{t("No incremental model charge.")}</p>}
          {!c.complete && (
            <p>
              {t("Cost receipt incomplete.")}{" "}
              {c.unpriced_units.length > 0 && (
                <>
                  {t("Unpriced usage")} ·{" "}
                  {c.unpriced_units
                    .map((u) => t(unitNames[u] ?? "Other usage"))
                    .join(", ")}
                </>
              )}
            </p>
          )}
          <details>
            <summary>{t("Costs by stage")}</summary>
            {Object.entries(c.stage_costs ?? {}).map(([stage, s]) => (
              <p key={stage}>
                <strong>{t(stageNames[stage] ?? "Stage")}</strong>
                <br />
                {t("Known billed")} ·{" "}
                {Object.entries(s.billed_by_currency)
                  .map(([code, n]) => money(n, language, t, code))
                  .join(", ") || t("Not recorded")}
                <br />
                {t("Provider estimate")} ·{" "}
                {money(s.calculated_provider_usd, language, t)}
                <br />
                {t("Local estimate")} ·{" "}
                {money(s.estimated_local_usd, language, t)}
              </p>
            ))}
          </details>
          <a href={run.receipt + ".csv"} download>
            {t("Download CSV receipt")}
          </a>
        </>
      )}
    </section>
  );
}
function RunDetail({ path, refresh }) {
  const { t, language } = useLocale(),
    [tick, bump] = useState(0),
    r = useJson(path, refresh + tick),
    run = r.data;
  return (
    <>
      <Notice resource={r} retry={() => bump((n) => n + 1)} />
      {run && (
        <section className="run-record">
          <h3>{run.audit_run_id}</h3>
          <p>
            {t(modes[run.mode])} · <strong>{t(statusNames[run.status])}</strong>{" "}
            · {t("Attempts")} {run.attempts}
          </p>
          <h4>{t("Timeline")}</h4>
          <Paged url={run.timeline} refresh={refresh + tick}>
            {(events) => (
              <ol>
                {events.map((e) => (
                  <li key={e.seq}>
                    <time>{date(e.at, language, t)}</time> ·{" "}
                    {t(stageNames[e.stage] ?? statusNames[e.state] ?? "Stage")}{" "}
                    {e.attempt_id && (
                      <small>
                        ({t("Attempt")}{" "}
                        {run.attempt_history.findIndex(
                          (a) => a.attempt_id === e.attempt_id,
                        ) + 1}
                        )
                      </small>
                    )}
                    {e.reason && (
                      <>
                        {" "}
                        ·{" "}
                        {t(
                          {
                            audit_failed: "Audit failed",
                            lease_expired: "Worker lease expired",
                            retry_scheduled: "Retry scheduled",
                            operator_cancelled: "Cancelled by operator",
                          }[e.reason],
                        )}
                      </>
                    )}
                  </li>
                ))}
              </ol>
            )}
          </Paged>
          {run.revision && (
            <>
              <h4>{t("Saved evidence")}</h4>
              <p>
                {t("Coverage gaps")} · {run.coverage_gaps ?? t("Unknown")}
                <br />
                {t("Unresolved measures")} ·{" "}
                {run.unresolved_measures ?? t("Not recorded")}
              </p>
              <Paged field="sources" url={run.revision} refresh={refresh}>
                {(sources, data) => (
                  <>
                    {data.findings && (
                      <details>
                        <summary>{t("Draft findings")}</summary>
                        <ul>
                          {data.findings.map((f) => (
                            <li key={f.measure_id}>
                              <code>{f.measure_id}</code> ·{" "}
                              {t(
                                {
                                  yes: "Yes",
                                  no: "No",
                                  unclear: "Unclear",
                                  n_a: "Not applicable",
                                }[f.result],
                              )}
                            </li>
                          ))}
                        </ul>
                      </details>
                    )}
                    <p>
                      {t("Saved sources")} · {data.source_count ?? t("Unknown")}
                    </p>
                    {data.gap_types?.length > 0 && (
                      <ul>
                        {data.gap_types.map((k) => (
                          <li key={k}>{t(gapLabels[k])}</li>
                        ))}
                      </ul>
                    )}
                    {sources.length === 0 && <p>{t("No source captured.")}</p>}
                    <ul>
                      {sources.map((s, i) => (
                        <li key={i}>
                          {t(roleLabels[s.role] ?? "Source")} · {s.language} ·{" "}
                          {s.download ? (
                            <a href={s.download} download>
                              {t("Download source")} {s.sha256.slice(0, 8)}
                            </a>
                          ) : (
                            t("Unavailable")
                          )}
                        </li>
                      ))}
                    </ul>
                  </>
                )}
              </Paged>
            </>
          )}
          <Receipt run={run} refresh={refresh + tick} />
        </section>
      )}
    </>
  );
}
const gapLabels = {
  missing: "Source unavailable",
  campus: "Campus or document role needs review",
  language: "Language needs review",
  reference: "Governing reference unavailable",
  scope: "Incomplete discovery",
  template: "Template needs review",
};
const roleLabels = {
  application: "Application",
  policy_summary: "Policy summary",
  policy_statement: "Policy statement",
  landing_page: "Landing page",
  unclassified: "Unclassified",
  supplement: "Supplement",
};
export function HospitalRuns({ hospitalKey }) {
  const { t, language } = useLocale(),
    url = api + "/hospitals/" + hospitalKey + "/runs";
  const storageKey = "audit-queue-intent-" + hospitalKey;
  const [tick, bump] = useState(0),
    [selected, select] = useState(null),
    [acceptedJob, setAcceptedJob] = useState(0),
    [intent, setIntent] = useState(() => {
      try {
        return JSON.parse(sessionStorage.getItem(storageKey));
      } catch {
        return null;
      }
    }),
    [busy, setBusy] = useState(false),
    [failed, setFailed] = useState(false);
  const lock = useRef(false),
    alive = useRef(true),
    polls = useRef(0);
  const r = useJson(url + "?limit=1", tick),
    latest = r.data?.items[0];
  useEffect(() => {
    alive.current = true;
    return () => {
      alive.current = false;
    };
  }, []);
  useEffect(() => {
    if (!active(latest?.status) || polls.current >= 120 || r.error) return;
    const id = setTimeout(() => {
      polls.current++;
      bump((n) => n + 1);
    }, 5000);
    return () => clearTimeout(id);
  }, [r, latest?.status]);
  function choose(mode) {
    if (lock.current) return;
    const day = new Date().toISOString().slice(0, 10);
    setIntent({
      mode,
      review_date: day,
      year: Number(day.slice(0, 4)),
      request_key: crypto.randomUUID(),
    });
    setFailed(false);
  }
  async function submit() {
    if (lock.current || !intent) return;
    lock.current = true;
    setBusy(true);
    setFailed(false);
    try {
      sessionStorage.setItem(storageKey, JSON.stringify(intent));
    } catch {}
    try {
      const res = await fetch(url, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "X-Review-Request": "1",
        },
        body: JSON.stringify(intent),
      });
      if (!res.ok) throw Error();
      const data = await res.json();
      try {
        sessionStorage.removeItem(storageKey);
      } catch {}
      if (alive.current) {
        setAcceptedJob(Number(data.audit_run_id.slice("audit-run-".length)));
        select(data.url);
        setIntent(null);
        polls.current = 0;
        bump((n) => n + 1);
      }
    } catch {
      if (alive.current) setFailed(true);
    } finally {
      lock.current = false;
      if (alive.current) setBusy(false);
    }
  }
  return (
    <section
      id="audit-runs"
      className="ops hospital-runs"
      aria-label={t("Hospital audits")}
    >
      <h3>{t("Hospital audits")}</h3>
      <p>
        {t(
          "Current audits produce draft findings. The published September 2025 rating is separate.",
        )}
      </p>
      <div className="ops-controls">
        {["discovery_only", "full_audit", "replay"].map((m) => (
          <button
            disabled={busy || !!intent || active(latest?.status) || !r.data || acceptedJob > (latest?.job_id ?? 0)}
            key={m}
            onClick={() => choose(m)}
          >
            {t(modes[m])}
          </button>
        ))}
      </div>
      {intent && (
        <div className="ops-confirm">
          <strong>{t(modes[intent.mode])}</strong>
          <p>
            {t(
              {
                discovery_only:
                  "This scan downloads public documents and uses local storage. It does not grade the hospital.",
                full_audit:
                  "This audit downloads and processes documents for 17 draft measures. Network, compute and storage costs may apply.",
                replay:
                  "Replay uses saved evidence and local compute. It leaves the last source fetch unchanged.",
              }[intent.mode],
            )}
          </p>
          <button disabled={busy} onClick={submit}>
            {t(failed ? "Retry same request" : "Confirm run")}
          </button>{" "}
          <button
            disabled={busy}
            onClick={() => {
              try {
                sessionStorage.removeItem(storageKey);
              } catch {}
              setIntent(null);
              setFailed(false);
            }}
          >
            {t("Cancel")}
          </button>
        </div>
      )}
      {failed && (
        <p role="alert">
          {t(
            "Queue response unavailable. Retry the same request to check it safely.",
          )}
        </p>
      )}
      <Notice resource={r} retry={() => bump((n) => n + 1)} />
      {r.data && (
        <>
          <dl>
            {Object.entries(clockLabels).map(([k, l]) => (
              <React.Fragment key={k}>
                <dt>{t(l)}</dt>
                <dd>
                  {date(r.data.clocks[k], language, t)}{" "}
                  {k === "next_due_at" &&
                    r.data.clocks[k] &&
                    Date.parse(r.data.clocks[k]) < Date.now() &&
                    t("Overdue")}
                </dd>
              </React.Fragment>
            ))}
          </dl>
          <button
            onClick={() => {
              polls.current = 0;
              bump((n) => n + 1);
            }}
          >
            {t("Refresh")}
          </button>
          <h4>{t("Run history")}</h4>
          <Paged url={url} refresh={tick}>
            {(items) =>
              items.length ? (
                <ul>
                  {items.map((x) => (
                    <li key={x.audit_run_id}>
                      <button
                        aria-pressed={
                          selected === api + "/runs/" + x.audit_run_id
                        }
                        onClick={() => select(api + "/runs/" + x.audit_run_id)}
                      >
                        {x.audit_run_id}
                      </button>{" "}
                      · {t(modes[x.mode])} · {t(statusNames[x.status])}
                    </li>
                  ))}
                </ul>
              ) : (
                <p>{t("No runs recorded.")}</p>
              )
            }
          </Paged>
          {(selected || latest) && (
            <RunDetail
              key={selected ?? latest.audit_run_id}
              path={selected ?? api + "/runs/" + latest.audit_run_id}
              refresh={tick}
            />
          )}
        </>
      )}
    </section>
  );
}
