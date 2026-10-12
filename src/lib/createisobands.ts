import type { FeatureCollection } from 'geojson';
import { fastClip, type GeoJsonInput } from './fastclip.ts';
import { createIsoBandsFromGeotiff, type BandPalette } from './isobands.ts';

export interface CreateIsobandsOptions {
  /** GeoJSON (FeatureCollection, Feature or bare geometry) to clip the bands to. */
  clipTo?: GeoJsonInput;
  /** Takes a band's class value and returns its colour. Defaults to a built-in sequential scale. */
  palette?: BandPalette;
  /** Print timing information to the console. Defaults to false. */
  debug?: boolean;
}

/** Fetches a URL and returns its body as an ArrayBuffer. */
const fetchArrayBuffer = async (url: string): Promise<ArrayBuffer> => {
  const response = await fetch(url);
  if (!response.ok) {
    throw new Error(`Failed to fetch ${url}: ${response.status} ${response.statusText}`);
  }
  return response.arrayBuffer();
};

/**
 * Creates isobands from a GeoTIFF, optionally clipped to a boundary.
 *
 * @param tiff - A URL to a GeoTIFF, or the GeoTIFF's bytes as an ArrayBuffer.
 * @param options - `clipTo` GeoJSON to clip to, `palette` (class value to colour) to control
 *   the simplestyle colours, and `debug` to log timings.
 * @returns The isobands as a GeoJSON FeatureCollection, styled with simplestyle properties.
 */
export const createIsobands = async (
  tiff: string | URL | ArrayBuffer,
  { clipTo, palette, debug = false }: CreateIsobandsOptions = {}
): Promise<FeatureCollection> => {
  /** Runs a step, logging its duration only when debug is on. */
  const timed = async <T>(label: string, step: () => T | Promise<T>): Promise<T> => {
    if (!debug) return step();
    const start = performance.now();
    try {
      return await step();
    } finally {
      console.log(`${label}: ${(performance.now() - start).toFixed(1)}ms`);
    }
  };

  const start = performance.now();

  const buffer = tiff instanceof ArrayBuffer ? tiff : await timed('fetch tiff', () => fetchArrayBuffer(String(tiff)));

  const bands = await timed('create isobands', () => createIsoBandsFromGeotiff(buffer, { palette }));

  const result = clipTo ? await timed('clip to boundary', () => fastClip(bands, clipTo)) : bands;

  if (debug) {
    console.log(
      `Created ${bands.features.length} bands` + (clipTo ? `, ${result.features.length} remain after clipping` : '')
    );
    console.log(`total: ${(performance.now() - start).toFixed(1)}ms`);
  }

  return result as FeatureCollection;
};
