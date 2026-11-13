import React, { memo, useEffect, useRef, useState } from "react";
import { countyPath, metro, metroFull, metroCounties, statewide } from "./geometry.js";
import { ratingByStars } from "./ratings.js";
import { useLocale } from './locale.jsx';
import {useCriterionCoverage, coverageText, emptyCoverage} from './CriterionCoverage.jsx';

const waters = [
  ["Lake Ontario", -77.72, 43.54],
  ["Lake Erie", -79.45, 42.73],
];
const metroLabels = [
  ["New York City", -74.03, 40.98],
  ["Long Island", -72.78, 40.65],
];
const initialView = { zoom: 1, x: 0, y: 0 };
const limit = (value, min, max) => Math.max(min, Math.min(max, value));

const Land = memo(function Land({ counties, project }) {
  return counties.map(({ geometry, properties }) => (
    <path
      key={properties.NAME}
      className="county"
      fillRule="evenodd"
      d={countyPath(geometry, project)}
    />
  ));
});

function Labels({ items, className, project = statewide }) {
  const { t } = useLocale();
  return items.map(([name, longitude, latitude]) => {
    const [x, y] = project([longitude, latitude]);
    return (
      <text key={name} x={x} y={y} className={className}>
        {t(name)}
      </text>
    );
  });
}

function Points({ hospitals, project, zoom = 1, markerScale = 1, selected, onSelect, setHover }) {
  const { t, language } = useLocale();
  const {data,error}=useCriterionCoverage();
  const size=markerScale/zoom;
  return hospitals.map((hospital) => {
    const [cx, cy] = project(hospital.geometry.coordinates);
    const { stars, name } = hospital.properties;
    const active = selected?.id === hospital.id;
    const activity=hospital.markerStatus ?? (error ? null : data?.activity?.[hospital.id]?.status);
    const activityLabel={queued:'Queued',running:'Running',completed:'Completed',attention:'Needs evidence review',error:'Technical error — not assessed',cancelled:'Cancelled'}[activity];
    const label = name + " · " + (hospital.markerLabel ?? (stars==null ? t('Not rated') : stars + ' ' + t(stars === 1 ? 'star' : 'stars'))) + (hospital.markerStatus ? '' : ' · ' + (stars==null ? t('Not rated in September 2025.') : t('Published September 2025; confirmed-criterion count not recorded.'))) + ' · ' + (hospital.markerDetail ?? (error ? t('Criterion coverage unavailable.') : data ? coverageText(data.hospitals[hospital.id] ?? emptyCoverage,t,language) : t('Loading criterion coverage…'))) + (hospital.markerError&&activity!=='error'?' · '+t('Latest attempt failed; previous finding retained'):'');
    return (
      <g key={hospital.id} data-audit-status={activity??'idle'}>
      <circle cx={cx} cy={cy} r={16*size} fill="transparent" aria-hidden="true" onClick={()=>onSelect(hospital)} style={{cursor:'pointer'}}/>
      <circle
        key={hospital.id}
        cx={cx}
        cy={cy}
        r={(active ? 6.5 : 4.5) * size}
        className={active ? "dot active" : "dot"}
        fill={activity==='error'?'transparent':hospital.markerColor ?? ratingByStars.get(stars).color}
        style={activity==='error'?{stroke:'transparent'}:activity==='unclear'?{stroke:'#a16207',strokeWidth:1.25*size}:undefined}
        role="button"
        aria-label={label+(activityLabel?' · '+t(activityLabel):'')}
        tabIndex={0}
        onMouseEnter={() => setHover(label+(activityLabel?' · '+t(activityLabel):''))}
        onMouseLeave={() => setHover(null)}
        onFocus={() => setHover(label+(activityLabel?' · '+t(activityLabel):''))}
        onBlur={() => setHover(null)}
        onClick={() => onSelect(hospital)}
        onKeyDown={(event) => {
          if (["Enter", " "].includes(event.key)) {
            event.preventDefault();
            onSelect(hospital);
          }
        }}
      >
        <title>{label}</title>
      </circle>
      {activity==='running'&&<circle className="hospital-audit-spinner" cx={cx} cy={cy} r={14*size} fill="none" stroke="#7e22ce" strokeWidth={2*size} strokeDasharray={`${16*size} ${9*size}`} pointerEvents="none" aria-hidden="true"/>}
      {activity==='error'&&<path className="hospital-error-cross" d={`M${cx-8*size},${cy-8*size}l${16*size},${16*size}m0,${-16*size}l${-16*size},${16*size}`} stroke="#b91c1c" strokeWidth={4*size} fill="none" pointerEvents="none" aria-hidden="true"/>}
      {hospital.markerError&&activity!=='error'&&<path className="hospital-error-badge" d={`M${cx+6*size},${cy-12*size}l${6*size},${6*size}m0,${-6*size}l${-6*size},${6*size}`} stroke="#b91c1c" strokeWidth={2*size} fill="none" pointerEvents="none" aria-hidden="true"/>}
      {!hospital.markerStatus&&['queued','completed','attention'].includes(activity)&&<circle cx={cx+11*size} cy={cy-10*size} r={4*size} fill={activity==='attention'?'#facc15':activity==='completed'?'#15803d':'#6b7280'} stroke={activity==='attention'?'#a16207':'none'} pointerEvents="none" aria-hidden="true"/>}
      </g>
    );
  });
}

