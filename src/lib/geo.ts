import { area } from '@turf/area';
import { bbox } from '@turf/bbox';
import { bboxPolygon } from '@turf/bbox-polygon';
import { flatten } from '@turf/flatten';
import { mask } from '@turf/mask';
import { coordAll } from '@turf/meta';
import { rewind } from '@turf/rewind';
import {
  geoArea,
  geoBounds,
  geoConicConformal,
  geoEqualEarth,
  geoGraticule,
  geoMercator,
  geoPath,
  type GeoProjection
} from 'd3-geo';
import { fromArrayBuffer } from 'geotiff';
import type { Feature, FeatureCollection, GeoJsonProperties, Geometry, MultiPoint, Polygon } from 'geojson';
import type { GeoJsonInput } from './fastclip.ts';

/* ---- Constants ---- */

/** SVG user-space width. Height is derived from the data's projected shape. */
export const WIDTH = 1000;
/** Most bands the builder will ask for. */
export const MAX_BANDS = 60;
/** Max number of raster values kept to draw the range histogram. */
const SAMPLE_SIZE = 20000;
/** When deriving an interval from the data, aim for roughly this many bands. */
const TARGET_BANDS = 10;
/** Web Mercator's latitude limit: beyond this the projection runs off to infinity. */
const MERCATOR_MAX_LAT = 85.0511;
/** Smallest lon/lat span (degrees) we'll fit to, so a single point or a line doesn't give an infinite scale. */
const MIN_SPAN = 0.01;
/** Longest span (degrees) of a region that is worth centring across the antimeridian. */
const MAX_WRAPPED_SPAN = 180;

/** Bundled boundaries, served from /public (paths are relative to the builder page). */
export const BUILT_IN_SHAPES = [
  { id: 'world-simple', label: 'Continents', url: '../world-sm.geo.json' },
  { id: 'aus', label: 'Australia', url: '../aus-md.geo.json' },
  { id: 'aus-simple', label: 'Australia (Simplified)', url: '../aus-sm.geo.json' }
];

export const PROJECTIONS = [
  { id: 'australia', label: 'Australia (conic conformal)' },
  { id: 'equal-earth', label: 'Equal Earth' },
  { id: 'mercator', label: 'Web Mercator' }
] as const;

export type ProjectionId = (typeof PROJECTIONS)[number]['id'];
export const PROJECTION_IDS: readonly ProjectionId[] = PROJECTIONS.map((p) => p.id);

/** [west, south, east, north] in lon/lat degrees, the same order as turf's bbox. */
export type Bbox = [west: number, south: number, east: number, north: number];

/* ---- Numbers and bands ---- */

/** Strips floating point noise (0.30000000000000004 -> 0.3). */
export const tidy = (n: number) => Number(n.toPrecision(12));

/** Picks a 1/2/5/10 interval that gives roughly TARGET_BANDS bands across the range. */
export const niceInterval = (range: number) => {
  const raw = range / TARGET_BANDS;
  const pow = 10 ** Math.floor(Math.log10(raw));
  const f = raw / pow;
  return tidy((f <= 1 ? 1 : f <= 2 ? 2 : f <= 5 ? 5 : 10) * pow);
};

/** The epsilon stops float noise turning 11.000000000000002 bands into 12. */
export const bandCount = (min: number, max: number, interval: number) =>
  interval > 0 && max > min ? Math.ceil((max - min) / interval - 1e-9) : 0;

/** Sensible min/max/interval/neutral for a data range, snapped to the interval. */
export const rangeFor = ({ min, max }: { min: number; max: number }) => {
  if (max === min) {
    const floor = Math.floor(min);
    return { min: floor, max: floor + 1, interval: 1, neutral: floor + 0.5 };
  }
  const interval = niceInterval(max - min);
  const snappedMin = tidy(Math.floor(min / interval) * interval);
  const snappedMax = tidy(Math.ceil(max / interval) * interval);
  return { min: snappedMin, max: snappedMax, interval, neutral: tidy((snappedMin + snappedMax) / 2) };
};

/* ---- Raster inspection ---- */

export type Inspection = { min: number; max: number; values: number[]; bbox?: Bbox };

