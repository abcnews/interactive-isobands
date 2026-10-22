import { rgb } from 'd3-color';
import type { GeoProjection } from 'd3-geo';
import type { FeatureCollection, MultiPolygon } from 'geojson';
import { fromArrayBuffer } from 'geotiff';
import { WorkerHost } from 'workiq';
import type { GeoJsonInput } from './fastclip.ts';
import {
  PROJECTION_BUILDERS,
  centreLongitude,
  collectPolygons,
  fitProjection,
  preparePolygon,
  type ProjectionId
} from './geo.ts';
import type { RenderRasterJob } from './rastergrid.worker.ts';

/*
 * Raster grids: reading a GeoTIFF, and drawing it as smooth, projected, colour-mapped pixels.
 * For each output pixel we invert the projection to a grid position, interpolate the grid there, and look the
 * value up in a colour scale. Rendering runs in one worker; the boundary mask and canvas sizing stay on the page.
 */

/* -------- Reading a GeoTIFF -------- */

export type RasterGrid = {
  readonly values: ArrayLike<number>;
  readonly width: number;
  readonly height: number;
  /** Top-left corner of pixel (0,0) in CRS units. */
  readonly origin: readonly [x: number, y: number];
  /** Pixel size in CRS units; y is negative for north-up images. */
  readonly resolution: readonly [x: number, y: number];
  readonly noData: number | null;
};

/** Reads band 0 of the GeoTIFF plus the georeferencing details needed to place each pixel. */
export const readRasterGrid = async (buffer: ArrayBuffer): Promise<RasterGrid> => {
  const image = await (await fromArrayBuffer(buffer)).getImage();
  const rasters = await image.readRasters();
  const [originX, originY] = image.getOrigin();
  const [resX, resY] = image.getResolution();

  return {
    values: rasters[0] as ArrayLike<number>,
    width: image.getWidth(),
    height: image.getHeight(),
    origin: [originX, originY],
    resolution: [resX, resY],
    noData: image.getGDALNoData()
  };
};

/** Says whether a pixel value should be ignored because it is NaN or the file's nodata marker. */
export const isNoData = (value: number, noData: number | null): boolean => Number.isNaN(value) || value === noData;

/* -------- Colour scales -------- */

/**
 * Plain data (so it can be posted to a worker) that turns a value into a colour. Colours are packed as one
 * 32-bit number each (see `packColour`).
 * `steps`: `colours[i]` applies from `thresholds[i - 1]` (inclusive) up to `thresholds[i]`, so there is one more colour than threshold.
 * `gradient`: `colours` are evenly spaced samples across `domain`; values outside it take the end colours.
 */
export type ColourScale =
  | { readonly kind: 'steps'; readonly thresholds: readonly number[]; readonly colours: readonly number[] }
  | { readonly kind: 'gradient'; readonly domain: readonly [min: number, max: number]; readonly colours: readonly number[] };

/** Samples taken from a palette across a gradient's domain. */
const GRADIENT_SAMPLES = 512;

/** Packs any CSS colour into ABGR, the byte order of a little-endian `Uint32Array` view over ImageData (every current browser). */
const packColour = (css: string): number => {
  const { r, g, b, opacity } = rgb(css);
  return ((Math.round(opacity * 255) << 24) | (Math.round(b) << 16) | (Math.round(g) << 8) | Math.round(r)) >>> 0;
};

/**
 * Builds a stepped scale from ascending thresholds and one colour per step, such as the arrays
 * `getSequentialSteppedPalette` returns: `colours[0]` is for values below the first threshold.
 */
export const createSteppedScale = (thresholds: readonly number[], colours: readonly string[]): ColourScale => {
  if (colours.length !== thresholds.length + 1) {
    throw new Error(`${thresholds.length} thresholds need ${thresholds.length + 1} colours, got ${colours.length}`);
  }
  return { kind: 'steps', thresholds, colours: colours.map(packColour) };
};

/** Builds a smooth scale by sampling `colourAt` (such as `createContinuousScale` from @abcnews/palette) across [min, max]. */
export const createGradientScale = (
  domain: readonly [min: number, max: number],
  colourAt: (value: number) => string
): ColourScale => ({
  kind: 'gradient',
  domain,
  colours: Array.from({ length: GRADIENT_SAMPLES }, (_, i) =>
    packColour(colourAt(domain[0] + ((domain[1] - domain[0]) * i) / (GRADIENT_SAMPLES - 1)))
  )
});

/* -------- Sampling and painting -------- */

/** A grid that spans (nearly) the globe in longitude can be wrapped, so 0-360 and -180-180 grids both work. */
const GLOBAL_SPAN_DEGREES = 359;

