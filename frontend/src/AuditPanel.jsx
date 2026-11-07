import React, { useState, useEffect } from "react";

const endpoint = "/api/audits/362";
export default function AuditPanel() {
  const [state, setState] = useState(null),
    [year, setYear] = useState("2026"),
    [error, setError] = useState("");
  useEffect(() => {
    let active = true,
      timer;
    async function refresh() {
      try {
        const response = await fetch(endpoint);
        if (!response.ok) throw Error();
        const data = await response.json();
        if (active) setState(data);
      } catch {
        if (active) setError("Could not load audit status.");
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
      const response = await fetch(endpoint + "/" + year, {
        method: "POST",
        headers: { "X-Audit-Request": "1" },
      });
      if (!response.ok) throw Error();
      setError("");
      setState((old) => ({ ...old, job: { status: "queued" } }));
    } catch {
      setError("Could not queue the recheck.");
    }
  }
  const output = state?.latest,
    finding = output?.assessment.findings[0];
  const citation = finding?.evidence[0];
  const snapshot = output?.snapshots.find(
    (s) => s.snapshot_id === citation?.snapshot_id,
  );
  return (
    <section aria-label="Synthetic FPL audit">
      <h3>FPL audit · synthetic demonstration</h3>
      <label>
        Guideline year{" "}
        <select value={year} onChange={(e) => setYear(e.target.value)}>
          <option>2025</option>
          <option>2026</option>
        </select>
      </label>
      <button onClick={queue}>Recheck application</button>
      <p role="status">{error || state?.job?.error || state?.job?.status}</p>
      {finding && (
        <>
          <p>Last completed check: {output.last_successful_assessment_at}</p>
          <p>
            {output.reference_version} · {finding.result}
          </p>
          <p>{finding.explanation}</p>
          {snapshot && (
            <details>
              <summary>Source evidence</summary>
              <blockquote>{citation.quote}</blockquote>
              <p>
                {citation.locator} · SHA-256{" "}
                <code style={{ overflowWrap: "anywhere" }}>
                  {snapshot.sha256}
                </code>
              </p>
              <a href={"/api/audits/snapshots/" + snapshot.sha256}>
                Open saved PDF
              </a>
            </details>
          )}
        </>
      )}
    </section>
  );
}
