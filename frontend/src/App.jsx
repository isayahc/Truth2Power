import React, { useEffect, useState } from "react";
import Changes from "./Changes.jsx";
import { AuditOperations } from "./AuditOperations.jsx";
import Overview from "./Overview.jsx";
import HospitalMap from "./HospitalMap.jsx";
import HospitalSearch from "./HospitalSearch.jsx";
import { HospitalDetail, Ratings } from "./Ratings.jsx";
import ReviewInbox, { reviewRequest } from "./ReviewInbox.jsx";
import { LanguageSwitch, useLocale } from './locale.jsx';

async function getFeatures(path, signal) {
  const response = await fetch(path, { signal });
  if (!response.ok) throw new Error("Dataset request failed.");
  const data = await response.json();
  if (data.type !== "FeatureCollection" || !Array.isArray(data.features) || !data.features.length) {
    throw new Error("Empty or invalid map data.");
  }
  return data.features;
}

function Header({ onReview, pending }) {
  const { t, localHref } = useLocale();
  return (
    <header>
      <div className="brand">
        <span className="mark" aria-hidden="true">
          <svg width="22" height="22" viewBox="0 0 24 24" fill="none">
            <path
              d="M4 16 11 6h8l-7 12H7l5-9"
              stroke="#b4e7cf"
              strokeWidth="1.8"
              strokeLinecap="round"
              strokeLinejoin="round"
            />
          </svg>
        </span>
        <span className="brand-name">Truth2Power</span>
        <span className="brand-unit">{t('Health equity atlas')}</span>
      </div>
      <a className="overview-link" href={localHref('?view=overview')}>{t('Audit overview')}</a>
      <a className="changes-link" href={localHref('?view=operations')}>{t('Audit operations')}</a>
      <a className="changes-link" href={localHref('?view=changes')}>{t('Recent changes')}</a>
      <button className="review-nav" onClick={onReview}>{t('Review inbox')} <span>{pending ?? "…"}</span></button>
      <LanguageSwitch />
    </header>
  );
}

function Footer() {
  const { t } = useLocale();
  return (
    <div className="foot">
      <p>
        {t('Audit:')}{" "}
        <a href="https://docs.google.com/spreadsheets/d/17S2EheUVVr1g911fPpBQJqRpy18pkUlaEEnvGM0LB1o/edit#gid=504145376">
          Community Service Society of New York
        </a>{" "}
        · {t('Boundaries:')} <a href="https://gis.ny.gov/civil-boundaries">NYS Geospatial Services</a>
        <br />
        {t('Coordinates:')}{" "}
        <a href="https://health.data.ny.gov/Health/Health-Facility-General-Information/vn5v-hh5r">
          NYS DOH
        </a>
        ,{" "}
        <a href="https://services2.arcgis.com/FiaPA4ga0iQKduv3/ArcGIS/rest/services/Extract_Data_Hospitals_HIFLD/FeatureServer/0">
          HIFLD Hospitals
        </a>
        , <a href="https://www.openstreetmap.org/copyright">© OpenStreetMap contributors</a> · WGS 84
        <br />
        {t('For demonstration only. Not medical advice. Ratings describe hospital policies in September 2025.')}
      </p>
      <div className="downloads">
        <a className="download" href="/api/hospitals" download="new-york-hospital-coordinates.geojson">
          ↓ GeoJSON
        </a>
        <a className="download" href="/api/coordinates.csv" download="hospital-coordinates.csv">
          ↓ CSV
        </a>
      </div>
    </div>
  );
}

