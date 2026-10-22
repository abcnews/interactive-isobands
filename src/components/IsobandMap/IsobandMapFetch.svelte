<script lang="ts">
  import type { FeatureCollection } from 'geojson';
  import { fetchGeotiff } from '../../lib/fetchgeotiff.ts';
  import { inview } from '../../lib/inview.ts';
  import { createIsobandsInWorker } from '../../lib/createisobandsworker.ts';
  import type { GeoJsonInput } from '../../lib/fastclip.ts';
  import type { ProjectionId } from '../../lib/geo.ts';
  import IsobandMap from './IsobandMap.svelte';

  interface Props {
    /** URL of the GeoTIFF. Fetched as soon as the component mounts. */
    url: string;
    /** Alt text describing the map for screen readers. */
    alt?: string;
    projection: ProjectionId;
    /** How far outside the viewport (CSS margin syntax) the render starts. */
    rootMargin?: string;
    /** Optional GeoJSON boundary to clip the bands to. */
    clipTo?: GeoJsonInput;
    /**
     * Takes a band's class value and returns its colour (any CSS colour string).
     * Falls back to the library's default sequential scale when omitted.
     */
    palette?: (value: number) => string;
    /** Band thresholds: min, min + interval, ... max. Give all three together; omit for one band per raster value. */
    min?: number;
    max?: number;
    interval?: number;
  }

  let { url, alt,projection, rootMargin = '600px', clipTo, palette, min, max, interval }: Props = $props();

  /** Latches true the first time the map gets near the viewport. */
  let near = $state(false);

  let buffer = $state.raw<ArrayBuffer>();
  let bands = $state.raw<FeatureCollection>();
  let error = $state<string>();

  // 1. Preload: start fetching the GeoTIFF immediately, abort if the url changes.
  $effect(() => {
    const controller = new AbortController();
    buffer = undefined;
    bands = undefined;
    error = undefined;

    fetchGeotiff(url, controller.signal)
      .then((data) => {
        buffer = data;
      })
      .catch((e) => {
        if (controller.signal.aborted) return;
        error = `Could not load map data: ${e instanceof Error ? e.message : e}`;
        console.error(`[isobands] fetch failed ${JSON.stringify({ url, error: String(e) })}`);
      });

    return () => controller.abort();
  });

  // 2. Generate: only once the data is ready AND the map is near the viewport.
  $effect(() => {
    if (!near || !buffer) return;
    const data = buffer;
    const options = { clipTo, palette, min, max, interval };
    let stale = false;

    createIsobandsInWorker(data, options)
      .then((result) => {
        if (!stale) bands = result;
      })
      .catch((e) => {
        if (stale) return;
        error = `Could not create isobands: ${e instanceof Error ? e.message : e}`;
        console.error(`[isobands] createIsobands failed ${JSON.stringify({ url, error: String(e) })}`);
      });

    return () => {
      stale = true;
    };
  });
</script>

<div {@attach inview(rootMargin, () => (near = true))}>
  <IsobandMap {bands} {alt} {error} {projection} />
</div>
