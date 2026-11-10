import { HospitalRuns } from "./AuditOperations.jsx";
import GradingPanel from "./GradingPanel.jsx";
import ReportingContext from "./ReportingContext.jsx";
import HospitalAssessment from "./HospitalAssessment.jsx";
import PilotAudit from "./PilotAudit.jsx";
import AuditPanel from "./AuditPanel.jsx";
import React from "react";
import { ratings, ratingByStars } from "./ratings.js";
import { useLocale } from './locale.jsx';

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
  const p = hospital.properties;
  const [longitude, latitude] = hospital.geometry.coordinates;
  return (
    <div
      className="detail"
      aria-live="polite"
      onKeyDown={(e) => {
        if (e.key === "Escape") onClose();
      }}
    >
      <button className="back plain" onClick={onClose}>
        {t('← Statewide ratings')}
      </button>
      <div className="section-tag">{t('Hospital record')}</div>
      <h2>{p.name}</h2>
      <span className="pill">
        <span className="swatch" style={{ background: ratingByStars.get(p.stars).color }} />
        {p.stars} ★ · {t('Grade')} {p.grade} · {t('September 2025')}
      </span>
      <dl>
        <dt>{t('Address')}</dt>
        <dd>
          {p.address}, {p.city}
        </dd>
        <dt>{t('County')}</dt>
        <dd>{p.county}</dd>
        <dt>{t('Latitude')}</dt>
        <dd className="coords">{latitude}</dd>
        <dt>{t('Longitude')}</dt>
        <dd className="coords">{longitude}</dd>
        <dt>{t('Coordinate source')}</dt>
        <dd>
          <a href={p.coordinate_source_url}>{p.coordinate_source}</a>
        </dd>
      </dl>
      {p.assistance_url && <p><a href={p.assistance_url} target="_blank" rel="noreferrer">{t('Get hospital financial assistance (HFA) ↗')}</a></p>}
      <a href={localHref(`?hospital=${encodeURIComponent(hospital.id)}`)}>{t('Permanent link to this hospital page')}</a>
      <HospitalRuns key={hospital.id} hospitalKey={hospital.id} />
      {language === 'es' && <p className="translation-scope">{t('Detailed audit and review panels below are in English. Quotations retain the original document language.')}</p>}
      <div lang="en">
      <HospitalAssessment key={`assessment-${hospital.id}`} hospitalKey={hospital.id} hospitalName={p.name} />
      <PilotAudit key={`pilot-${hospital.id}`} hospitalKey={hospital.id} />
      <ReportingContext key={`reporting-${hospital.id}`} hospitalKey={hospital.id} />
      <GradingPanel key={`grading-${hospital.id}`} hospitalKey={hospital.id} />
      {hospital.id === "362" && <AuditPanel />}
      </div>
      <button className="review-nav" onClick={onReview}>{t('Review notifications')} ({pendingReviews ?? "…"})</button>
      <div className="links">
        <a href={p.audit_url}>{t('Audit row ↗')}</a>
        {p.assistance_url && <a href={p.assistance_url}>{t('Financial assistance ↗')}</a>}
      </div>
    </div>
  );
}