/** Load the public atlas from the Node API and coordinate filters, search and map selection. */
export default function App() {
  const { t } = useLocale();
  const [data, setData] = useState(null);
  const [error, setError] = useState(false);
  const [attempt, setAttempt] = useState(0);
  const [filter, setFilter] = useState(null);
  const [selected, setSelected] = useState(null);
  const [mapKey, setMapKey] = useState(0);
  const [searchKey, setSearchKey] = useState(0);
  const [reviewOpen, setReviewOpen] = useState(false);
  const [reviewHospital, setReviewHospital] = useState("");
  const [inbox, setInbox] = useState(null);
  const [reviewError, setReviewError] = useState("");
  async function refreshReviews() {
    try { setInbox(await reviewRequest("/api/reviews")); setReviewError(""); }
    catch (e) { setReviewError(e.message); }
  }
  useEffect(() => { refreshReviews(); }, []);
  function openReviews(hospital = "") { setReviewHospital(hospital); setReviewOpen(true); refreshReviews(); }
  useEffect(() => {
    const controller = new AbortController();
    setError(false);
    Promise.all([
      getFeatures("/api/hospitals", controller.signal),
      getFeatures("/api/counties", controller.signal),
    ])
      .then(([hospitals, counties]) => {
        if (!controller.signal.aborted) setData({ hospitals, counties });
      })
      .catch(() => {
        if (!controller.signal.aborted) setError(true);
      });
    return () => controller.abort();
  }, [attempt]);

  useEffect(() => {
    if (!data) return;
    const restore = () => {
      const key = new URL(window.location.href).searchParams.get("hospital");
      setSelected(data.hospitals.find((h) => String(h.id) === key) || null);
      setFilter(null);
      setReviewOpen(false);
    };
    restore();
    window.addEventListener("popstate", restore);
    return () => window.removeEventListener("popstate", restore);
  }, [data]);

  function hospitalUrl(hospital) {
    const url = new URL(window.location.href);
    if (hospital) url.searchParams.set("hospital", hospital.id);
    else url.searchParams.delete("hospital");
    url.searchParams.delete("view");
    url.searchParams.delete("revision");
    url.hash = "";
    window.history.pushState(null, "", url);
  }

  function selectHospital(hospital) {
    if (filter !== null && filter !== hospital.properties.stars) setFilter(null);
    setSelected(hospital);
    hospitalUrl(hospital);
  }
  function closeDetail() {
    setSelected(null);
    hospitalUrl(null);
    setSearchKey((value) => value + 1);
  }
  const visible = data?.hospitals.filter((h) => filter === null || h.properties.stars === filter);
  return (
    <div className="page">
      <Header onReview={() => openReviews()} pending={reviewError ? "!" : inbox?.pending} />
      <main>
        {reviewOpen ? <>
          <button className="back plain" onClick={() => setReviewOpen(false)}>{t('← Back to hospital map')}</button>
          <div lang="en"><ReviewInbox key={reviewHospital} inbox={inbox} error={reviewError} onRefresh={refreshReviews}
            hospitalKey={reviewHospital} hospitals={data?.hospitals ?? []} onHospital={(hospital) => {
              if (hospital) { selectHospital(hospital); setMapKey((n) => n + 1); setReviewOpen(false); }
            }} /></div>
        </> : !selected && new URLSearchParams(window.location.search).get("view") === "operations" ? <AuditOperations /> : !selected && new URLSearchParams(window.location.search).get("view") === "changes" ? <div lang="en"><Changes /></div> : !selected && new URLSearchParams(window.location.search).get("view") === "overview" ?
          (data ? <div lang="en"><Overview features={data.hospitals} counties={data.counties} /></div> :
            <p role="status">{error ? <button onClick={() => setAttempt(attempt + 1)}>{t('Retry loading atlas')}</button> : t('Loading atlas…')}</p>) : <>
        <div className="intro">
          <div>
            <div className="period">{t('September 2025 review')}</div>
            <h1>{t('New York hospital compliance')}</h1>
            <p className="descr">
              {t('Hospital financial assistance policies across New York State, rated from zero to five stars.')}
            </p>
          </div>
          {data && (
            <div className="intro-stat">
              <strong>{data.hospitals.length}</strong>
               <span>{t('Hospitals mapped')}</span>
            </div>
          )}
        </div>
        {data ? (
          <div className={`content${selected ? " hospital-selected" : ""}`}>
            <section className="map-block" aria-label={t('Hospital locations')}>
              <div className="toolbar">
                <div className="geo-label">
                  <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.6">
                    <path d="m3 6 6-2 6 3 6-2v14l-6 2-6-3-6 2zM9 4v14m6-11v14" />
                  </svg>
                  {t('Statewide map')}
                </div>
                <HospitalSearch
                  key={searchKey}
                  hospitals={data.hospitals}
                  onSelect={(hospital) => {
                    selectHospital(hospital);
                    setMapKey((value) => value + 1);
                  }}
                />
              </div>
              <HospitalMap
                key={mapKey}
                hospitals={visible}
                counties={data.counties}
                selected={selected}
                onSelect={selectHospital}
              />
              <div className="map-footer">
                <strong aria-live="polite">
                  {filter === null
                    ? data.hospitals.length
                    : visible.length + ' ' + t('of') + ' ' + data.hospitals.length}{" "}
                  {t('hospital locations')}
                </strong>
                <span className="hint">{t('Select a hospital for its coordinates and audit record.')}</span>
              </div>
            </section>
            <aside>
              {selected ? (
                <HospitalDetail hospital={selected} onClose={closeDetail} onReview={() => openReviews(String(selected.id))}
                  pendingReviews={inbox?.items.filter((r) => r.hospital_key === String(selected.id) && r.status !== "resolved").length} />
              ) : (
                <Ratings hospitals={data.hospitals} filter={filter} onFilter={setFilter} />
              )}
            </aside>
          </div>
        ) : (
          <p className="load-status" role="status">
            {error ? (
              <>
                {t('Couldn’t load the map data.')}{" "}
                <button className="plain" onClick={() => setAttempt((value) => value + 1)}>
                  {t('Try again')}
                </button>
              </>
            ) : (
              t('Loading hospital locations…')
            )}
          </p>
        )}
        </>}
        <Footer />
      </main>
    </div>
  );
}
