import React from "react";
import { ratings, ratingByStars } from "./ratings.js";

export function Ratings({ hospitals, filter, onFilter }) {
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
      <div className="section-tag">Compliance rating system</div>
      <div className="stats-head">
        <div
          className="ring"
          aria-hidden="true"
          style={{ background: "conic-gradient(" + slices.join(",") + ")" }}
        />
        <div>
          <h2>Statewide ratings</h2>
          <p>September 2025 audit</p>
        </div>
      </div>
      <div className="table-head">
        <span>Rating</span>
        <span>Hospitals</span>
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
          <span className="rating-label">{r.label}</span>
          <span className="quantity">{counts.get(r.stars)}</span>
        </button>
      ))}
      <div className="filter-state">
        {filter === null ? (
          "Select a rating to filter the map."
        ) : (
          <>
            Showing {filter} stars ·{" "}
            <button className="plain" onClick={() => onFilter(null)}>
              Show all
            </button>
          </>
        )}
      </div>
      <div className="legend-foot">
        One-star facilities received an F with an application posted. Zero stars means no application was
        posted.
      </div>
    </>
  );
}

export function HospitalDetail({ hospital, onClose }) {
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
        ← Statewide ratings
      </button>
      <div className="section-tag">Hospital record</div>
      <h2>{p.name}</h2>
      <span className="pill">
        <span className="swatch" style={{ background: ratingByStars.get(p.stars).color }} />
        {p.stars} ★ · Grade {p.grade}
      </span>
      <dl>
        <dt>Address</dt>
        <dd>
          {p.address}, {p.city}
        </dd>
        <dt>County</dt>
        <dd>{p.county}</dd>
        <dt>Latitude</dt>
        <dd className="coords">{latitude}</dd>
        <dt>Longitude</dt>
        <dd className="coords">{longitude}</dd>
        <dt>Coordinate source</dt>
        <dd>
          <a href={p.coordinate_source_url}>{p.coordinate_source}</a>
        </dd>
      </dl>
      <div className="links">
        <a href={p.audit_url}>Audit row ↗</a>
        {p.assistance_url && <a href={p.assistance_url}>Financial assistance ↗</a>}
      </div>
    </div>
  );
}
