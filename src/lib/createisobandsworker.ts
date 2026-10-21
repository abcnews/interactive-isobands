import type { FeatureCollection, MultiPolygon } from 'geojson';
import { WorkerHost } from 'workiq';
import { applyPalette } from './bandstyle.ts';
import { createIsobands, type CreateIsobandsOptions } from './createisobands.ts';
import type { CreateIsobandsJob } from './isobands.worker.ts';

/** Cap on the pool: each job holds a full raster in memory. */
const MAX_WORKERS = 6;

let host: WorkerHost | undefined;

/**
 * Starts the pool on first use: one worker per core, minus one to leave a core for the page. Parallel jobs
 * (the builder's outside bands, a row of small multiples) spread across it.
 */
const getHost = () => {
  if (host) return host;
  const size = Math.max(1, Math.min(MAX_WORKERS, (navigator.hardwareConcurrency ?? 2) - 1));
  const workers = Array.from(
    { length: size },
    () => new Worker(new URL('./isobands.worker.ts', import.meta.url), { type: 'module' })
  );
  host = new WorkerHost({ workers, logLevel: 'error' });
  return host;
};

/**
 * Same as `createIsobands`, but contouring and clipping run in a pool of web workers so the page stays responsive.
 * Jobs queue when every worker is busy, and can't be cancelled once queued: callers should ignore stale results.
 *
 * The GeoTIFF is copied before being transferred, so the caller's ArrayBuffer stays usable.
 * `palette` runs here rather than in the worker, because functions can't be posted to a worker.
 * Falls back to running on the main thread where workers aren't available.
 */
export const createIsobandsInWorker = async (
  tiff: string | URL | ArrayBuffer,
  { palette, ...options }: CreateIsobandsOptions = {}
): Promise<FeatureCollection> => {
  if (typeof Worker === 'undefined') return createIsobands(tiff, { palette, ...options });

  const buffer = tiff instanceof ArrayBuffer ? tiff.slice(0) : await fetchBuffer(tiff);
  const job: CreateIsobandsJob = { buffer, options };
  const bands = await getHost()
    .push<FeatureCollection<MultiPolygon>>('createIsobands', job, { transferList: [buffer] })
    .catch((message: unknown) => {
      // workiq rejects with the worker's error message rather than an Error.
      throw message instanceof Error ? message : new Error(String(message));
    });

  return palette ? applyPalette(bands, palette) : bands;
};

/** Fetches on the main thread so relative URLs resolve against the page, not the worker script. */
const fetchBuffer = async (url: string | URL): Promise<ArrayBuffer> => {
  const href = new URL(String(url), location.href).href;
  const response = await fetch(href);
  if (!response.ok) throw new Error(`Failed to fetch ${href}: ${response.status} ${response.statusText}`);
  return response.arrayBuffer();
};
