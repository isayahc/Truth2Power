import GradingPanel from "./GradingPanel.jsx";
import ReportingContext from "./ReportingContext.jsx";
import HospitalAssessment from "./HospitalAssessment.jsx";
import PilotAudit from "../audit/PilotAudit.jsx";
import AuditPanel from "../audit/AuditPanel.jsx";
import { HospitalRuns } from "../audit/AuditOperations.jsx";
import React, { useEffect, useState } from "react";
import { ratings, ratingByStars } from "../atlas/ratings.js";
import { useLocale } from "../../i18n/locale.jsx";

export function Ratings({ hospitals, filter, onFilter }) {
  const { t } = useLocale();
  const counts = new Map(ratings.map((r) => [r.stars, 0]));
  for (const h of hospitals) counts.set(h.properties.stars, counts.get(h.properties.stars) + 1);
  let stop = 0;
  const slices = ratings.map((r) => {
    const start = stop;
    stop += (counts.get(r.stars) / hospitals.length) * 100;
    return `${r.color} ${start}% ${stop}%`;
  });
  return (
    <>
      <div className="section-tag">{t('Compliance rating system')}</div>
      <div className="stats-head">
        <div
          className="ring"
          aria-hidden="true"
          style={{ background: "conic-gradient(" + slices.join(",") + ")" }}
        />
        <div>
          <h2>{t('Statewide ratings')}</h2>
          <p>{t('September 2025 audit')}</p>
        </div>
      </div>
      <div className="table-head">
        <span>{t('Rating')}</span>
        <span>{t('Hospitals')}</span>
      </div>
      {ratings.map((r) => (
        <button
          className="legend-item"
          key={r.stars}
          aria-pressed={filter === r.stars}
          onClick={() => onFilter(filter === r.stars ? null : r.stars)}
        >
          <span className="swatch" style={{ background: r.color }} />
          <span className="stars">{r.stars} ★</span>
          <span className="rating-label">{t(r.label)}</span>
          <span className="quantity">{counts.get(r.stars)}</span>
        </button>
      ))}
      <div className="filter-state">
        {filter === null ? (
          t('Select a rating to filter the map.')
        ) : (
          <>
            {t('Showing')} {filter} {t(filter === 1 ? 'star' : 'stars')} ·{" "}
            <button className="plain" onClick={() => onFilter(null)}>
              {t('Show all')}
            </button>
          </>
        )}
      </div>
      <div className="legend-foot">
        {t('One-star facilities received an F with an application posted. Zero stars means no application was posted.')}
      </div>
    </>
  );
}

export function HospitalDetail({ hospital, onClose, onReview, pendingReviews }) {
  const { t, language, localHref } = useLocale();
  // The latest run's assessment id, reported by HospitalRuns so the
  // findings tab can reload from the newest committed revision.
  const [publishedRevision, setPublishedRevision] = useState(null);
  const [panel, setPanel] = useState(window.location.hash === '#audit-runs' ? 'audits' : 'findings');
  useEffect(() => {
    const sync = () => setPanel(window.location.hash === '#audit-runs' ? 'audits' : 'findings');
    sync();
    window.addEventListener('hashchange', sync);
    return () => window.removeEventListener('hashchange', sync);
  }, [hospital.id]);
  const p = hospital.properties;
  const [longitude, latitude] = hospital.geometry.coordinates;
  return (
    <article className="detail" onKeyDown={(event) => {
      if (event.key === "Escape") onClose();
    }}>
      <button className="back plain" onClick={onClose} autoFocus={!window.location.hash}>
        {t('← Back to statewide map and ratings')}
      </button>
      <div className="hospital-summary">
        <h1>{p.name}</h1>
        <p>{p.address}, {p.city} · {t('County')}: {p.county}</p>
        <p className="pill">
          <span className="swatch" style={{ background: ratingByStars.get(p.stars).color }} />
          {t('Published rating')} · {p.stars} ★ · {t('Grade')} {p.grade} · {t('September 2025')}
        </p>
        <div className="record-actions">
          {p.assistance_url && <a href={p.assistance_url} target="_blank" rel="noreferrer">{t('Get hospital financial assistance (HFA) ↗')}</a>}
          <a href={p.audit_url}>{t('Audit row ↗')}</a>
        </div>
      </div>
      <section className="hospital-findings">
        <nav className="hospital-panel-nav" aria-label={t('Hospital workspace')}>
          <button aria-pressed={panel === 'findings'} onClick={() => setPanel('findings')}>{t('Findings')}</button>
          <button aria-pressed={panel === 'audits'} onClick={() => setPanel('audits')}>{t('Audits and history')}</button>
        </nav>
        <div hidden={panel !== 'findings'}>
          <h2>{t('Audit findings')}</h2>
          {language === 'es' && <p className="translation-scope">{t('Detailed audit and review panels below are in English. Quotations retain the original document language.')}</p>}
          <div lang="en">
            <HospitalAssessment hospitalKey={hospital.id} hospitalName={p.name} publishedRevision={publishedRevision} />
            <ReportingContext hospitalKey={hospital.id} />
            <GradingPanel hospitalKey={hospital.id} />
            <PilotAudit hospitalKey={hospital.id} />
            {hospital.id === "362" && <AuditPanel />}
          </div>
        </div>
        <div hidden={panel !== 'audits'}>
          <HospitalRuns hospitalKey={hospital.id} onAssessment={setPublishedRevision} />
        </div>
      </section>
      <button className="review-nav" onClick={onReview}>{t('Review notifications')} ({pendingReviews ?? "…"})</button>
      <details className="location-details">
        <summary>{t('Location details')}</summary>
        <dl>
          <dt>{t('Latitude')}</dt><dd className="coords">{latitude}</dd>
          <dt>{t('Longitude')}</dt><dd className="coords">{longitude}</dd>
          <dt>{t('Coordinate source')}</dt><dd><a href={p.coordinate_source_url}>{p.coordinate_source}</a></dd>
        </dl>
      </details>
      <a href={localHref(`?hospital=${encodeURIComponent(hospital.id)}`)}>{t('Permanent link to this hospital page')}</a>
    </article>
  );
}