/** Reads band 1 of the GeoTIFF and returns its min/max plus an evenly strided sample of values, ignoring nodata. */
export const inspectTiff = async (buffer: ArrayBuffer): Promise<Inspection> => {
  const tiff = await fromArrayBuffer(buffer);
  const image = await tiff.getImage();
  const noData = image.getGDALNoData();
  const [raster] = (await image.readRasters({ samples: [0] })) as unknown as ArrayLike<number>[];

  const stride = Math.max(1, Math.ceil(raster.length / SAMPLE_SIZE));
  const { min, max, values } = Array.from(raster).reduce(
    (acc, v, i) => {
      // Skip NaN/Infinity, declared nodata, and common float sentinels like -3.4e38.
      if (!Number.isFinite(v) || v === noData || Math.abs(v) > 1e30) return acc;
      if (i % stride === 0) acc.values.push(v);
      return { min: Math.min(acc.min, v), max: Math.max(acc.max, v), values: acc.values };
    },
    { min: Infinity, max: -Infinity, values: [] as number[] }
  );
  if (min > max) throw new Error('The GeoTIFF contains no valid values in its first band.');

  // Geographic extent, used to choose a projection and frame an inverted crop. Only kept if it is plausibly
  // lon/lat degrees: a projected CRS (metres) or a 0-360 grid has the same shape but can't be compared with
  // the Australian region or the world frame, so it is treated the same as a file with no georeferencing.
  const bbox = (() => {
    try {
      const [x1, y1, x2, y2] = image.getBoundingBox();
      const [west, south, east, north] = [Math.min(x1, x2), Math.min(y1, y2), Math.max(x1, x2), Math.max(y1, y2)];
      const isDegrees = west >= -180 && east <= 180 && south >= -90 && north <= 90;
      return isDegrees ? ([west, south, east, north] as Bbox) : undefined;
    } catch {
      return undefined;
    }
  })();
  return { min, max, values, bbox };
};

/* ---- Polygon geometry ---- */

/**
 * d3-geo is spherical and wants exterior rings clockwise, holes anticlockwise (the opposite of the GeoJSON spec).
 * Wrong winding makes d3 treat a polygon as "the whole globe minus this shape".
 */
const windForD3 = (polygon: number[][][]): number[][][] =>
  (rewind({ type: 'Polygon', coordinates: polygon } as Polygon, { reverse: true }) as Polygon).coordinates;

/** The radius turf's `area` assumes, used to turn its square metres into steradians. */
const EARTH_RADIUS = 6378137;

const spanOf = (ring: number[][]) => Math.max(...ring.map((p) => p[0])) - Math.min(...ring.map((p) => p[0]));

/**
 * Winds a polygon for d3-geo. Planar winding (`windForD3`) is right for anything compact, but a ring that
 * wraps the globe (an ocean with the continents cut out, a strip circling Antarctica) is ambiguous:
 * in lon/lat the same ring can enclose either side, and d3 fills the wrong one, painting the whole map.
 * For wide polygons we measure d3's spherical area against the area the lon/lat shape should have,
 * and flip the winding if the complement is the closer match.
 */
const windForSphere = (polygon: number[][][]): number[][][] => {
  const wound = windForD3(polygon);
  if (spanOf(polygon[0]) < 180) return wound;

  // turf measures the lon/lat shape as drawn (holes subtracted, always the small side), which is what d3 should match.
  const expected = area({ type: 'Polygon', coordinates: polygon }) / EARTH_RADIUS ** 2;
  const measured = geoArea({ type: 'Polygon', coordinates: wound });
  const flipped = 4 * Math.PI - measured;
  return Math.abs(measured - expected) <= Math.abs(flipped - expected) ? wound : wound.map((ring) => [...ring].reverse());
};

/**
 * Exterior rings smaller than this (square metres, roughly 12 km²) are dropped as clipping debris. Where
 * two shapes meet, clippers leave near-collinear slivers; their planar winding is meaningless on the sphere
 * (great-circle edges bow the other way), so d3 reads them as "the whole globe minus this" and fills the map.
 */
const MIN_POLYGON_AREA = 12e6;

/**
 * Cleans one polygon for drawing: drops degenerate rings (fewer than 4 positions can't enclose
 * anything; clippers sometimes emit them) and slivers, and fixes winding. Returns undefined if no usable exterior is left.
 */
