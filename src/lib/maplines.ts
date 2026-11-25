import { geoPath, type GeoProjection } from 'd3-geo';
import type { GeoJSON } from 'geojson';

/* ---- Types ---- */

/** A set of lines drawn on top of a map, e.g. state borders or roads. Widths are CSS pixels at any map size. */
export type MapLineLayer = {
  id: string;
  lines: GeoJSON;
  stroke: string;
  strokeOpacity: number;
  strokeWidth: number;
};

export type ProjectedLineLayer = Omit<MapLineLayer, 'lines'> & { d: string };

/* ---- Styles ---- */

/** Lines are white at 20% opacity, so they read on every band without competing with the colours. */
const LINE_STROKE = '#ffffff';
const LINE_OPACITY = 0.2;

/* ---- Loading ---- */

/**
 * URL of a file in /public. In a build, modules live in `modules/` and public files sit beside that folder,
 * so it resolves from the module's own URL: the app can be mounted in an article on another host, where a
 * page-relative URL would point at the article. The dev server serves /public from its root.
 */
const publicFileUrl = (filename: string) =>
  import.meta.env.DEV ? `/${filename}` : new URL(`../${filename}`, moduleUrl).href;

/** Held in a variable so Vite doesn't treat `new URL(…, import.meta.url)` as a src asset and glob `src/` for it. */
const moduleUrl = import.meta.url;

const fetchJson = (filename: string): Promise<GeoJSON> =>
  fetch(publicFileUrl(filename)).then(response => {
    if (!response.ok) throw new Error(`${response.status} ${response.statusText} for ${filename}`);
    return response.json();
  });

let ausLineLayers: Promise<MapLineLayer[]> | undefined;

/**
 * Roads, then state borders on top. Borders only cover the lines between mainland states (no coastlines).
 * Fetched once and shared by every panel.
 */
export const loadAusLineLayers = () =>
  (ausLineLayers ??= Promise.all([fetchJson('aus-roads.geo.json'), fetchJson('aus-states.geo.json')]).then(
    ([roads, stateBorders]) => [
      { id: 'roads', lines: roads, stroke: LINE_STROKE, strokeOpacity: LINE_OPACITY, strokeWidth: 0.5 },
      { id: 'state-borders', lines: stateBorders, stroke: LINE_STROKE, strokeOpacity: LINE_OPACITY, strokeWidth: 1 }
    ]
  ));

/* ---- Projecting ---- */

/** Projects each layer to one SVG path with the map's own fitted projection. Empty layers are dropped. */
export const projectLineLayers = (projection: GeoProjection, layers: MapLineLayer[]): ProjectedLineLayer[] => {
  const toPath = geoPath(projection);
  return layers.flatMap(({ lines, ...style }) => {
    const d = toPath(lines);
    return d ? [{ ...style, d }] : [];
  });
};
