import React, { memo, useRef, useState } from "react";
import { countyPath, metro, metroCounties, statewide } from "./geometry.js";
import { ratingByStars } from "./ratings.js";

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

function Labels({ items, className }) {
  return items.map(([name, longitude, latitude]) => {
    const [x, y] = statewide([longitude, latitude]);
    return (
      <text key={name} x={x} y={y} className={className}>
        {name}
      </text>
    );
  });
}

function Points({ hospitals, project, zoom = 1, selected, onSelect, setHover }) {
  return hospitals.map((hospital) => {
    const [cx, cy] = project(hospital.geometry.coordinates);
    const { stars, name } = hospital.properties;
    const active = selected?.id === hospital.id;
    const label = name + " · " + stars + " stars";
    return (
      <circle
        key={hospital.id}
        cx={cx}
        cy={cy}
        r={(active ? 5.4 : 3.65) / zoom}
        className={active ? "dot active" : "dot"}
        fill={ratingByStars.get(stars).color}
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

/** Draw both views from the same WGS 84 points and keep pan and zoom local to the map. */
export default function HospitalMap({ hospitals, counties, selected, onSelect }) {
  const [view, setView] = useState(initialView);
  const [hover, setHover] = useState(null);
  const svg = useRef(null);
  const drag = useRef(null);
  const moved = useRef(false);
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
  return (
    <div className="viewport">
      <svg
        id="map"
        viewBox="0 0 900 555"
        ref={svg}
        className={view.zoom > 1 ? "zoomed" : ""}
        aria-label="New York hospital map with New York City and Long Island inset"
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
        <g id="state-view" transform={`translate(${view.x} ${view.y}) scale(${view.zoom})`}>
          <Land counties={counties} project={statewide} />
          <Labels items={regions} className="region" />
          <Labels items={waters} className="water" />
          <Points {...props} hospitals={hospitals} project={statewide} zoom={view.zoom} />
        </g>
        {view.zoom === 1 && (
          <g id="metro-inset">
            <rect x="24" y="377" width="420" height="158" rx="4" className="inset-frame" />
            <text x="40" y="398" className="inset-title">
              New York City &amp; Long Island
            </text>
            <text x="427" y="397" textAnchor="end" className="inset-kicker">
              METRO DETAIL
            </text>
            <defs>
              <clipPath id="inset-clip">
                <rect x="27" y="403" width="414" height="129" />
              </clipPath>
            </defs>
            <g clipPath="url(#inset-clip)">
              <Land
                counties={counties.filter((c) => metroCounties.has(c.properties.NAME))}
                project={metro}
              />
              <Points
                {...props}
                hospitals={hospitals.filter((h) => metroCounties.has(h.properties.county))}
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
        <button aria-label="Zoom in" disabled={view.zoom === 6} onClick={() => changeZoom(1.65)}>
          +
        </button>
        <button aria-label="Zoom out" disabled={view.zoom === 1} onClick={() => changeZoom(1 / 1.65)}>
          −
        </button>
        <button
          aria-label="Reset map view"
          disabled={view.zoom === 1}
          onClick={() => setView(initialView)}
        >
          ⌂
        </button>
      </div>
      {hover && <div className="pin-tip">{hover}</div>}
    </div>
  );
}
