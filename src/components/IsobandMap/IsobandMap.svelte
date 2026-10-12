<script lang="ts">
  import { geoConicConformal, geoPath, type GeoProjection } from 'd3-geo';
  import type { Feature, FeatureCollection, GeoJsonProperties } from 'geojson';
  import { createIsobands } from '../../lib/createisobands.ts';
  import type { GeoJsonInput } from '../../lib/fastclip.ts';
 
  interface Props {
    /** URL of the GeoTIFF. Fetched as soon as the component mounts. */
    url: string;
    /** Label shown on the line above the map. */
    name: string;
    /**
     * d3-geo projection. Defaults to Lambert Conformal Conic, with the central
     * meridian and standard parallels set for Australia.
     * The component calls `fitSize` on it, which mutates it, so pass a fresh instance per component.
     */
    projection?: GeoProjection;
    /** Width / height of the reserved space and the SVG viewBox. */
    aspectRatio?: number;
    /** How far outside the viewport (CSS margin syntax) the render starts. */
    rootMargin?: string;
    /** Optional GeoJSON boundary to clip the bands to. */
    clipTo?: GeoJsonInput;
    /**
     * Takes a band's class value and returns its colour (any CSS colour string).
     * Falls back to the library's default sequential scale when omitted.
     */
    palette?: (value: number) => string;
  }

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
  const simplestyle = (p: GeoJsonProperties) => ({
    fill: str(p?.fill, '#555555'),
    fillOpacity: num(p?.['fill-opacity'], 0.6),
    stroke: str(p?.stroke, 'none'),
    strokeOpacity: num(p?.['stroke-opacity'], 1),
    strokeWidth: num(p?.['stroke-width'], 2)
  });
 
  let {
    url,
    name,
    projection = geoConicConformal().parallels([-18, -36]).rotate([-134, 0]),
    aspectRatio = 4 / 3,
    rootMargin = '600px',
    clipTo,
    palette
  }: Props = $props();
 
  const WIDTH = 1000;
  const height = $derived(WIDTH / aspectRatio);
 
  /** Latches true the first time the figure gets near the viewport. */
  let near = $state(false);
 
  /** Attachment: flips `near` once the figure is within rootMargin of the viewport. */
  const inview = (node: HTMLElement) => {
    const io = new IntersectionObserver(([e]) => e.isIntersecting && ((near = true), io.disconnect()), { rootMargin });
    io.observe(node);
    return () => io.disconnect();
  };
 
  let buffer = $state<ArrayBuffer>();
  let bands = $state<FeatureCollection>();
  let error = $state<string>();
 
  // 1. Preload: start fetching the GeoTIFF immediately, abort if the url changes.
  $effect(() => {
    const controller = new AbortController();
    buffer = undefined;
    bands = undefined;
    error = undefined;
 
    fetch(url, { signal: controller.signal })
      .then((response) => {
        if (!response.ok) throw new Error(`${response.status} ${response.statusText}`);
        return response.arrayBuffer();
      })
      .then((data) => (buffer = data))
      .catch((e) => {
        if (controller.signal.aborted) return;
        error = `Could not load ${url}: ${e instanceof Error ? e.message : e}`;
      });
 
    return () => controller.abort();
  });
 
  // 2. Render: only once the data is ready AND the figure is near the viewport.
  $effect(() => {
    if (!near || !buffer) return;
    const data = buffer;
    const boundary = clipTo;
    const colors = palette;
    let stale = false;
 
    createIsobands(data, { clipTo: boundary, palette: colors })
      .then((result) => {
        if (!stale) bands = result;
      })
      .catch((e) => {
        if (!stale) error = `Could not create isobands: ${e instanceof Error ? e.message : e}`;
      });
 
    return () => {
      stale = true;
    };
  });
 
  /** Shoelace sum over lon/lat: > 0 means clockwise (y up). */
  const area = (ring: number[][]) =>
    ring.reduce((sum, [x, y], i) => sum + (ring[(i + 1) % ring.length][0] - x) * (ring[(i + 1) % ring.length][1] + y), 0);
 
  /**
   * d3-geo is spherical and wants exterior rings clockwise, holes anticlockwise
   * (the opposite of the GeoJSON spec). Wrong winding makes d3 treat a polygon as
   * "the whole globe minus this shape", which is where the giant cone comes from.
   */
  const rewind = (polygon: number[][][]) =>
    polygon.map((ring, i) => ((area(ring) > 0) === (i === 0) ? ring : [...ring].reverse()));
 
  const paths = $derived.by(() => {
    if (!bands?.features.length) return [];
    const features = bands.features.map((f) => {
      const g = f.geometry;
      if (g.type === 'Polygon') return { ...f, geometry: { ...g, coordinates: rewind(g.coordinates) } };
      if (g.type === 'MultiPolygon') return { ...f, geometry: { ...g, coordinates: g.coordinates.map(rewind) } };
      return f;
    }) as Feature[];
 
    projection.fitSize([WIDTH, height], { type: 'FeatureCollection', features });
    const toPath = geoPath(projection);
    return features.map((feature) => ({
      d: toPath(feature) ?? '',
      ...simplestyle(feature.properties)
    }));
  });
</script>
 
<figure {@attach inview} aria-busy={!bands && !error}>
  <svg class="name" role="presentation">
    <text x="50%" y="50%" text-anchor="middle" dominant-baseline="central">{name}</text>
  </svg>
 
  {#if !paths.length}
    <div class="map" style:aspect-ratio={aspectRatio}></div>
  {:else}
    <svg
      class="map"
      viewBox="0 0 {WIDTH} {height}"
      style:aspect-ratio={aspectRatio}
      role="img"
      aria-label="{name} isobands"
    >
      {#each paths as path}
        <path
          d={path.d}
          fill={path.fill}
          fill-opacity={path.fillOpacity}
          stroke={path.stroke}
          stroke-opacity={path.strokeOpacity}
          stroke-width={path.strokeWidth}
        />
      {/each}
      {#if error}
        <text x="50%" y="50%" text-anchor="middle" class="error">{error}</text>
      {/if}
    </svg>
  {/if}
</figure>
 
<style>
  figure {
    display: flex;
    flex-direction: column;
    align-items: center;
    width: 100%;
    margin: 0;
  }
 
  .map {
    display: block;
    width: 100%;
    animation: fadeIn .25s;
  }
 
  .name {
    height: 1.75em;
    font-weight: 600;
    fill: currentColor;
  }
 
  .map {
    height: auto;
  }
 
  .error {
    fill: currentColor;
    font-size: 24px;
  }

  @keyframes fadeIn{
    from{
      opacity:0;
    }
    to{
      opacity:1;
    }
  }
</style>