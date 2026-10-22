<script lang="ts">
  import { fetchGeotiff } from '../../lib/fetchgeotiff.ts';
  import type { GeoJsonInput } from '../../lib/fastclip.ts';
  import type { ProjectionId } from '../../lib/geo.ts';
  import { inview } from '../../lib/inview.ts';
  import {
    choosePixelWidth,
    createRasterLayout,
    renderRasterInWorker,
    type ColourScale
  } from '../../lib/rastergrid.ts';
  import RasterMap from './RasterMap.svelte';

  interface Props {
    /** URL of the GeoTIFF. Fetched as soon as the component mounts. */
    url: string;
    /** Alt text describing the map for screen readers. */
    alt?: string;
    projection: ProjectionId;
    /** GeoJSON boundary: sets the map's extent and clips the raster to it. */
    clipTo: GeoJsonInput;
    /** Turns interpolated values into colours: stepped for an isoband look, gradient for a smooth one. */
    colourScale: ColourScale;
    /** Fixed canvas pixel width. By default it follows the panel's on-screen width times the device pixel ratio. */
    pixelWidth?: number;
    /** How far outside the viewport (CSS margin syntax) the render starts. */
    rootMargin?: string;
  }

  let { url, alt, projection, clipTo, colourScale, pixelWidth: fixedPixelWidth, rootMargin = '600px' }: Props = $props();

  let near = $state(false);
  let buffer = $state.raw<ArrayBuffer>();
  let pixels = $state.raw<Uint8ClampedArray>();
  let error = $state<string>();

  /** On-screen width of the panel in CSS pixels, 0 until measured. */
  let cssWidth = $state(0);
  const pixelWidth = $derived(fixedPixelWidth ?? choosePixelWidth(cssWidth, window.devicePixelRatio));
  const layout = $derived(pixelWidth ? createRasterLayout(projection, clipTo, pixelWidth) : undefined);

  // 1. Preload: start fetching the GeoTIFF immediately, abort if the url changes.
  $effect(() => {
    const controller = new AbortController();
    buffer = pixels = error = undefined;

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

  // 2. Render: only once the data is ready AND the map is near the viewport. Re-runs on a new colour scale.
  $effect(() => {
    if (!near || !buffer || !layout) return;
    const [data, currentLayout, scale] = [buffer, layout, colourScale];
    let stale = false;

    renderRasterInWorker(data, currentLayout, scale)
      .then(({ pixels: result }) => {
        if (!stale) pixels = result;
      })
      .catch((e) => {
        if (stale) return;
        error = `Could not render map: ${e instanceof Error ? e.message : e}`;
        console.error(`[isobands] raster render failed ${JSON.stringify({ url, error: String(e) })}`);
      });

    return () => {
      stale = true;
    };
  });
</script>

<div {@attach inview(rootMargin, () => (near = true))} bind:clientWidth={cssWidth}>
  <RasterMap {layout} {pixels} {alt} {error} />
</div>
