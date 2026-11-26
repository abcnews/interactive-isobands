<script lang="ts" module>
  import type { RasterLayout } from '../../lib/rastergrid.ts';

  /** What layer components read from `getLayerCakeContext().custom`. */
  export type MapCakeCustom = { layout: RasterLayout };
</script>

<script lang="ts">
  import { Html, LayerCake, Svg } from 'layercake';
  import type { MapLineLayer } from '../../lib/maplines.ts';
  import { positionPlaces, sidesNeedingGutter, type Place } from '../../lib/places.ts';
  import { projectionFromLayout } from '../../lib/rastergrid.ts';
  import MapLines from '../MapLines/MapLines.svelte';
  import PlaceLabel from '../PlaceLabel/PlaceLabel.svelte';
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
    /** Places labelled over the map, e.g. capital cities. */
    places?: Place[];
    /** Show place names beside their symbols. When false, only the symbols are drawn. */
    showPlaceNames?: boolean;
    /** Called with the panel's measured CSS width. */
    onresize?: (cssWidth: number) => void;
  }

  let { layout, aspectRatio, imageUrl, alt = 'Raster map', error, lineLayers = [], places = [], showPlaceNames = true, onresize }: Props =
    $props();

  const uid = $props.id();
  const clipId = `${uid}-land`;

  const projection = $derived(layout ? projectionFromLayout(layout) : undefined);
  const lineProjection = $derived(lineLayers.length ? projection : undefined);
  const positionedPlaces = $derived(
    layout && projection ? positionPlaces({ places, projection, width: layout.width, height: layout.height }) : []
  );

  /**
   * Labels are HTML that hangs off their dot, so a place near the coast (Brisbane, Hobart) pushes
   * its name past the map's edge and off the frame. Shrink the map by a fixed gutter on each side
   * that needs one. Hard-coded per side for the names there now:
   * - right: "Brisbane" (~69px from its dot), which sits almost on the coast.
   * - left: "Perth" (~44px), less whatever room there already is between Perth and the coast.
   * Re-tune if the places near an edge change.
   */
  const PLACE_LABEL_GUTTER_PX: Record<Place['align'], number> = { left: 32, right: 72 };
  // Symbols alone sit on the map, so only names need a gutter.
  const gutterSides = $derived(showPlaceNames ? sidesNeedingGutter(positionedPlaces) : { left: false, right: false });
  const gutterFor = (side: Place['align']) => (gutterSides[side] ? PLACE_LABEL_GUTTER_PX[side] : 0);

  /** LayerCake measures the container; pass the width up so the panel can pick its pixel width. */
  let measuredWidth = $state(0);
  const reportWidth = (width: number) => {
    measuredWidth = width;
    onresize?.(width);
  };
</script>

<figure aria-busy={!imageUrl && !error} style:padding-inline="{gutterFor('left')}px {gutterFor('right')}px">
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
          {#if positionedPlaces.length}
            <!-- HTML, not SVG, so the label text stays 14px at any panel size. -->
            <Html>
              {#each positionedPlaces as { name, align, xPercent, yPercent } (name)}
                <PlaceLabel label={name} {align} x="{xPercent}%" y="{yPercent}%" showText={showPlaceNames} />
              {/each}
            </Html>
          {/if}
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
    box-sizing: border-box;
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
