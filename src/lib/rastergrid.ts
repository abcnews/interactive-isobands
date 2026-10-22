import { rgb } from 'd3-color';
import { geoPath, type GeoProjection } from 'd3-geo';
import type { Feature, FeatureCollection, MultiPolygon } from 'geojson';
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

/**
 * For every output pixel, where it lands in the grid as fractional [column, row] (pixel centres at
 * integers, matching bilinear sampling). Stored as interleaved Float32 pairs, NaN where the pixel
 * is off the map. Depends only on the projection and grid geometry, not the values, so it is reused
 * between rasters with the same grid.
 */
export const buildSampleMap = (
  projection: Pick<GeoProjection, 'invert'>,
  { width, height }: { width: number; height: number },
  { origin, resolution, width: gridWidth }: Pick<RasterGrid, 'origin' | 'resolution' | 'width'>
): Float32Array => {
  const map = new Float32Array(width * height * 2).fill(Number.NaN);
  const isGlobal = Math.abs(resolution[0]) * gridWidth >= GLOBAL_SPAN_DEGREES;

  // Hot loop: plain for loops, as this runs once per output pixel.
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
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

/** Paints the grid into RGBA pixels (row-major, `width` x `height`); transparent where there is no data. */
export const paintPixels = (
  grid: RasterGrid,
  sampleMap: Float32Array,
  scale: ColourScale,
  { width, height }: { width: number; height: number }
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
    packed[i] = palette[colour];
  }
  return pixels;
};

/* -------- Rendering -------- */

/**
 * Everything needed to rebuild a fitted projection (which can't be posted to a worker) and the pixel
 * size it was fitted to. The projection is fully determined by these, since fitting only sets scale and translate.
 */
export type RasterLayout = {
  readonly projectionId: ProjectionId;
  readonly centreLon: number;
  readonly scale: number;
  readonly translate: readonly [x: number, y: number];
  readonly width: number;
  readonly height: number;
};

export type RenderResult = {
  /** RGBA, `layout.width` x `layout.height`, transparent where there's no data. Not clipped; the caller masks. */
  pixels: Uint8ClampedArray;
  /** True if the pixel-to-grid map from the previous render was reused. */
  reusedSampleMap: boolean;
};

/** The last sample map built: panels in a set share a projection and grid, so it is built once. */
let lastSampleMap: { key: string; map: Float32Array } | undefined;

/** Reads the GeoTIFF and paints it as RGBA pixels in the layout's pixel space. */
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
    lastSampleMap = { key, map: buildSampleMap(projection, layout, grid) };
  }

  return { pixels: paintPixels(grid, lastSampleMap!.map, colourScale, layout), reusedSampleMap };
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

/* -------- Boundary mask and layout (page only) -------- */

export type RasterFrame = {
  readonly layout: RasterLayout;
  /** Opaque where the map is visible. Multiply the painted pixels by this to clip them to the boundary. */
  readonly mask: HTMLCanvasElement;
};

/** Frames are shared by every panel with the same boundary, projection and width. */
const frames = new WeakMap<object, Map<string, RasterFrame | undefined>>();

/**
 * Fits the projection to the boundary's extent (as the vector maps fit to their clipped bands) and draws
 * the boundary once as an anti-aliased alpha mask. Returns undefined if the boundary has nothing drawable.
 * Memoised, as small multiples share one boundary.
 */
export const createRasterFrame = (projectionId: ProjectionId, clip: GeoJsonInput, width: number): RasterFrame | undefined => {
  const byKey = frames.get(clip as object) ?? new Map<string, RasterFrame | undefined>();
  frames.set(clip as object, byKey);
  const key = `${projectionId}|${width}`;
  if (byKey.has(key)) return byKey.get(key);

  const polygons = collectPolygons(clip)
    .map(preparePolygon)
    .filter((polygon): polygon is number[][][] => !!polygon);
  const boundary: Feature<MultiPolygon> = {
    type: 'Feature',
    properties: {},
    geometry: { type: 'MultiPolygon', coordinates: polygons }
  };
  const collection: FeatureCollection = { type: 'FeatureCollection', features: [boundary] };
  const centreLon = centreLongitude(collection);
  const fit = polygons.length ? fitProjection(projectionId, collection, false, width, centreLon) : undefined;

  const mask = document.createElement('canvas');
  const context = fit && mask.getContext('2d');
  if (!fit || !context) {
    byKey.set(key, undefined);
    return undefined;
  }

  mask.width = width;
  mask.height = fit.height;
  context.beginPath();
  geoPath(fit.projection, context)(boundary);
  context.fill();

  const [translateX, translateY] = fit.projection.translate();
  const frame = {
    layout: { projectionId, centreLon, scale: fit.projection.scale(), translate: [translateX, translateY], width, height: fit.height },
    mask
  } satisfies RasterFrame;
  byKey.set(key, frame);
  return frame;
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
