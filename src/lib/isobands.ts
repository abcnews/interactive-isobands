import { fromArrayBuffer, type GeoTIFFImage } from 'geotiff';
import { contours as d3Contours } from 'd3-contour';
import { ColourMode, SequentialPalette, createContinuousScale } from '@abcnews/palette';
import type { Feature, FeatureCollection, MultiPolygon } from 'geojson';
import { pathsToPolygons, type ClipperPath } from './fastclip.ts';

/* ----------------------------- Configuration ------------------------- */

/** Decimal places kept for output coordinates (5 ≈ 1.1 m for lon/lat degrees). */
const COORDINATE_DECIMAL_PLACES = 5;

/** Default palette used to colour classes. The ABC palette has no yellow, so sequential red is the closest fit. */
const DEFAULT_PALETTE = SequentialPalette.Red;

const DEFAULT_COLOUR_MODE = ColourMode.Light;
const STYLE_FILL_OPACITY = 1;

/** Pixels processed between yields in the per-pixel loops. */
const CHUNK_SIZE = 250_000;

/* ------------------------------- Types ------------------------------- */

type RasterGrid = {
  readonly values: ArrayLike<number>;
  readonly width: number;
  readonly height: number;
  /** Top-left corner of pixel (0,0) in CRS units. */
  readonly origin: readonly [x: number, y: number];
  /** Pixel size in CRS units; y is negative for north-up images. */
  readonly resolution: readonly [x: number, y: number];
  readonly noData: number | null;
};

/** Maps a band's class value to a CSS colour string. */
export type BandPalette = (value: number) => string;

export type IsoBandOptions = {
  readonly propertyName?: string;
  /**
   * Colours each band from its class value. Defaults to a continuous ABC palette scale
   * (sequential red, light mode) spanning the raster's lowest to highest class value.
   */
  readonly palette?: BandPalette;
  /**
   * Threshold mode. Give all three of `min`, `max` and `interval` to cut the raster into bands
   * at min, min + interval, ... max, instead of making one band per distinct raster value
   * (the default, which suits already-classified rasters but gives hundreds of bands on continuous data).
   * Each band's class value is its midpoint, and its `lower` and `upper` bounds are added as properties.
   */
  readonly min?: number;
  readonly max?: number;
  readonly interval?: number;
  /**
   * Threshold mode only: what to do with pixels below `min` or above `max`.
   * 'drop' (default) leaves them out of the output; 'clamp' folds them into the first or last band.
   */
  readonly outOfRange?: 'drop' | 'clamp';
};

/** d3-contour output: polygons as [polygon][ring][point] in grid space. */
type GridPolygons = readonly (readonly (readonly (readonly number[])[])[])[];

/* ------------------------------ Scheduling --------------------------- */

/** Lets the event loop run pending work (I/O, timers, input) before continuing. */
const yieldToMain = (): Promise<void> => {
  const scheduler = (globalThis as { scheduler?: { yield?: () => Promise<void> } }).scheduler;
  return scheduler?.yield ? scheduler.yield() : new Promise(resolve => setTimeout(resolve, 0));
};

/* --------------------------- Loading/reading ------------------------- */

/** Parses the buffer as a TIFF and returns its first image. */
const loadFirstImage = async (buffer: ArrayBuffer): Promise<GeoTIFFImage> => (await fromArrayBuffer(buffer)).getImage();

