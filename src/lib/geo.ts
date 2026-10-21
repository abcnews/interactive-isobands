import { geoArea, geoConicConformal, geoEqualEarth, geoMercator, geoPath, type GeoProjection } from 'd3-geo';
import { fromArrayBuffer } from 'geotiff';
import type { Feature, FeatureCollection, GeoJsonProperties, Geometry, MultiPoint } from 'geojson';
import type { GeoJsonInput } from './fastclip.ts';

/* ---- Logging ---- */

// Stringified so the details can be copied out of the console.
const log = (message: string, details: unknown = {}) => console.debug(`[isobands] ${message} ${JSON.stringify(details)}`);
const warn = (message: string, details: unknown = {}) => console.warn(`[isobands] ${message} ${JSON.stringify(details)}`);

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
/** Spacing (degrees) of the sample points along the world's edge. */
const WORLD_STEP = 5;
/** Longest span (degrees) of a region that is worth centring across the antimeridian. */
const MAX_WRAPPED_SPAN = 180;

/**
 * Data that sits entirely inside this lon/lat box (degrees) counts as "around Australia" and keeps
 * the Australian conic projection. Padded beyond the continent so offshore grids still qualify.
 */
export const AUSTRALIA_REGION = { west: 100, south: -55, east: 175, north: 0 };

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

export type Bbox = [west: number, south: number, east: number, north: number];
type Extent = { west: number; south: number; east: number; north: number };

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
  log('geotiff', { width: image.getWidth(), height: image.getHeight(), bands: image.getSamplesPerPixel(), noData });
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

  // Geographic extent, used to choose a projection. Not fatal if the file has no georeferencing.
  const bbox = (() => {
    try {
      const [x1, y1, x2, y2] = image.getBoundingBox();
      return [Math.min(x1, x2), Math.min(y1, y2), Math.max(x1, x2), Math.max(y1, y2)] as Bbox;
    } catch (e) {
      log('no bounding box', { error: String(e) });
      return undefined;
    }
  })();
  return { min, max, values, bbox };
};

/* ---- Polygon geometry ---- */

/** Shoelace sum over lon/lat: > 0 means clockwise (y up). */
export const area = (ring: number[][]) =>
  ring.reduce((sum, [x, y], i) => sum + (ring[(i + 1) % ring.length][0] - x) * (ring[(i + 1) % ring.length][1] + y), 0);

/**
 * d3-geo is spherical and wants exterior rings clockwise, holes anticlockwise (the opposite of the GeoJSON spec).
 * Wrong winding makes d3 treat a polygon as "the whole globe minus this shape".
 */
export const rewind = (polygon: number[][][]) =>
  polygon.map((ring, i) => ((area(ring) > 0) === (i === 0) ? ring : [...ring].reverse()));

/** Returns the ring wound clockwise or anticlockwise (y up), reversing it if needed. */
export const orient = (ring: number[][], clockwise: boolean) => ((area(ring) > 0) === clockwise ? ring : [...ring].reverse());

/** Sphere area (steradians) of a lon/lat ring as an equal-area cylindrical shape: planar area in (lon, sin lat). */
const cylindricalArea = (ring: number[][]) =>
  Math.abs(
    ring.reduce((sum, [lon, lat], i) => {
      const [nextLon, nextLat] = ring[(i + 1) % ring.length];
      return sum + ((nextLon - lon) * (Math.sin((lat * Math.PI) / 180) + Math.sin((nextLat * Math.PI) / 180))) / 2;
    }, 0) *
      (Math.PI / 180)
  );

const spanOf = (ring: number[][]) => Math.max(...ring.map((p) => p[0])) - Math.min(...ring.map((p) => p[0]));

/**
 * Winds a polygon for d3-geo. Planar winding (`rewind`) is right for anything compact, but a ring that
 * wraps the globe (an ocean with the continents cut out, a strip circling Antarctica) is ambiguous:
 * in lon/lat the same ring can enclose either side, and d3 fills the wrong one, painting the whole map.
 * For wide polygons we measure d3's spherical area against the area the lon/lat shape should have,
 * and flip the winding if the complement is the closer match.
 */
const windForSphere = (polygon: number[][][]): number[][][] => {
  const wound = rewind(polygon);
  if (spanOf(polygon[0]) < 180) return wound;

  const expected = polygon.reduce((sum, ring, i) => sum + (i === 0 ? 1 : -1) * cylindricalArea(ring), 0);
  const measured = geoArea({ type: 'Polygon', coordinates: wound });
  const flipped = 4 * Math.PI - measured;
  return Math.abs(measured - expected) <= Math.abs(flipped - expected) ? wound : wound.map((ring) => [...ring].reverse());
};

