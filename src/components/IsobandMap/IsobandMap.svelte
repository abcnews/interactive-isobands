<script lang="ts">
  import type { FeatureCollection } from 'geojson';
  import { buildLayout, type ProjectionId } from '../../lib/geo.ts';

  interface Props {
    /** Isobands to draw, with simplestyle properties. Draws an empty placeholder until supplied. */
    bands?: FeatureCollection;
    /** Alt text describing the map for screen readers. */
    alt?: string;
    /** Shown in place of the map. */
    error?: string;
    projection: ProjectionId;
    /** Fit the map to the whole globe instead of the bands' extent. */
    wholeWorld?: boolean;
    /** Longitude to centre the map on, for projections that rotate. Defaults to Greenwich. */
    centreLon?: number;
    /** Width / height of the space reserved while there is nothing to draw. */
    placeholderRatio?: number;
  }

  let {
    bands,
    alt = 'Isobands map',
    error,
    projection,
    wholeWorld = false,
    centreLon,
    placeholderRatio = 4 / 3
  }: Props = $props();

  // Height comes from the data's projected shape, so the aspect ratio is never fixed.
  const layout = $derived(buildLayout({ bands, projection, wholeWorld, centreLon }));
</script>

<figure aria-busy={!layout && !error}>
  {#if error}
    <div class="map message" style:aspect-ratio={placeholderRatio} role="alert">{error}</div>
  {:else if !layout}
    <div class="map" style:aspect-ratio={placeholderRatio}></div>
  {:else}
    <svg class="map" viewBox="0 0 {layout.width} {layout.height}" role="img" aria-label={alt}>
      {#each layout.paths as { d, fill, fillOpacity, stroke, strokeOpacity, strokeWidth }}
        <path {d} {fill} fill-opacity={fillOpacity} {stroke} stroke-opacity={strokeOpacity} stroke-width={strokeWidth} />
      {/each}
    </svg>
  {/if}
</figure>

<style>
  figure {
    display: flex;
    flex-direction: column;
    align-items: center;
    width: 100%;
    min-width: 0;
    margin: 0;
  }

  .map {
    display: block;
    width: 100%;
    height: auto;
    animation: fade-in 0.25s;
  }

  .message {
    display: flex;
    align-items: center;
    justify-content: center;
    box-sizing: border-box;
    padding: 1em;
    text-align: center;
    opacity: 0.7;
    overflow-wrap: anywhere;
  }

  @keyframes fade-in {
    from {
      opacity: 0;
    }
    to {
      opacity: 1;
    }
  }
</style>
