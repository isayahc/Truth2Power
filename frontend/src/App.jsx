import React, { useEffect, useState } from "react";
import Changes from "./Changes.jsx";
import { AuditOperations } from "./AuditOperations.jsx";
import Overview from "./Overview.jsx";
import HospitalMap from "./HospitalMap.jsx";
import HospitalSearch from "./HospitalSearch.jsx";
import { HospitalDetail, Ratings } from "./Ratings.jsx";
import ReviewInbox, { reviewRequest } from "./ReviewInbox.jsx";
import { LanguageSwitch, useLocale } from './locale.jsx';
import { HumanInterventionInbox } from './HumanIntervention.jsx';
import {CriterionCoverageProvider, CriterionReviewNotifications, useCriterionCoverage} from './CriterionCoverage.jsx';
import RegionalAudits from './RegionalAudits.jsx';
import CurrentCriteriaMap from './CurrentCriteriaMap.jsx';
import RegionPicker,{regionsFromUrl} from './RegionPicker.jsx';
import Statistics from './Statistics.jsx';

async function getFeatures(path, signal) {
  const response = await fetch(path, { signal });
  if (!response.ok) throw new Error("Dataset request failed.");
  const data = await response.json();
  if (data.type !== "FeatureCollection" || !Array.isArray(data.features) || !data.features.length) {
    throw new Error("Empty or invalid map data.");
  }
  return [...data.features,...(data.historical_features ?? [])];
}