/**
 * Exterior rings smaller than this (square degrees, roughly 12 km²) are dropped as clipping debris. Where
 * two shapes meet, clippers leave near-collinear slivers; their planar winding is meaningless on the sphere
 * (great-circle edges bow the other way), so d3 reads them as "the whole globe minus this" and fills the map.
 */
const MIN_POLYGON_AREA = 1e-3;

/**
 * Cleans one polygon for drawing: drops degenerate rings (fewer than 4 positions can't enclose
 * anything; clippers sometimes emit them) and slivers, and fixes winding. Returns undefined if no usable exterior is left.
 */
export const preparePolygon = (polygon: number[][][]): number[][][] | undefined => {
  if (!(polygon[0]?.length >= 4) || Math.abs(area(polygon[0])) / 2 < MIN_POLYGON_AREA) return undefined;
  return windForSphere(polygon.filter((ring, i) => i === 0 || ring.length >= 4));
};

/** Collects every polygon ([exterior, ...holes]) from any GeoJSON input: collections, features, geometries. */
export const collectPolygons = (input: any): number[][][][] => {
  if (!input) return [];
  switch (input.type) {
    case 'FeatureCollection':
      return (input.features ?? []).flatMap(collectPolygons);
    case 'Feature':
      return collectPolygons(input.geometry);
    case 'GeometryCollection':
      return (input.geometries ?? []).flatMap(collectPolygons);
    case 'Polygon':
      return [input.coordinates];
    case 'MultiPolygon':
      return input.coordinates;
    default:
      return [];
  }
};

/** Clamps every latitude in a coordinate array to Web Mercator's limit. Vertices at +/-90 otherwise project to Infinity/NaN. */
const clampLatitudes = (c: any): any =>
  typeof c[0] === 'number' ? [c[0], Math.max(-MERCATOR_MAX_LAT, Math.min(MERCATOR_MAX_LAT, c[1])), ...c.slice(2)] : c.map(clampLatitudes);

/** Flattens every finite [lon, lat] vertex out of a collection, counting any that were skipped as non-finite. */
export const collectPoints = (collection: FeatureCollection) => {
  const points: number[][] = [];
  let skipped = 0;
  const walk = (c: any) => {
    if (typeof c[0] !== 'number') return c.forEach(walk);
    if (Number.isFinite(c[0]) && Number.isFinite(c[1])) points.push(c);
    else skipped++;
  };
  collection.features.forEach((f) => 'coordinates' in f.geometry && walk(f.geometry.coordinates));
  return { points, skipped };
};

export const extentOf = (points: number[][]): Extent =>
  points.reduce<Extent>(
    (e, [lon, lat]) => ({
      west: Math.min(e.west, lon),
      east: Math.max(e.east, lon),
      south: Math.min(e.south, lat),
      north: Math.max(e.north, lat)
    }),
    { west: Infinity, south: Infinity, east: -Infinity, north: -Infinity }
  );

/** True if the extent is plausibly lon/lat degrees (a projected CRS or 0-360 grid can't be compared). */
export const looksLikeDegrees = ([west, south, east, north]: Bbox) =>
  west >= -180 && east <= 180 && south >= -90 && north <= 90;

/**
 * Builds the "everything except this shape" polygon: a frame with each of the shape's polygons cut out as
 * a hole, plus any holes *in* the shape (lakes, say) added back as islands. The frame covers the shape and
 * the raster (or the whole world if the raster isn't georeferenced), padded so no hole touches its edge.
 * Built as one polygon so it works with any clipper that handles holes. Follows RFC 7946 winding: frame
 * anticlockwise, holes clockwise.
 */