/** A ring of [x, y] points in output pixel space. */
type PixelRing = readonly (readonly [x: number, y: number])[];

/** Sub-scanlines per pixel row when measuring how much of a pixel the boundary covers. */
const COVERAGE_SUBSAMPLES = 4;

/**
 * How much of each output pixel (row-major, 0-255) lies inside the boundary, with an anti-aliased edge.
 * Rings are filled even-odd, so holes work. Each pixel row is sampled on a few horizontal lines, and each
 * line adds the exact horizontal overlap of its inside spans.
 */
export const rasteriseBoundary = (rings: readonly PixelRing[], width: number, height: number): Uint8Array => {
  // Edges bucketed by the pixel rows they touch, so each row only looks at its own edges.
  const edgesByRow: (readonly number[])[][] = Array.from({ length: height }, () => []);
  rings.forEach(ring =>
    ring.slice(0, -1).forEach(([x0, y0], i) => {
      const [x1, y1] = ring[i + 1];
      if (y0 === y1) return;
      const firstRow = Math.max(0, Math.floor(Math.min(y0, y1)));
      const lastRow = Math.min(height - 1, Math.floor(Math.max(y0, y1)));
      for (let row = firstRow; row <= lastRow; row++) edgesByRow[row].push([x0, y0, x1, y1]);
    })
  );

  const coverage = new Uint8Array(width * height);
  const rowOverlap = new Float32Array(width);
  // Hot loop: plain loops, as this runs per output pixel.
  for (let row = 0; row < height; row++) {
    if (!edgesByRow[row].length) continue;
    rowOverlap.fill(0);

    for (let line = 0; line < COVERAGE_SUBSAMPLES; line++) {
      const y = row + (line + 0.5) / COVERAGE_SUBSAMPLES;
      const crossings = edgesByRow[row]
        .filter(([, y0, , y1]) => y0 <= y !== y1 <= y)
        .map(([x0, y0, x1, y1]) => x0 + ((y - y0) / (y1 - y0)) * (x1 - x0))
        .sort((a, b) => a - b);

      for (let span = 0; span + 1 < crossings.length; span += 2) {
        const start = Math.max(0, crossings[span]);
        const end = Math.min(width, crossings[span + 1]);
        for (let x = Math.floor(start); x < Math.ceil(end); x++) {
          rowOverlap[x] += Math.min(end, x + 1) - Math.max(start, x);
        }
      }
    }
    for (let x = 0; x < width; x++) coverage[row * width + x] = Math.round((rowOverlap[x] / COVERAGE_SUBSAMPLES) * 255);
  }
  return coverage;
};

/**
 * For every output pixel, where it lands in the grid as fractional [column, row] (pixel centres at
 * integers, matching bilinear sampling). Stored as interleaved Float32 pairs, NaN where the pixel
 * is off the map or outside the boundary (zero `coverage`), which skips the projection for them.
 * Depends only on the projection, boundary and grid geometry, not the values, so it is reused between
 * rasters with the same grid.
 */
export const buildSampleMap = (
  projection: Pick<GeoProjection, 'invert'>,
  { width, height }: { width: number; height: number },
  { origin, resolution, width: gridWidth }: Pick<RasterGrid, 'origin' | 'resolution' | 'width'>,
  coverage: Uint8Array
): Float32Array => {
  const map = new Float32Array(width * height * 2).fill(Number.NaN);
  const isGlobal = Math.abs(resolution[0]) * gridWidth >= GLOBAL_SPAN_DEGREES;

  // Hot loop: plain for loops, as this runs once per output pixel.
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      if (coverage[y * width + x] === 0) continue;
      const lonLat = projection.invert?.([x + 0.5, y + 0.5]);
      if (!lonLat || !Number.isFinite(lonLat[0]) || !Number.isFinite(lonLat[1])) continue;

      const lon = isGlobal ? origin[0] + ((((lonLat[0] - origin[0]) % 360) + 360) % 360) : lonLat[0];
      const i = (y * width + x) * 2;
      map[i] = (lon - origin[0]) / resolution[0] - 0.5;
      map[i + 1] = (lonLat[1] - origin[1]) / resolution[1] - 0.5;
    }
  }
  return map;
};

/**
 * Bilinearly interpolates the grid at fractional [column, row]. Nodata neighbours are left out and
 * the rest re-weighted, so coasts don't fade to nothing; NaN when every neighbour is nodata or the
 * point is more than half a pixel outside the grid.
 */