export const preparePolygon = (polygon: number[][][]): number[][][] | undefined => {
  if (!(polygon[0]?.length >= 4) || area({ type: 'Polygon', coordinates: [polygon[0]] }) < MIN_POLYGON_AREA) return undefined;
  return windForSphere(polygon.filter((ring, i) => i === 0 || ring.length >= 4));
};

/** Collects every polygon ([exterior, ...holes]) from any GeoJSON input: collections, features, geometries. */
export const collectPolygons = (input: unknown): number[][][][] => {
  if (!input) return [];
  return flatten(input as Parameters<typeof flatten>[0]).features.flatMap((feature) =>
    feature.geometry?.type === 'Polygon' ? [feature.geometry.coordinates] : []
  );
};

/** Clamps every latitude in a coordinate array to Web Mercator's limit. Vertices at +/-90 otherwise project to Infinity/NaN. */
const clampLatitudes = (c: any): any =>
  typeof c[0] === 'number' ? [c[0], Math.max(-MERCATOR_MAX_LAT, Math.min(MERCATOR_MAX_LAT, c[1])), ...c.slice(2)] : c.map(clampLatitudes);

/**
 * Builds the "everything except this shape" polygon: a frame with each of the shape's polygons cut out as
 * a hole, plus any holes *in* the shape (lakes, say) added back as islands. The frame covers the shape and
 * the raster (or the whole world if the raster isn't georeferenced), padded so no hole touches its edge.
 * Built as one polygon so it works with any clipper that handles holes. Follows RFC 7946 winding: frame
 * anticlockwise, holes clockwise.
 */
export const invertShape = (shape: unknown, rasterBbox: Bbox = [-180, -90, 180, 90]) => {
  const polygons = collectPolygons(shape);
  if (!polygons.length) return { problem: 'That shape has no polygons, so it cannot be inverted.' } as const;

  const [shapeWest, shapeSouth, shapeEast, shapeNorth] = bbox({ type: 'MultiPolygon', coordinates: polygons });
  const [w, s, e, n] = rasterBbox;
  const PAD = 1;
  const frame: Bbox = [Math.min(shapeWest, w) - PAD, Math.min(shapeSouth, s) - PAD, Math.max(shapeEast, e) + PAD, Math.max(shapeNorth, n) + PAD];

  // turf's mask unions the shapes and punches their outer rings out of the frame, but drops their own holes.
  const frameWithHoles = mask({ type: 'MultiPolygon', coordinates: polygons }, bboxPolygon(frame)).geometry.coordinates;
  const islands = polygons.flatMap((polygon) => polygon.slice(1).map((ring) => [ring]));

  const inverted = {
    type: 'FeatureCollection',
    features: [
      {
        type: 'Feature',
        properties: {},
        geometry: rewind({ type: 'MultiPolygon', coordinates: [frameWithHoles, ...islands] })
      }
    ]
  } as unknown as GeoJsonInput;
  return { shape: inverted, frame, holes: frameWithHoles.length - 1 } as const;
};

/* ---- Projection ---- */

// Every projection is fitted the same way: from the planar lon/lat *vertices* of the geometry
// being drawn, never from the polygons themselves. d3's fit*, geoBounds and geoCentroid work on
// the sphere, where a ring wound the "wrong" way means "everything except this shape". One such
// ring (easy to get out of a clipper) makes the fit cover the whole globe. Fitting to points
// can't be fooled by winding.

type ProjectionBuilder = {
  /** Returns a fresh, unfitted projection. `centreLon` is the data's centre longitude. */
  create: (centreLon: number) => GeoProjection;
  /** True if the projection can't take polar vertices (Web Mercator), so latitudes are clamped first. */
  clampLatitudes?: boolean;
  /** [south, north] latitudes that make up "the whole world" for this projection. Defaults to [-90, 90]. */
  worldLatitudes?: [number, number];
};