export const invertShape = (shape: unknown, bbox: Bbox | undefined) => {
  const polygons = collectPolygons(shape);
  if (!polygons.length) return { problem: 'That shape has no polygons, so it cannot be inverted.' } as const;

  const { points } = collectPoints({
    type: 'FeatureCollection',
    features: polygons.map((coordinates) => ({ type: 'Feature', properties: {}, geometry: { type: 'Polygon', coordinates } }))
  });
  const shapeExtent = extentOf(points);
  const [w, s, e, n] = bbox && looksLikeDegrees(bbox) ? bbox : [-180, -90, 180, 90];
  const PAD = 1;
  const west = Math.min(shapeExtent.west, w) - PAD;
  const south = Math.min(shapeExtent.south, s) - PAD;
  const east = Math.max(shapeExtent.east, e) + PAD;
  const north = Math.max(shapeExtent.north, n) + PAD;

  const frame = [
    [west, south],
    [east, south],
    [east, north],
    [west, north],
    [west, south]
  ];
  const holes = polygons.map((polygon) => orient(polygon[0], true));
  const islands = polygons.flatMap((polygon) => polygon.slice(1).map((ring) => [orient(ring, false)]));

  const inverted = {
    type: 'FeatureCollection',
    features: [
      {
        type: 'Feature',
        properties: {},
        geometry: { type: 'MultiPolygon', coordinates: [[orient(frame, false), ...holes], ...islands] }
      }
    ]
  } as unknown as GeoJsonInput;
  return { shape: inverted, frame: { west, south, east, north }, holes: holes.length } as const;
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

/** Picks the starting projection for a dataset: Australian conic if it's around Australia, otherwise Equal Earth. */
export const defaultProjectionFor = (bbox: Bbox | undefined): ProjectionId => {
  if (!bbox || !looksLikeDegrees(bbox)) return 'equal-earth';
  const [west, south, east, north] = bbox;
  const region = AUSTRALIA_REGION;
  const inRegion = west >= region.west && east <= region.east && south >= region.south && north <= region.north;
  return inRegion ? 'australia' : 'equal-earth';
};

/** Points tracing the edge of the whole world (lon -180..180) between two latitudes. Enough for d3 to fit to. */
export const worldOutline = ([south, north]: [number, number]): number[][] => {
  const lons = Array.from({ length: 360 / WORLD_STEP + 1 }, (_, i) => -180 + i * WORLD_STEP);
  const firstLat = Math.ceil(south / WORLD_STEP) * WORLD_STEP;
  const lats = Array.from({ length: Math.max(0, Math.floor((north - firstLat) / WORLD_STEP) + 1) }, (_, i) => firstLat + i * WORLD_STEP);
  return [
    ...lons.flatMap((lon) => [[lon, south], [lon, north]]),
    ...lats.flatMap((lat) => [[-180, lat], [180, lat]]),
    [-180, south],
    [180, south],
    [-180, north],
    [180, north]
  ];
};

/**
 * The longitude to centre the map on. Defaults to the middle of the plain west-east extent, which puts
 * world-spanning data on the Greenwich side as expected. Only when the data is a compact region that
 * crosses the antimeridian (Fiji, NZ's Chatham Islands, Alaska's Aleutians...) does it centre on the
 * wrapped arc instead; otherwise such data would be split across both edges of the map.
 *
 * "Compact" matters: for world-spanning data the smallest arc just routes around whichever interior gap
 * is widest (e.g. the Pacific), which would wrongly centre the map on the antimeridian.
 */
export const centreLongitude = (points: number[][]) => {
  if (!points.length) return { centre: 0, mode: 'empty' as const, planarSpan: 0, wrappedSpan: 0 };
  const lons = Float64Array.from(points, (p) => p[0]).sort();
  const west = lons[0];
  const east = lons[lons.length - 1];
  const planarSpan = east - west;
  const planarCentre = (west + east) / 2;

  // Widest empty gap between neighbouring longitudes, counting the one across the antimeridian.
  const { widestGap, wrappedCentre } = Array.from(lons.slice(1), (lon, i) => ({ gap: lon - lons[i], mid: (lon + lons[i] + 360) / 2 })).reduce(
    (best, { gap, mid }) => (gap > best.widestGap ? { widestGap: gap, wrappedCentre: mid } : best),
    { widestGap: west + 360 - east, wrappedCentre: planarCentre }
  );
  const wrappedSpan = 360 - widestGap;

  const wrap = planarSpan > MAX_WRAPPED_SPAN && wrappedSpan <= MAX_WRAPPED_SPAN;
  const centre = wrap ? wrappedCentre : planarCentre;
  return {
    centre: ((centre + 540) % 360) - 180,
    mode: wrap ? ('wrapped' as const) : ('planar' as const),
    planarSpan,
    wrappedSpan
  };
};

/**
 * Creates the chosen projection fitted to `width`, plus the SVG height that fits the result.
 * Returns undefined (after logging why) if there's nothing finite to fit to.
 */
export const fitProjection = (id: ProjectionId, collection: FeatureCollection, wholeWorld: boolean, width = WIDTH) => {
  const { points, skipped } = collectPoints(collection);
  if (skipped) warn('skipped non-finite vertices', { skipped });
  if (!points.length) {
    warn('nothing to fit: no finite vertices', { projection: id });
    return undefined;
  }

  const extent = extentOf(points);

  // "Whole world": a fixed frame, centred on Greenwich, however much of the globe the (possibly cropped)
  // bands cover. Without it the frame follows the data, so a crop that drops Antarctica would zoom the map.
  const { centre: centreLon } = wholeWorld ? { centre: 0 } : centreLongitude(points);

  // Pad degenerate extents (one point, a straight N-S or E-W line) so the fit has something to scale to.
  const isDegenerate = extent.east - extent.west < MIN_SPAN || extent.north - extent.south < MIN_SPAN;
  const lat = (extent.north + extent.south) / 2;
  const padding = isDegenerate ? [[centreLon - MIN_SPAN / 2, lat - MIN_SPAN / 2], [centreLon + MIN_SPAN / 2, lat + MIN_SPAN / 2]] : [];
  if (isDegenerate && !wholeWorld) warn('degenerate extent padded', extent);

  const target: MultiPoint = {
    type: 'MultiPoint',
    coordinates: wholeWorld ? worldOutline(PROJECTION_BUILDERS[id].worldLatitudes ?? [-90, 90]) : [...points, ...padding]
  };

  // Fresh projection each time: fit* mutates it. fitWidth scales to `width` and pins the top of
  // the shape to y=0, so the bottom edge is the height we need.
  const projection = PROJECTION_BUILDERS[id].create(centreLon).fitWidth(width, target);
  const [, [, bottom]] = geoPath(projection).bounds(target);
  const height = Math.ceil(bottom);
  log('fit', { projection: id, wholeWorld, vertices: points.length, extent, centreLon, scale: projection.scale(), height });

  if (!Number.isFinite(projection.scale()) || !Number.isFinite(height)) {
    warn('fit produced a non-finite projection', { projection: id, extent });
    return undefined;
  }
  return { projection, height: Math.max(1, height), extent };
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
  projection?: ProjectionId;
  /** Fit to the whole globe instead of the data's extent. */
  wholeWorld?: boolean;
  width?: number;
  /** The source raster's extent, only used to warn when the bands fall outside it. */
  rasterBbox?: Bbox;
};

/**
 * Projects bands to SVG paths. The height comes from the data's projected shape, so the aspect
 * ratio is never fixed. Returns undefined when there's nothing drawable.
 */
export const buildLayout = ({ bands, projection = 'australia', wholeWorld = false, width = WIDTH, rasterBbox }: BuildLayoutOptions): Layout | undefined => {
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
  log('layout input', { projection, received: bands.features.length, drawn: features.length });
  if (!features.length) return undefined;

  // Spherical sanity check (diagnostic only). A polygon covering more than a hemisphere is almost
  // certainly a ring d3 reads as inverted, which draws as "the whole world minus this".
  const inverted = features.flatMap((f, i) => (geoArea(f) > 2 * Math.PI ? [i] : []));
  if (inverted.length) warn('features covering more than a hemisphere (likely inverted winding)', { count: inverted.length, firstIndexes: inverted.slice(0, 10) });

  const collection: FeatureCollection = { type: 'FeatureCollection', features };
  const fit = fitProjection(projection, collection, wholeWorld, width);
  if (!fit) return undefined;

  // Bands should sit inside the raster. If they don't, the geometry is wrong before it reaches here
  // (createIsobands / clipTo), and no amount of fitting will make the map look right.
  if (rasterBbox && looksLikeDegrees(rasterBbox)) {
    const [west, south, east, north] = rasterBbox;
    const tol = 1;
    const { extent } = fit;
    if (extent.west < west - tol || extent.east > east + tol || extent.south < south - tol || extent.north > north + tol) {
      warn('band geometry extends beyond the raster: the clip/isoband output is oversized', { bandExtent: extent, rasterBbox });
    }
  }

  const toPath = geoPath(fit.projection);
  const paths = features.map((feature) => ({ d: toPath(feature) ?? '', ...simplestyle(feature.properties) }));
  const empty = paths.filter((p) => !p.d).length;
  if (empty) warn('features that produced an empty path', { empty, of: paths.length });
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