export const sampleBilinear = (grid: RasterGrid, column: number, row: number): number => {
  const { values, width, height, noData } = grid;
  if (!(column >= -0.5 && column <= width - 0.5 && row >= -0.5 && row <= height - 0.5)) return Number.NaN;

  const x0 = Math.floor(column);
  const y0 = Math.floor(row);
  const fx = column - x0;
  const fy = row - y0;
  const xa = x0 < 0 ? 0 : x0;
  const xb = x0 + 1 > width - 1 ? width - 1 : x0 + 1;
  const ya = y0 < 0 ? 0 : y0;
  const yb = y0 + 1 > height - 1 ? height - 1 : y0 + 1;

  // Unrolled, with no arrays or closures: this runs once per output pixel.
  let sum = 0;
  let totalWeight = 0;
  const add = (value: number, weight: number) => {
    if (weight <= 0 || isNoData(value, noData)) return;
    sum += value * weight;
    totalWeight += weight;
  };
  add(values[ya * width + xa], (1 - fx) * (1 - fy));
  add(values[ya * width + xb], fx * (1 - fy));
  add(values[yb * width + xa], (1 - fx) * fy);
  add(values[yb * width + xb], fx * fy);

  return totalWeight === 0 ? Number.NaN : sum / totalWeight;
};

/**
 * Paints the grid into RGBA pixels (row-major, `width` x `height`); transparent where there is no data or
 * outside the boundary. Pixels on the boundary's edge get their alpha scaled by `coverage`.
 */
export const paintPixels = (
  grid: RasterGrid,
  sampleMap: Float32Array,
  scale: ColourScale,
  { width, height }: { width: number; height: number },
  coverage: Uint8Array
): Uint8ClampedArray => {
  const pixels = new Uint8ClampedArray(width * height * 4);
  const packed = new Uint32Array(pixels.buffer);
  const palette = Uint32Array.from(scale.colours);
  const lastColour = palette.length - 1;
  const thresholds = scale.kind === 'steps' ? scale.thresholds : undefined;
  const [min, max] = scale.kind === 'gradient' ? scale.domain : [0, 1];

  // Hot loop: plain loops and no allocation, as this runs once per output pixel.
  for (let i = 0; i < width * height; i++) {
    const value = sampleBilinear(grid, sampleMap[i * 2], sampleMap[i * 2 + 1]);
    if (Number.isNaN(value)) continue;

    let colour = 0;
    if (thresholds) {
      while (colour < thresholds.length && value >= thresholds[colour]) colour++;
    } else {
      colour = Math.min(lastColour, Math.max(0, Math.round(((value - min) / (max - min)) * lastColour)));
    }

    const rgba = palette[colour];
    const edge = coverage[i];
    packed[i] = edge === 255 ? rgba : ((Math.round(((rgba >>> 24) * edge) / 255) << 24) | (rgba & 0xffffff)) >>> 0;
  }
  return pixels;
};

/* -------- Rendering -------- */

/**
 * Everything needed to rebuild a fitted projection (which can't be posted to a worker), the pixel size it
 * was fitted to, and the boundary the picture is cropped to. The projection is fully determined by these,
 * since fitting only sets scale and translate.
 */
export type RasterLayout = {
  readonly projectionId: ProjectionId;
  readonly centreLon: number;
  readonly scale: number;
  readonly translate: readonly [x: number, y: number];
  readonly width: number;
  readonly height: number;
  /** The boundary's rings, already projected into output pixel space. Pixels outside it are left transparent. */
  readonly boundary: readonly PixelRing[];
};

export type RenderResult = {
  /** RGBA, `layout.width` x `layout.height`, transparent where there's no data or outside the boundary. */
  pixels: Uint8ClampedArray;
  /** True if the pixel-to-grid map from the previous render was reused. */
  reusedSampleMap: boolean;
};

/** The last sample map and boundary coverage built: panels in a set share a layout and grid, so they are built once. */
let lastSampleMap: { key: string; map: Float32Array; coverage: Uint8Array } | undefined;

/** Reads the GeoTIFF and paints it as RGBA pixels in the layout's pixel space, cropped to its boundary. */
export const renderRasterPixels = async (
  buffer: ArrayBuffer,
  layout: RasterLayout,
  colourScale: ColourScale
): Promise<RenderResult> => {
  const grid = await readRasterGrid(buffer);

  const key = JSON.stringify({ layout, origin: grid.origin, resolution: grid.resolution, width: grid.width });
  const reusedSampleMap = lastSampleMap?.key === key;
  if (!reusedSampleMap) {
    const projection = PROJECTION_BUILDERS[layout.projectionId]
      .create(layout.centreLon)
      .scale(layout.scale)
      .translate([...layout.translate]);
    const coverage = rasteriseBoundary(layout.boundary, layout.width, layout.height);
    lastSampleMap = { key, coverage, map: buildSampleMap(projection, layout, grid, coverage) };
  }

  const { map, coverage } = lastSampleMap!;
  return { pixels: paintPixels(grid, map, colourScale, layout, coverage), reusedSampleMap };
};