/** How to create each projection (unfitted). Adding a ProjectionId forces an entry here. */
export const PROJECTION_BUILDERS: Record<ProjectionId, ProjectionBuilder> = {
  // Conformal cones blow up towards the pole on the far side of their parallels, so stop short of it.
  australia: { create: () => geoConicConformal().parallels([-18, -36]).rotate([-134, 0]), worldLatitudes: [-90, 60] },
  'equal-earth': { create: (centreLon) => geoEqualEarth().rotate([-centreLon, 0]) },
  mercator: {
    create: (centreLon) => geoMercator().rotate([-centreLon, 0]),
    clampLatitudes: true,
    worldLatitudes: [-MERCATOR_MAX_LAT, MERCATOR_MAX_LAT]
  }
};

/** Every finite [lon, lat] vertex in a collection. */
const finitePoints = (collection: FeatureCollection) =>
  coordAll(collection).filter(([lon, lat]) => Number.isFinite(lon) && Number.isFinite(lat));

/**
 * The longitude to centre a map of the data on, for projections that rotate (Equal Earth, Mercator).
 * d3 cuts the map at the antimeridian opposite the rotation, so this has to be chosen before projecting.
 *
 * Defaults to the middle of the plain west-east extent, which puts world-spanning data on the Greenwich
 * side as expected. Only when the data is a compact region that crosses the antimeridian (Fiji, NZ's
 * Chatham Islands, Alaska's Aleutians...) does it centre on the wrapped arc d3's `geoBounds` finds instead;
 * otherwise such data would be split across both edges of the map.
 *
 * "Compact" matters: for world-spanning data the smallest arc just routes around whichever interior gap
 * is widest (e.g. the Pacific), which would wrongly centre the map on the antimeridian.
 *
 * Measured on the vertices as a MultiPoint, because `geoBounds` on polygons depends on their winding.
 */
export const centreLongitude = (collection: FeatureCollection) => {
  const points = finitePoints(collection);
  if (!points.length) return 0;
  const vertices: MultiPoint = { type: 'MultiPoint', coordinates: points };

  const [planarWest, , planarEast] = bbox(vertices);
  const [[wrappedWest], [wrappedEast]] = geoBounds(vertices);
  const wrappedSpan = wrappedEast >= wrappedWest ? wrappedEast - wrappedWest : wrappedEast - wrappedWest + 360;

  const wrap = planarEast - planarWest > MAX_WRAPPED_SPAN && wrappedSpan <= MAX_WRAPPED_SPAN;
  const centre = wrap ? wrappedWest + wrappedSpan / 2 : (planarWest + planarEast) / 2;
  return ((centre + 540) % 360) - 180;
};

/**
 * Creates the chosen projection fitted to `width`, plus the SVG height that fits the result.
 * `centreLon` is the longitude the map is centred on (see `centreLongitude`); projections with a fixed
 * centre, like the Australian conic, ignore it. Returns undefined if there's nothing finite to fit to.
 */
export const fitProjection = (id: ProjectionId, collection: FeatureCollection, wholeWorld: boolean, width = WIDTH, centreLon = 0) => {
  const points = finitePoints(collection);
  if (!points.length) return undefined;

  const [west, south, east, north] = bbox({ type: 'MultiPoint', coordinates: points });

  // Pad degenerate extents (one point, a straight N-S or E-W line) so the fit has something to scale to.
  const isDegenerate = east - west < MIN_SPAN || north - south < MIN_SPAN;
  const lat = (north + south) / 2;
  const padding = isDegenerate ? [[centreLon - MIN_SPAN / 2, lat - MIN_SPAN / 2], [centreLon + MIN_SPAN / 2, lat + MIN_SPAN / 2]] : [];

  // The world's edge, as vertices (d3's graticule outline) between the projection's usable latitudes.
  const [worldSouth, worldNorth] = PROJECTION_BUILDERS[id].worldLatitudes ?? [-90, 90];
  const target: MultiPoint = {
    type: 'MultiPoint',
    coordinates: wholeWorld
      ? geoGraticule().extent([[-180, worldSouth], [180, worldNorth]]).outline().coordinates[0]
      : [...points, ...padding]
  };

  // Fresh projection each time: fit* mutates it. fitWidth scales to `width` and pins the top of
  // the shape to y=0, so the bottom edge is the height we need.
  const projection = PROJECTION_BUILDERS[id].create(centreLon).fitWidth(width, target);
  const [, [, bottom]] = geoPath(projection).bounds(target);
  const height = Math.ceil(bottom);

  if (!Number.isFinite(projection.scale()) || !Number.isFinite(height)) return undefined;
  return { projection, height: Math.max(1, height) };
};

