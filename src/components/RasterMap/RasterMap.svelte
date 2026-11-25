<script lang="ts" module>
  import type { RasterLayout } from '../../lib/rastergrid.ts';

  /** What layer components read from `getLayerCakeContext().custom`. */
  export type MapCakeCustom = { layout: RasterLayout };
</script>

<script lang="ts">
  import { LayerCake, Svg } from 'layercake';
  import type { MapLineLayer } from '../../lib/maplines.ts';
  import { projectionFromLayout } from '../../lib/rastergrid.ts';
  import MapLines from '../MapLines/MapLines.svelte';
  import DataImage from './layers/DataImage.svelte';
  import LandClip from './layers/LandClip.svelte';

  interface Props {
    /** The panel's one fitted projection. Every layer draws in its pixel space. Undefined until the panel is measured. */
    layout?: RasterLayout;
    /** Width / height of the panel. Comes from a layout at a nominal width, so space is reserved before `layout` exists. */
    aspectRatio: number;
    /** URL of the rendered PNG. The panel stays hidden until it arrives. */
    imageUrl?: string;
    /** Alt text describing the map for screen readers. */
    alt?: string;
    /** Shown in place of the map. */
    error?: string;
    /** Lines drawn over the map, e.g. state borders and roads. */
    lineLayers?: MapLineLayer[];
    /** Called with the panel's measured CSS width. */
    onresize?: (cssWidth: number) => void;
  }

  let { layout, aspectRatio, imageUrl, alt = 'Raster map', error, lineLayers = [], onresize }: Props = $props();

  const uid = $props.id();
  const clipId = `${uid}-land`;

  const lineProjection = $derived(layout && lineLayers.length ? projectionFromLayout(layout) : undefined);

  /** LayerCake measures the container; pass the width up so the panel can pick its pixel width. */
  let measuredWidth = $state(0);
  const reportWidth = (width: number) => {
    measuredWidth = width;
    onresize?.(width);
  };
</script>

<figure aria-busy={!imageUrl && !error}>
  {#if error}
    <div class="message" style:aspect-ratio={aspectRatio} role="alert">{error}</div>
  {:else}
    <div class="panel" class:ready={!!imageUrl} style:aspect-ratio={aspectRatio}>
      <!-- Layers only render once `layout` exists, so they can read it as `MapCakeCustom`. -->
      <LayerCake custom={{ layout }} bind:containerWidth={() => measuredWidth, reportWidth}>
        {#if layout}
          <!-- The viewBox is the layout's pixel space, so CSS scales every layer together and nothing is refitted. -->
          <Svg viewBox="0 0 {layout.width} {layout.height}" label={alt}>
            {#snippet defs()}
              <LandClip id={clipId} />
            {/snippet}
            {#if imageUrl}
              <DataImage href={imageUrl} {clipId} />
            {/if}
            {#if lineProjection}
              <MapLines projection={lineProjection} layers={lineLayers} />
            {/if}
          </Svg>
        {/if}
      </LayerCake>
    </div>
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

  /* Hidden until the picture arrives, so borders and roads never show over an empty panel. */
  .panel {
    position: relative;
    width: 100%;
    opacity: 0;
    transition: opacity 0.25s;

    /* Soft blur under the landmass to define the coast: black on light pages, white on dark ones. */
    --land-shadow-colour: rgb(0 0 0 / 0.5);
    @media (prefers-color-scheme: dark) {
      --land-shadow-colour: rgb(255 255 255 / 0.5);
    }
  }

  .panel.ready {
    opacity: 1;
  }

  /* The SVG is transparent outside the land clip, so the shadow follows the coast. */
  .panel :global(.layercake-layout-svg) {
    filter: drop-shadow(0 0 1px var(--land-shadow-colour));
  }

  .message {
    display: flex;
    align-items: center;
    justify-content: center;
    box-sizing: border-box;
    width: 100%;
    padding: 1em;
    text-align: center;
    opacity: 0.7;
    overflow-wrap: anywhere;
  }
</style>
