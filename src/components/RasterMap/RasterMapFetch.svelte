<script lang="ts">
  import { fetchGeotiff } from '../../lib/fetchgeotiff.ts';
  import type { GeoJsonInput } from '../../lib/fastclip.ts';
  import type { ProjectionId } from '../../lib/geo.ts';
  import { inview } from '../../lib/inview.ts';
  import type { MapLineLayer } from '../../lib/maplines.ts';
  import type { Place } from '../../lib/places.ts';
  import { choosePixelWidth, createRasterLayout, renderRasterInWorker, type ColourScale } from '../../lib/rastergrid.ts';
  import RasterMap from './RasterMap.svelte';

  interface Props {
    /** URL of the GeoTIFF. Fetched as soon as the component mounts. */
    url: string;
    /** Alt text describing the map for screen readers. */
    alt?: string;
    projection: ProjectionId;
    /** GeoJSON boundary: sets the map's extent and is the land clip. */
    clipTo: GeoJsonInput;
    /** Turns interpolated values into colours: stepped for an isoband look, gradient for a smooth one. */
    colourScale: ColourScale;
    /** Fixed pixel width. By default it follows the panel's on-screen width times the device pixel ratio. */
    pixelWidth?: number;
    /** How far outside the viewport (CSS margin syntax) the render starts. */
    rootMargin?: string;
    /** Lines drawn over the map, e.g. state borders and roads. */
    lineLayers?: MapLineLayer[];
    /** Places labelled over the map. */
    places?: Place[];
    /** Show place names beside their symbols. When false, only the symbols are drawn. */
    showPlaceNames?: boolean;
  }

  let {
    url,
    alt,
    projection,
    clipTo,
    colourScale,
    pixelWidth: fixedPixelWidth,
    rootMargin = '600px',
    lineLayers,
    places,
    showPlaceNames
  }: Props = $props();

  let near = $state(false);
  let buffer = $state.raw<ArrayBuffer>();
  let imageUrl = $state<string>();
  let error = $state<string>();

  // ---- Panel size ----

  /** Width the panel's shape is measured at. Fitting is proportional, so any width gives the same aspect ratio. */
  const NOMINAL_WIDTH = 1000;
  const nominalLayout = $derived(createRasterLayout(projection, clipTo, NOMINAL_WIDTH));
  const aspectRatio = $derived(nominalLayout ? nominalLayout.width / nominalLayout.height : 4 / 3);

  /** Wait this long after the last resize before re-rendering, so dragging a window doesn't queue a render per step. */
  const RESIZE_DEBOUNCE_MS = 250;

  /** Widest on-screen width of the panel so far, in CSS pixels; 0 until measured. */
  let cssWidth = $state(0);
  let resizeTimer: ReturnType<typeof setTimeout> | undefined;

  /** Grow-only: a too-big picture scales down sharply, so only growing (debounced) triggers a re-render. */
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
  /** The panel's one fitted projection: the raster, land clip, borders and roads all draw in its pixel space. */
  const layout = $derived(pixelWidth ? createRasterLayout(projection, clipTo, pixelWidth) : undefined);

  // ---- Data ----

  // 1. Preload: start fetching the GeoTIFF immediately, abort if the url changes.
  $effect(() => {
    const controller = new AbortController();
    buffer = imageUrl = error = undefined;

    fetchGeotiff(url, controller.signal)
      .then(data => {
        buffer = data;
      })
      .catch(e => {
        if (controller.signal.aborted) return;
        error = `Could not load map data: ${e instanceof Error ? e.message : e}`;
        console.error(`[isobands] fetch failed ${JSON.stringify({ url, error: String(e) })}`);
      });

    return () => controller.abort();
  });

  // 2. Render: only once the data is ready AND the map is near the viewport. Re-runs on a new colour scale or
  // a wider layout; the previous picture stays on screen until the new one arrives.
  $effect(() => {
    if (!near || !buffer || !layout) return;
    const [data, currentLayout, scale] = [buffer, layout, colourScale];
    let stale = false;

    renderRasterInWorker(data, currentLayout, scale)
      .then(({ blob }) => {
        if (!stale) imageUrl = URL.createObjectURL(blob);
      })
      .catch(e => {
        if (stale) return;
        error = `Could not render map: ${e instanceof Error ? e.message : e}`;
        console.error(`[isobands] raster render failed ${JSON.stringify({ url, error: String(e) })}`);
      });

    return () => {
      stale = true;
    };
  });

  // 3. Free each picture once it's replaced or the panel goes away.
  $effect(() => {
    const current = imageUrl;
    return () => {
      if (current) URL.revokeObjectURL(current);
    };
  });
</script>

<div {@attach inview(rootMargin, () => (near = true))}>
  <RasterMap {layout} {aspectRatio} {imageUrl} {alt} {error} {lineLayers} {places} {showPlaceNames} onresize={updateCssWidth} />
</div>