/* ---- Styling and layout ---- */

const str = (v: unknown, fallback: string) => (typeof v === 'string' && v ? v : fallback);
const num = (v: unknown, fallback: number) => {
  const n = typeof v === 'string' ? Number(v) : v;
  return typeof n === 'number' && Number.isFinite(n) ? n : fallback;
};

/**
 * Reads simplestyle-spec properties off a feature. Fill defaults follow the spec
 * (#555555 at 0.6 opacity). Unlike the spec, stroke defaults to none, so bands
 * only get an outline if the data asks for one.
 */
export const simplestyle = (p: GeoJsonProperties) => ({
  fill: str(p?.fill, '#555555'),
  fillOpacity: num(p?.['fill-opacity'], 0.6),
  stroke: str(p?.stroke, 'none'),
  strokeOpacity: num(p?.['stroke-opacity'], 1),
  strokeWidth: num(p?.['stroke-width'], 2)
});

export type LayoutPath = { d: string } & ReturnType<typeof simplestyle>;
export type Layout = { width: number; height: number; paths: LayoutPath[] };

type BuildLayoutOptions = {
  bands?: FeatureCollection;
  projection: ProjectionId;
  /** Fit to the whole globe instead of the data's extent. */
  wholeWorld?: boolean;
  width?: number;
  /** Longitude to centre the map on, for projections that rotate. Defaults to Greenwich. See `centreLongitude`. */
  centreLon?: number;
};

/**
 * Projects bands to SVG paths. The height comes from the data's projected shape, so the aspect
 * ratio is never fixed. Returns undefined when there's nothing drawable.
 */
export const buildLayout = ({ bands, projection, wholeWorld = false, width = WIDTH, centreLon }: BuildLayoutOptions): Layout | undefined => {
  if (!bands?.features.length) return undefined;
  const clamp = !!PROJECTION_BUILDERS[projection].clampLatitudes;

  // Prepare the geometry: drop degenerate polygons, fix winding, clamp latitudes if the projection needs it.
  const prepareGeometry = (g: Geometry): Geometry | undefined => {
    if (g?.type === 'Polygon') {
      const polygon = preparePolygon(g.coordinates);
      return polygon && { ...g, coordinates: polygon };
    }
    if (g?.type === 'MultiPolygon') {
      const polygons = g.coordinates.map(preparePolygon).filter((p): p is number[][][] => !!p);
      return polygons.length ? { ...g, coordinates: polygons } : undefined;
    }
    return g;
  };
  const features = bands.features.flatMap((f): Feature[] => {
    const prepared = prepareGeometry(f.geometry);
    if (!prepared) return [];
    const geometry = clamp && 'coordinates' in prepared ? ({ ...prepared, coordinates: clampLatitudes(prepared.coordinates) } as Geometry) : prepared;
    return [{ ...f, geometry }];
  });
  if (!features.length) return undefined;

  const collection: FeatureCollection = { type: 'FeatureCollection', features };
  const fit = fitProjection(projection, collection, wholeWorld, width, centreLon);
  if (!fit) return undefined;

  const toPath = geoPath(fit.projection);
  const paths = features.map((feature) => ({ d: toPath(feature) ?? '', ...simplestyle(feature.properties) }));
  return { width, height: fit.height, paths };
};

/* ---- Export ---- */

const escapeAttr = (s: string) => s.replace(/&/g, '&amp;').replace(/"/g, '&quot;').replace(/</g, '&lt;');

/** Serialises a layout as a standalone SVG, scaled to `outputWidth` pixels. */
export const buildSvg = ({ width, height, paths }: Layout, outputWidth = width) => {
  const outputHeight = Math.round((outputWidth * height) / width);
  const body = paths
    .map(
      (p) =>
        `<path d="${p.d}" fill="${escapeAttr(p.fill)}" fill-opacity="${p.fillOpacity}" stroke="${escapeAttr(p.stroke)}" stroke-opacity="${p.strokeOpacity}" stroke-width="${p.strokeWidth}"/>`
    )
    .join('\n');
  return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${width} ${height}" width="${outputWidth}" height="${outputHeight}">\n${body}\n</svg>`;
};
