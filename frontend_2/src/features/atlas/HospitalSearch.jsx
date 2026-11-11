import React, { useRef, useState } from "react";
import { useLocale } from '../../i18n/locale.jsx';

export default function HospitalSearch({ hospitals, onSelect }) {
  const { t } = useLocale();
  const [query, setQuery] = useState("");
  const [open, setOpen] = useState(false);
  const results = useRef(null);
  const needle = query.trim().toLowerCase();
  const matches = needle
    ? hospitals.filter(({ properties: p }) =>
        [p.name, p.city, p.county, p.pfi].some((value) =>
          String(value ?? "")
            .toLowerCase()
            .includes(needle),
        ),
      )
    : [];
  function choose(hospital) {
    setOpen(false);
    onSelect(hospital);
  }
  return (
    <div
      className="search-box"
      onBlur={(e) => {
        if (!e.currentTarget.contains(e.relatedTarget)) setOpen(false);
      }}
      onKeyDown={(e) => {
        if (e.key === "Escape") {
          e.stopPropagation();
          setOpen(false);
        }
      }}
    >
      <label className="search-bar">
        <svg aria-hidden="true" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.9">
          <circle cx="10" cy="10" r="6.5" />
          <path d="m15 15 5 5" />
        </svg>
        <input
          type="search"
          placeholder={t('Find a hospital or city')}
          aria-label={t('Find a hospital or city')}
          value={query}
          onChange={(e) => {
            setQuery(e.target.value);
            setOpen(true);
          }}
          onFocus={() => setOpen(true)}
          onKeyDown={(e) => {
            if (open && e.key === "Enter" && matches.length) choose(matches[0]);
            if (open && e.key === "ArrowDown") {
              e.preventDefault();
              results.current?.querySelector("button")?.focus();
            }
          }}
        />
      </label>
      {open && needle && (
        <div className="results" ref={results}>
          {matches.length ? (
            matches.map((h) => (
              <button key={h.id} onClick={() => choose(h)}>
                {h.properties.name}
                <small>
                  {h.properties.city} · {h.properties.stars} ★
                </small>
              </button>
            ))
          ) : (
            <p>{t('No matching hospitals.')}</p>
          )}
        </div>
      )}
    </div>
  );
}