function Header({ onReview, reviewOpen, pending }) {
  const {data:coverage}=useCriterionCoverage();
  const { t, localHref } = useLocale();
  const [humanTasks,setHumanTasks]=useState(0);
  useEffect(()=>{let live=true;const load=()=>fetch('/api/pilot/v1/interventions').then(r=>r.ok?r.json():null).then(x=>{if(live&&x)setHumanTasks(x.items.length)}).catch(()=>{});load();const timer=setInterval(load,10000);return()=>{live=false;clearInterval(timer)}},[]);
  return (
    <header>
      <a className="brand" href={localHref('/')} aria-label={t('Truth2Power homepage')}>
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
      </a>
      <div className="header-actions">
       <a href={localHref('?view=statistics')}>{t('Statistics')}</a>
      <a className="overview-link" href={localHref('?view=overview')}>{t('Audit overview')}</a>
      <a className="changes-link" href={localHref('?view=operations')}>{t('Audit operations')}</a>
       <button className="review-nav" onClick={onReview} aria-pressed={reviewOpen}>{t('Review inbox')} <span>{typeof pending==='number' ? pending+humanTasks+(coverage?.pending ?? 0) : pending ?? "…"}</span></button>
       <a href={localHref('?view=regional')}>{t('Compare two regions')}</a>
      <LanguageSwitch />
      </div>
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
  return <CriterionCoverageProvider><Atlas /></CriterionCoverageProvider>;
}
function Atlas() {
  const { t } = useLocale();
  const [data, setData] = useState(null);
  const [error, setError] = useState(false);
  const [attempt, setAttempt] = useState(0);
  const [filter, setFilter] = useState(null);
  const [year,setYear]=useState(()=>new URLSearchParams(location.search).get('year')==='2025'?'2025':'2026');
  const [mapRegions,setMapRegions]=useState(regionsFromUrl);
  const region=mapRegions.map(name=>t(name)).join(', ');
  const [selected, setSelected] = useState(null);
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
      setMapRegions(regionsFromUrl());
      setYear(new URL(location.href).searchParams.get('year')==='2025'?'2025':'2026');
      setSelected(data.hospitals.find((h) => String(h.id) === key) || null);
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
    if(hospital?.markerRequirement&&hospital.markerRequirement!=='all')url.hash=`criterion-${hospital.markerRequirement}`;
    window.history.pushState(null, "", url);
  }

  function selectHospital(hospital) {
    setSelected(hospital);
    hospitalUrl(hospital);
  }
  function closeDetail() {
    setSelected(null);
    hospitalUrl(null);
    requestAnimationFrame(() => document.querySelector(".search-bar input")?.focus());
  }
  const current = data?.hospitals.filter(h=>h.properties.current_directory!==false);
  const regional = current?.filter(h=>!mapRegions.length || mapRegions.includes(h.properties.region));
  const visible = regional?.filter((h) => filter === null || (h.properties.stars ?? 'unrated') === filter);
  const mapControls=<>
   <div className="map-year-switch" role="group" aria-label={t('Map year')}>
    {['2025','2026'].map(value=><button key={value} aria-pressed={year===value} aria-label={t(value==='2025'?'2025 — Published ratings':'2026 — Current requirement checks')} title={t(value==='2025'?'2025 — Published ratings':'2026 — Current requirement checks')} onClick={()=>{setYear(value);setFilter(null);const url=new URL(location.href);url.searchParams.set('year',value);history.pushState(null,'',url);}}>{value}</button>)}
   </div>
   <RegionPicker values={mapRegions} onChange={values=>{setMapRegions(values);const url=new URL(location.href);url.searchParams.delete('region');for(const value of values)url.searchParams.append('region',value);history.replaceState(null,'',url);}}/>
  </>;
  return (
    <div className="page">
      <Header onReview={() => reviewOpen ? setReviewOpen(false) : openReviews()} reviewOpen={reviewOpen} pending={reviewError ? "!" : inbox?.pending} />
      <main>
        {!reviewOpen && !selected && new URLSearchParams(location.search).get('view')==='statistics' ? <Statistics /> : reviewOpen ? <>
          <button className="back plain" onClick={() => setReviewOpen(false)}>{t(selected ? '← Back to hospital record' : '← Back to hospital map')}</button>
          <HumanInterventionInbox />
          <CriterionReviewNotifications hospitalKey={reviewHospital} />
          <div lang="en"><ReviewInbox key={reviewHospital} inbox={inbox} error={reviewError} onRefresh={refreshReviews}
            hospitalKey={reviewHospital} hospitals={data?.hospitals ?? []} onHospital={(hospital) => {
              if (hospital) { selectHospital(hospital); setReviewOpen(false); }
            }} /></div>
        </> : !selected && new URLSearchParams(window.location.search).get('view')==='regional' ? (data ? <RegionalAudits features={current} counties={data.counties}/> : <p role="status">{t('Loading hospital locations…')}</p>) : !selected && new URLSearchParams(window.location.search).get("view") === "operations" ? <AuditOperations /> : !selected && new URLSearchParams(window.location.search).get("view") === "changes" ? <div lang="en"><Changes /></div> : !selected && new URLSearchParams(window.location.search).get("view") === "overview" ?
          (data ? <div lang="en"><Overview features={data.hospitals} counties={data.counties} /></div> :
            <p role="status">{error ? <button onClick={() => setAttempt(attempt + 1)}>{t('Retry loading atlas')}</button> : t('Loading atlas…')}</p>) : <>
        <div className="intro" hidden={!!selected}>
          <div>
            <div className="period">{t(year==='2025'?'September 2025 review':'2026 — Current requirement checks')}</div>
            <h1>{t('New York hospital compliance')}</h1>
            <p className="descr">
              {t(year==='2025'?'Hospital financial assistance policies across New York State, rated from zero to five stars.':'Explore current findings for all 17 financial assistance requirements, or select one requirement.')}
            </p>
          </div>
          {data && (
            <div className="intro-stat">
              <strong>{regional.length}</strong>
               <span>{t('Hospitals mapped')}</span>
            </div>
          )}
        </div>
        {data ? (
          <>
          {year==='2026'?(!selected&&<CurrentCriteriaMap hospitals={regional} counties={data.counties} onSelect={selectHospital} region={region} regions={mapRegions} controls={mapControls}/>):<div className="content" hidden={!!selected}>
            <section className="map-block" aria-label={t('Hospital locations')}>
              <div className="toolbar atlas-toolbar">
                {mapControls}
                <HospitalSearch
                  hospitals={visible}
                  onSelect={selectHospital}
                />
              </div>
              <HospitalMap
                hospitals={visible}
                counties={data.counties}
                selected={selected}
                onSelect={selectHospital}
              />
              <div className="map-footer">
                <strong aria-live="polite">
                  {filter === null
                     ? regional.length
                     : visible.length + ' ' + t('of') + ' ' + regional.length}{" "}
                  {t('hospital locations')}
                </strong>
                <span className="hint">{t('Select a hospital for its coordinates and audit record.')}</span>
              </div>
            </section>
            <aside>
              <Ratings hospitals={regional} filter={filter} onFilter={setFilter} region={region} />
              <p>{t('Regions follow Attachment G and use the hospital’s county, not its service area.')}</p>
            </aside>
          </div>}
          {selected && <HospitalDetail key={selected.id} hospital={selected} onClose={closeDetail} onReview={() => openReviews(String(selected.id))}
            pendingReviews={inbox?.items.filter((r) => r.hospital_key === String(selected.id) && r.status !== "resolved").length} />}
          </>
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
