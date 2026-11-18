<script lang="ts">
  import { fetchGeotiff } from '../../lib/fetchgeotiff.ts';
  import type { GeoJsonInput } from '../../lib/fastclip.ts';
  import type { ProjectionId } from '../../lib/geo.ts';
  import { inview } from '../../lib/inview.ts';
  import {
    choosePixelWidth,
    createRasterLayout,
    renderRasterInWorker,
    type ColourScale,
    type RasterImage
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
  let image = $state.raw<RasterImage>();
  let error = $state<string>();

  // ---- Panel width ----

  /** Wait this long after the last resize before re-rendering, so dragging a window doesn't queue a render per step. */
  const RESIZE_DEBOUNCE_MS = 250;

  /** Widest on-screen width of the panel so far, in CSS pixels; 0 until measured. */
  let cssWidth = $state(0);
  let resizeTimer: ReturnType<typeof setTimeout> | undefined;

  /** Grow-only: a too-big canvas scales down sharply, so only growing (debounced) triggers a re-render. */
  const updateCssWidth = (measured: number) => {
    if (measured <= cssWidth) return;
    clearTimeout(resizeTimer);
    if (!cssWidth) {
      cssWidth = measured;
      return;
    }
    resizeTimer = setTimeout(() => (cssWidth = Math.max(cssWidth, measured)), RESIZE_DEBOUNCE_MS);
  };

  $effect(() => () => clearTimeout(resizeTimer));

  const pixelWidth = $derived(fixedPixelWidth ?? choosePixelWidth(cssWidth, window.devicePixelRatio));
  const layout = $derived(pixelWidth ? createRasterLayout(projection, clipTo, pixelWidth) : undefined);

  // 1. Preload: start fetching the GeoTIFF immediately, abort if the url changes.
  $effect(() => {
    const controller = new AbortController();
    buffer = image = error = undefined;

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

  // 2. Render: only once the data is ready AND the map is near the viewport. Re-runs on a new colour scale or
  // a wider layout; the previous image stays on screen until the new one arrives.
  $effect(() => {
    if (!near || !buffer || !layout) return;
    const [data, currentLayout, scale] = [buffer, layout, colourScale];
    let stale = false;

    renderRasterInWorker(data, currentLayout, scale)
      .then(({ pixels }) => {
        if (!stale) image = { width: currentLayout.width, height: currentLayout.height, pixels };
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

<div {@attach inview(rootMargin, () => (near = true))} bind:clientWidth={() => cssWidth, updateCssWidth}>
  <RasterMap {layout} {image} {alt} {error} />
</div>