/** Switch between statewide and full-size metro maps using the same source coordinates. */
export default function HospitalMap({ hospitals, counties, selected, onSelect }) {
  const { t, language } = useLocale();
  const [view, setView] = useState(initialView);
  const [region, setRegion] = useState("statewide");
  const [hover, setHover] = useState(null);
  const svg = useRef(null);
  const [markerScale,setMarkerScale]=useState(1);
  useEffect(()=>{
    // SVG viewBox scaling otherwise shrinks the dots to a few pixels on phones.
    const resize=()=>{if(!svg.current)return;const {width,height}=svg.current.getBoundingClientRect();if(width&&height)setMarkerScale(1/Math.min(width/900,height/555));};
    resize();const observer=new ResizeObserver(resize);observer.observe(svg.current);
    return()=>observer.disconnect();
  },[]);
  const drag = useRef(null);
  const moved = useRef(false);
  function switchRegion(nextRegion) {
    if (nextRegion === region) return;
    setRegion(nextRegion);
    setView(initialView);
    setHover(null);
    drag.current = null;
    moved.current = false;
  }
  function point(event) {
    return new DOMPoint(event.clientX, event.clientY).matrixTransform(
      svg.current.getScreenCTM().inverse(),
    );
  }
  function changeZoom(factor) {
    setView((old) => {
      const zoom = limit(old.zoom * factor, 1, 6);
      if (zoom === 1) return initialView;
      const ratio = zoom / old.zoom;
      return { zoom, x: 450 - (450 - old.x) * ratio, y: 277.5 - (277.5 - old.y) * ratio };
    });
  }
  function move(event) {
    if (!drag.current) return;
    const p = point(event);
    const { start, view: origin } = drag.current;
    const dx = p.x - start.x,
      dy = p.y - start.y;
    if (Math.hypot(dx, dy) < 2 && !moved.current) return;
    moved.current = true;
    svg.current.setPointerCapture(event.pointerId);
    setView({
      zoom: origin.zoom,
      x: limit(origin.x + dx, 900 * (1 - origin.zoom) - 30, 30),
      y: limit(origin.y + dy, 555 * (1 - origin.zoom) - 30, 30),
    });
  }
  function choose(hospital) {
    if (moved.current) return;
    setHover(null);
    onSelect(hospital);
  }
  const props = { selected, onSelect: choose, setHover, markerScale };
  const isMetro = region === "metro";
  const metroHospitals = hospitals.filter((h) => metroCounties.has(h.properties.county));
  const metroLand = counties.filter((c) => metroCounties.has(c.properties.NAME));
  const mapHospitals = isMetro ? metroHospitals : hospitals;
  return (
    <div className="map-panel" lang={language}>
      {!hospitals.some(h=>h.markerStatus)&&<p className="map-activity-legend">{t('Map activity: gray circle = queued; purple ring = running; green circle = completed; yellow circle = needs evidence review; red X = technical error. Main dot colors show the map rating, not execution success.')}</p>}
      <div className="map-view-bar">
        <div className="map-view-switch" role="group" aria-label={t('Map view')}>
          <button type="button" aria-pressed={!isMetro} onClick={() => switchRegion("statewide")}>{t('Statewide')}</button>
          <button type="button" aria-pressed={isMetro} onClick={() => switchRegion("metro")}>{t('NYC & Long Island')}</button>
        </div>
        <span className="map-view-count" role="status">{mapHospitals.length} {t('hospitals in this view')}</span>
      </div>
      <div className="viewport">
      <svg
        id="map"
        viewBox="0 0 900 555"
        ref={svg}
        className={view.zoom > 1 ? "zoomed" : ""}
        aria-label={t(isMetro ? 'New York City and Long Island hospital map' : 'New York hospital map with New York City and Long Island inset')}
        onPointerDown={(event) => {
          moved.current = false;
          if (view.zoom > 1 && event.button === 0) drag.current = { start: point(event), view };
        }}
        onPointerMove={move}
        onPointerUp={() => {
          drag.current = null;
        }}
        onPointerCancel={() => {
          drag.current = null;
        }}
        onKeyDown={() => {
          moved.current = false;
        }}
      >
        <g id={isMetro ? "metro-view" : "state-view"} transform={`translate(${view.x} ${view.y}) scale(${view.zoom})`}>
          <Land counties={isMetro ? metroLand : counties} project={isMetro ? metroFull : statewide} />
          {isMetro ? <Labels items={metroLabels} className="region" project={metroFull} /> : <>
            <Labels items={waters} className="water" />
          </>}
          <Points {...props} hospitals={mapHospitals} project={isMetro ? metroFull : statewide} zoom={view.zoom} />
        </g>
        {!isMetro && view.zoom === 1 && (
          <g id="metro-inset">
            <rect x="24" y="377" width="420" height="158" rx="4" className="inset-frame" />
            <text x="40" y="398" className="inset-title">
              {t('New York City & Long Island')}
            </text>
            <text x="427" y="397" textAnchor="end" className="inset-kicker">
              {t('METRO DETAIL')}
            </text>
            <defs>
              <clipPath id="inset-clip">
                <rect x="27" y="403" width="414" height="129" />
              </clipPath>
            </defs>
            <g clipPath="url(#inset-clip)">
              <Land
                counties={metroLand}
                project={metro}
              />
              <Points
                {...props}
                hospitals={metroHospitals}
                project={metro}
              />
            </g>
            <text x="426" y="525" textAnchor="end" className="inset-kicker">
              LONG ISLAND
            </text>
          </g>
        )}
        <g transform="translate(865 29)" fill="#466f65">
          <path d="M0 6l-4 13 4-2 4 2z" />
          <text y="2" textAnchor="middle" fontSize="10" fontWeight="bold">
            N
          </text>
        </g>
      </svg>
      <div className="controls">
        <button disabled={view.zoom === 6} onClick={() => changeZoom(1.65)}>
          {t('Zoom in')}
        </button>
        <button disabled={view.zoom === 1} onClick={() => changeZoom(1 / 1.65)}>
          {t('Zoom out')}
        </button>
        <button
          disabled={view.zoom === 1}
          onClick={() => setView(initialView)}
        >
          {t('Reset map view')}
        </button>
      </div>
      {hover && <div className="pin-tip">{hover}</div>}
      </div>
    </div>
  );
}
