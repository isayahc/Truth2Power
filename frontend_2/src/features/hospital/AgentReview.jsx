import React from "react";
import rubric from "../../assets/rubrics/css-17-v1.json";
import { useLocale } from "../../i18n/locale.jsx";

const measures = new Map(rubric.measures.map(m => [m.measure_id, m]));
const reviewers = { website: "Website reviewer", documents: "Document reviewer", coordinator: "Coordinating reviewer" };
const statuses = {
  completed: "Completed", no_evidence: "No evidence to review",
  not_configured: "Not configured", unavailable: "Unavailable",
};
const reasons = {
  invalid_output: "The response failed validation.",
  opencode_missing: "The worker could not find OpenCode.",
  agent_timeout: "The model review reached its time limit.",
  opencode_failed: "OpenCode exited before returning a review.",
  missing_credentials: "The worker is missing model provider credentials.",
  paid_disabled: "Paid model calls were disabled for this run.",
  already_reserved: "An earlier attempt already reserved this model call.",
  rate_limited: "The model provider rate-limited this request.",
  provider_error: "The model provider did not complete the request.",
  budget_exhausted: "Run budget exhausted",
  quota_exceeded: "Resource quota exceeded",
  unknown_price: "Provider price unknown",
};
const outcomes = { yes: "Yes", no: "No", unclear: "Unclear", n_a: "Not applicable" };
const roles = { application: "Application", policy_summary: "Policy summary", policy_statement: "Policy statement", supplement: "Supplement" };

function sourceLabel(sourceId) {
  try {
    const url = new URL(sourceId);
    if (url.protocol === "https:") return url.host + url.pathname;
  } catch { /* Older records can lack a public URL. */ }
  return null;
}

function Citations({ evidence, revision }) {
  const { t } = useLocale();
  return (evidence ?? []).map((citation, i) => {
    const source = sourceLabel(citation.source_id);
    const locator = /^link https?:\/\//i.test(citation.locator) ? t("Link on the saved page") : citation.locator;
    const path = /^\/api\/pilot\/v1\/runs\/audit-run-[1-9]\d*\/revision\/([a-f0-9]{64})\/snapshots\/([a-f0-9]{64})$/.exec(citation.download);
    return <div key={i}>
      <blockquote>{citation.quote}</blockquote>
      {source && <>{source} · </>}{locator}
      {path && path[1] === revision && path[2] === citation.sha256 && <> · <a href={citation.download} download>{t("Download cited snapshot")}</a></>}
    </div>;
  });
}

/** Display the saved passages behind one draft recommendation. */
export function AgentFinding({ finding, revision, heading = false }) {
  const { t } = useLocale();
  return <>
    {heading && <h5>{t("Model review")} · {t("Draft")} · {t(outcomes[finding.result] ?? "Unknown")}</h5>}
    <p>{finding.explanation}</p>
    <Citations evidence={finding.evidence} revision={revision} />
    {!!finding.identity_basis?.length && <details>
      <summary>{t("Document identity evidence")}</summary>
      {finding.identity_basis.map((basis, i) => <div key={i}>
        <p>{t("Proposed document role")} · {t(roles[basis.proposed_role] ?? "Unknown")}</p>
        <Citations evidence={basis.evidence} revision={revision} />
      </div>)}
    </details>}
  </>;
}

/** Display the model's draft conclusions alongside citations to this revision's original snapshots. */
export default function AgentReview({ review, revision }) {
  const { t } = useLocale();
  if (!review) return null;
  if (review.status === "not_configured") return <p>{t("Model review was off for this run.")}</p>;

  return <section aria-label={t("Model review")}>
    <h4>{t("Model review")} · {t("Draft")}</h4>
    <p>{t("These recommendations are available for human review. The rubric determines the calculated grade.")}</p>
    {review.omitted_passages > 0 && <p>{t("Source passages omitted from model review")} · {review.omitted_passages}</p>}
    <ul>{Object.entries(reviewers).map(([key, label]) => {
      const agent = review.agents?.[key];
      return <li key={key}>{t(label)} · <strong>{t(statuses[agent?.status] ?? "Unknown")}</strong>
        {agent?.status === "unavailable" && Object.hasOwn(reasons, agent.reason) && <> · {t(reasons[agent.reason])}</>}
      </li>;
    })}</ul>
    {review.findings?.length > 0 && <details>
      <summary>{t("Model findings by criterion")} ({review.findings.length})</summary>
      {review.findings.map(finding => {
        const measure = measures.get(finding.measure_id);
        return <details key={finding.measure_id} className="measure-card">
          <summary><span>{measure ? `${measure.css_column} · ${t(measure.title)}` : finding.measure_id}</span>
            {" "}<strong>{t(outcomes[finding.result] ?? "Unknown")}</strong></summary>
          <div className="measure-body">
            <AgentFinding finding={finding} revision={revision} />
          </div>
        </details>;
      })}
    </details>}
  </section>;
}