/** Reads band 0 of the image plus the georeferencing details needed to place each pixel. */
const readRasterGrid = async (image: GeoTIFFImage): Promise<RasterGrid> => {
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

/* ------------------------- Class value handling ---------------------- */

/** Says whether a pixel value should be ignored because it is NaN or the file's nodata marker. */
const isNoData = (value: number, noData: number | null): boolean => Number.isNaN(value) || value === noData;

/** Returns a sorted copy of the numbers, lowest first. */
const sortAscending = (numbers: readonly number[]): readonly number[] => [...numbers].sort((a, b) => a - b);

/** Finds every distinct class value in the raster, ignoring nodata, sorted lowest to highest. Yields between chunks. */
const extractUniqueClassValues = async ({ values, noData }: RasterGrid): Promise<readonly number[]> => {
  const unique = new Set<number>();
  for (let i = 0; i < values.length; i++) {
    const v = values[i];
    if (!isNoData(v, noData)) unique.add(v);
    if (i % CHUNK_SIZE === CHUNK_SIZE - 1) await yieldToMain();
  }
  return sortAscending([...unique]);
};

/** Builds break values halfway between neighbouring classes, padded by half a step at each end. */
const createBreaksFromClassValues = (classValues: readonly number[]): readonly number[] => {
  const midpoints = classValues.slice(1).map((v, i) => (classValues[i] + v) / 2);
  const first = classValues[0];
  const last = classValues[classValues.length - 1];
  const lowerPad = (midpoints[0] ?? first + 0.5) - first;
  const upperPad = last - (midpoints[midpoints.length - 1] ?? last - 0.5);

  return [first - lowerPad, ...midpoints, last + upperPad];
};

/** Sanity limit on the number of bands in threshold mode, so a tiny interval can't hang the browser. */
const MAX_THRESHOLD_BANDS = 500;

/** Strips floating point noise (0.30000000000000004 -> 0.3). */
const tidy = (n: number): number => Number(n.toPrecision(12));

/**
 * Builds breaks at min, min + interval, ... max (the last band is narrower if the range isn't a
 * whole number of intervals), plus one class value per band at its midpoint. Midpoints keep bands
 * either side of a divergent palette's neutral value symmetrical.
 */
const createThresholdBands = (
  min: number,
  max: number,
  interval: number
): { breaks: readonly number[]; classValues: readonly number[] } => {
  if (![min, max, interval].every(Number.isFinite)) throw new Error('min, max and interval must be finite numbers');
  if (max <= min) throw new Error('max must be greater than min');
  if (interval <= 0) throw new Error('interval must be greater than zero');

  const count = Math.ceil((max - min) / interval - 1e-9);
  if (count > MAX_THRESHOLD_BANDS) {
    throw new Error(`That range and interval give ${count} bands (limit ${MAX_THRESHOLD_BANDS})`);
  }

  const breaks = Array.from({ length: count + 1 }, (_, i) => (i === count ? max : tidy(min + i * interval)));
  const classValues = breaks.slice(1).map((upper, i) => tidy((breaks[i] + upper) / 2));
  return { breaks, classValues };
};

/** Provides one properties object per band so each output polygon records its class value. */
const createBreaksProperties = (
  classValues: readonly number[],
  propertyName: string
): readonly Record<string, number>[] => classValues.map(value => ({ [propertyName]: value }));

/** Picks a value safely below the lowest break so nodata pixels fall outside every band. */
const createNoDataSentinel = (breaks: readonly number[]): number => breaks[0] - 1;

/* ----------------------- Raster to contour rings --------------------- */

/** Scaling factor that snaps output coordinates to the configured decimal places. */
const COORDINATE_FACTOR = 10 ** COORDINATE_DECIMAL_PLACES;

/**
 * Copies the raster into the flat row-major array d3-contour expects, swapping nodata for the sentinel.
 * With `clampTo`, valid values are pulled into that [low, high] range. Yields between chunks.
 */
const rasterToFlatArray = async (
  grid: RasterGrid,
  sentinel: number,
  clampTo?: readonly [low: number, high: number]
): Promise<Float64Array> => {
  const out = new Float64Array(grid.width * grid.height);
  for (let i = 0; i < out.length; i++) {
    const v = grid.values[i];
    out[i] = isNoData(v, grid.noData) ? sentinel : clampTo ? Math.min(clampTo[1], Math.max(clampTo[0], v)) : v;
    if (i % CHUNK_SIZE === CHUNK_SIZE - 1) await yieldToMain();
  }
  return out;
};

/**
 * Converts d3-contour polygons (grid space) to integer Clipper paths in CRS coordinates.
 * d3-contour already places pixel centres at (col + 0.5, row + 0.5), so scaling by the
 * resolution from the pixel-corner origin needs no extra half-pixel shift. Rings repeat their
 * first point at the end; Clipper paths are implicitly closed, so that point is dropped.
 */
const polygonsToClipperPaths = (polygons: GridPolygons, { origin, resolution }: RasterGrid): ClipperPath[] =>
  polygons.flatMap(polygon =>
    polygon.map(ring =>
      ring.slice(0, -1).map(([col, row]) => ({
        X: Math.round((origin[0] + col * resolution[0]) * COORDINATE_FACTOR),
        Y: Math.round((origin[1] + row * resolution[1]) * COORDINATE_FACTOR)
      }))
    )
  );

/* ------------------------------- Styling ----------------------------- */

/** Builds the default colour function: a continuous ABC scale across the class values. */
const createDefaultPalette = (classValues: readonly number[]): BandPalette => {
  const min = classValues[0];
  const max = classValues[classValues.length - 1];
  // Guard against a single-class raster, which would give a zero-width domain.
  return createContinuousScale(DEFAULT_PALETTE, DEFAULT_COLOUR_MODE, [min, max === min ? min + 1 : max]);
};

/** Adds simplestyle-spec properties, colouring each band with the given palette function. */
const applySimpleStyle = (
  collection: FeatureCollection<MultiPolygon>,
  propertyName: string,
  scale: BandPalette
): FeatureCollection<MultiPolygon> => {
  return {
    ...collection,
    features: collection.features.map(feature => {
      const colour = scale(Number(feature.properties?.[propertyName]));
      return {
        ...feature,
        properties: {
          ...feature.properties,
          fill: colour,
          'fill-opacity': STYLE_FILL_OPACITY,
          'stroke-width': 0,
          'stroke-opacity': 0
        }
      };
    })
  };
};

/* ------------------------------ Output ------------------------------- */

/** Says whether a band actually contains any polygon geometry. */
const hasGeometry = ({ geometry }: Feature<MultiPolygon>): boolean => geometry.coordinates.length > 0;

/** Drops bands that matched no pixels so the output only holds real shapes. */
const removeEmptyBands = (collection: FeatureCollection<MultiPolygon>): FeatureCollection<MultiPolygon> => ({
  ...collection,
  features: collection.features.filter(hasGeometry)
});

/* --------------------------- Entry point ----------------------------- */

/** Turns a classified GeoTIFF buffer into a FeatureCollection of one MultiPolygon isoband per colour class, styled with simplestyle properties. */
export const createIsoBandsFromGeotiff = async (
  buffer: ArrayBuffer,
  { propertyName = 'classValue', palette, min, max, interval, outOfRange = 'drop' }: IsoBandOptions = {}
): Promise<FeatureCollection<MultiPolygon>> => {
  const given = [min, max, interval].filter(v => v !== undefined).length;
  if (given !== 0 && given !== 3) throw new Error('min, max and interval must be given together');

  // Validate the options before doing any heavy work.
  const thresholdBands = given === 3 ? createThresholdBands(min!, max!, interval!) : undefined;

  const image = await loadFirstImage(buffer);
  const grid = await readRasterGrid(image);
  await yieldToMain();

  // Threshold mode skips the full pass that collects every distinct raster value.
  const classValues = thresholdBands?.classValues ?? (await extractUniqueClassValues(grid));
  const breaks = thresholdBands?.breaks ?? createBreaksFromClassValues(classValues);

  // Nodata sentinel. d3-contour interpolates between a pixel and its neighbour, so in threshold mode
  // (where breaks sit at arbitrary values) a sentinel only just below min would drag the upper
  // breaks away from the nodata edge and leave slivers of the lower bands along it. Far below
  // keeps every break's crossing right up against the edge.
  const noDataSentinel = thresholdBands
    ? breaks[0] - 1000 * (breaks[breaks.length - 1] - breaks[0])
    : createNoDataSentinel(breaks);

  // Clamping pulls out-of-range values just inside the end bands. The epsilon keeps clamped pixels
  // strictly inside [min, max) so they don't land on a break.
  const epsilon = thresholdBands ? (breaks[breaks.length - 1] - breaks[0]) * 1e-9 : 0;
  const clampTo =
    thresholdBands && outOfRange === 'clamp'
      ? ([breaks[0] + epsilon, breaks[breaks.length - 1] - epsilon] as const)
      : undefined;

  const flat = await rasterToFlatArray(grid, noDataSentinel, clampTo);
  await yieldToMain();

  // d3-contour yields cumulative regions (value >= threshold), one per lower break.
  // The top break is above every pixel, so the region above the last band is empty.
  // Contour one threshold at a time so we can yield between the heavy calls.
  const contourer = d3Contours().size([grid.width, grid.height]);
  const regionPaths: ClipperPath[][] = [];
  // In threshold mode pixels can sit above the top break, so that region is contoured too (it is
  // what the top band is cut against). In class mode the top break is above every pixel.
  const contourBreaks = thresholdBands ? breaks : breaks.slice(0, classValues.length);
  for (const threshold of contourBreaks) {
    regionPaths.push(polygonsToClipperPaths(contourer.contour(flat, threshold).coordinates, grid));
    await yieldToMain();
  }

  // Band i = region(>= break i) minus region(>= break i+1). The upper region is nested
  // inside the lower one, so pooling both ring sets under even-odd fill gives the difference.
  const features: Feature<MultiPolygon>[] = [];
  for (let i = 0; i < classValues.length; i++) {
    features.push({
      type: 'Feature',
      properties: {
        [propertyName]: classValues[i],
        ...(thresholdBands ? { lower: breaks[i], upper: breaks[i + 1] } : {})
      },
      geometry: {
        type: 'MultiPolygon',
        coordinates: pathsToPolygons([...regionPaths[i], ...(regionPaths[i + 1] ?? [])], COORDINATE_FACTOR)
      }
    });
    await yieldToMain();
  }

  const bands: FeatureCollection<MultiPolygon> = { type: 'FeatureCollection', features };
  return applySimpleStyle(removeEmptyBands(bands), propertyName, palette ?? createDefaultPalette(classValues));
};
