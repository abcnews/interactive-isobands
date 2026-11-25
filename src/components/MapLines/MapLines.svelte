<script lang="ts">
  import type { GeoProjection } from 'd3-geo';
  import { projectLineLayers, type MapLineLayer } from '../../lib/maplines.ts';

  interface Props {
    /** The map's fitted projection, so the lines land on the same pixels as the map. */
    projection: GeoProjection;
    /** Drawn in order, so later layers sit on top. */
    layers: MapLineLayer[];
  }

  let { projection, layers }: Props = $props();

  const paths = $derived(projectLineLayers(projection, layers));
</script>

<!-- Goes inside an <svg>. Strokes don't scale with the viewBox, so widths stay in CSS pixels at any panel size. -->
<g aria-hidden="true">
  {#each paths as { id, d, stroke, strokeOpacity, strokeWidth } (id)}
    <path
      {d}
      fill="none"
      {stroke}
      stroke-opacity={strokeOpacity}
      stroke-width={strokeWidth}
      stroke-linejoin="round"
      stroke-linecap="round"
      vector-effect="non-scaling-stroke"
    />
  {/each}
</g>
