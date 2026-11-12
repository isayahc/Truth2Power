import React, { memo, useRef, useState } from "react";
import { countyPath, metro, metroFull, metroCounties, statewide } from "./geometry.js";
import { ratingByStars } from "./ratings.js";
import { useLocale } from './locale.jsx';

const regions = [
  ["Western NY", -78.75, 42.46],
  ["Finger Lakes", -77.15, 42.8],
  ["North Country", -74.4, 44.46],
  ["Mohawk Valley", -74.7, 43.39],
  ["Southern Tier", -76.7, 42.17],
  ["Capital Region", -73.89, 42.83],
  ["Mid-Hudson", -74.27, 41.79],
];
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

function Points({ hospitals, project, zoom = 1, selected, onSelect, setHover }) {
  const { t } = useLocale();
  return hospitals.map((hospital) => {
    const [cx, cy] = project(hospital.geometry.coordinates);
    const { stars, name } = hospital.properties;
    const active = selected?.id === hospital.id;
    const label = name + " · " + (hospital.markerLabel ?? stars + ' ' + t(stars === 1 ? 'star' : 'stars'));
    return (
      <circle
        key={hospital.id}
        cx={cx}
        cy={cy}
        r={(active ? 5.4 : 3.65) / zoom}
        className={active ? "dot active" : "dot"}
        fill={hospital.markerColor ?? ratingByStars.get(stars).color}
        role="button"
        aria-label={label}
        tabIndex={0}
        onMouseEnter={() => setHover(label)}
        onMouseLeave={() => setHover(null)}
        onFocus={() => setHover(label)}
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
  const props = { selected, onSelect: choose, setHover };
  const isMetro = region === "metro";
  const metroHospitals = hospitals.filter((h) => metroCounties.has(h.properties.county));
  const metroLand = counties.filter((c) => metroCounties.has(c.properties.NAME));
  const mapHospitals = isMetro ? metroHospitals : hospitals;
  return (
    <div className="map-panel" lang={language}>
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
            <Labels items={regions} className="region" />
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