/* -------- Canvas size -------- */

/** Canvas widths are rounded to this, so panels of near-identical size share one layout, mask and sample map. */
const STEP = 100;
const MIN_PIXEL_WIDTH = 200;
/** Past this the extra detail isn't worth the render cost for a small multiple. */
const MAX_PIXEL_WIDTH = 1600;

/**
 * The canvas width that matches an element's on-screen size: CSS pixels times the device pixel ratio,
 * rounded up to the nearest step (a slightly large canvas stays sharp, a slightly small one goes soft).
 * Returns undefined until the element has been measured.
 */
export const choosePixelWidth = (cssWidth: number, devicePixelRatio = 1): number | undefined => {
  if (!(cssWidth > 0)) return undefined;
  const wanted = Math.ceil((cssWidth * (devicePixelRatio > 0 ? devicePixelRatio : 1)) / STEP) * STEP;
  return Math.min(MAX_PIXEL_WIDTH, Math.max(MIN_PIXEL_WIDTH, wanted));
};

/* -------- Layout -------- */

/** Layouts are shared by every panel with the same boundary, projection and width. */
const layouts = new WeakMap<object, Map<string, RasterLayout | undefined>>();

/**
 * Fits the projection to the boundary's extent (as the vector maps fit to their clipped bands) and projects
 * the boundary into pixel space for the worker to crop to. Returns undefined if the boundary has nothing drawable.
 * Memoised, as small multiples share one boundary.
 */
export const createRasterLayout = (projectionId: ProjectionId, clip: GeoJsonInput, width: number): RasterLayout | undefined => {
  const byKey = layouts.get(clip as object) ?? new Map<string, RasterLayout | undefined>();
  layouts.set(clip as object, byKey);
  const key = `${projectionId}|${width}`;
  if (byKey.has(key)) return byKey.get(key);

  const polygons = collectPolygons(clip)
    .map(preparePolygon)
    .filter((polygon): polygon is number[][][] => !!polygon);
  const collection: FeatureCollection<MultiPolygon> = {
    type: 'FeatureCollection',
    features: [{ type: 'Feature', properties: {}, geometry: { type: 'MultiPolygon', coordinates: polygons } }]
  };
  const centreLon = centreLongitude(collection);
  const fit = polygons.length ? fitProjection(projectionId, collection, false, width, centreLon) : undefined;

  const [translateX, translateY] = fit?.projection.translate() ?? [0, 0];
  const layout = fit && {
    projectionId,
    centreLon,
    scale: fit.projection.scale(),
    translate: [translateX, translateY] as const,
    width,
    height: fit.height,
    boundary: polygons.flatMap(polygon =>
      polygon.map(ring =>
        ring.flatMap(([lon, lat]) => {
          const point = fit.projection([lon, lat]);
          return point ? [[point[0], point[1]] as const] : [];
        })
      )
    )
  };
  byKey.set(key, layout);
  return layout;
};

/* -------- Worker -------- */

/**
 * One worker, not a pool. The pixel-to-grid map is most of a cold job and is the same for every panel,
 * so a single worker builds it once and reuses it, and pays the module start-up once. The total work
 * for a set of panels is small, so a pool would mostly repeat that shared work.
 */
let host: WorkerHost | undefined;

/**
 * Paints a GeoTIFF as RGBA pixels (`layout.width` x `layout.height`) in the worker. Jobs queue and can't be
 * cancelled: callers should ignore stale results.
 * The buffer is copied before being transferred, so the caller's ArrayBuffer stays usable.
 */
export const renderRasterInWorker = async (
  tiff: ArrayBuffer,
  layout: RasterLayout,
  colourScale: ColourScale
): Promise<RenderResult> => {
  if (typeof Worker === 'undefined') return renderRasterPixels(tiff, layout, colourScale);

  host ??= new WorkerHost({
    workers: [new Worker(new URL('./rastergrid.worker.ts', import.meta.url), { type: 'module' })],
    logLevel: 'error'
  });

  const buffer = tiff.slice(0);
  const job: RenderRasterJob = { buffer, layout, colourScale };
  return host
    .push<RenderResult>('renderRaster', job, { transferList: [buffer] })
    .catch((message: unknown) => {
      // workiq rejects with the worker's error message rather than an Error.
      throw message instanceof Error ? message : new Error(String(message));
    });
};
