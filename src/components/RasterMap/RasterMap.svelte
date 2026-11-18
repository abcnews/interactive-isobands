<script lang="ts">
  import type { RasterImage, RasterLayout } from '../../lib/rastergrid.ts';

  interface Props {
    /** Projection fit shared by the panels of a set. Reserves the right space before an image arrives. */
    layout?: RasterLayout;
    /** Rendered pixels, already cropped to the boundary. Draws an empty placeholder until supplied. */
    image?: RasterImage;
    /** Alt text describing the map for screen readers. */
    alt?: string;
    /** Shown in place of the map. */
    error?: string;
    /** Width / height of the space reserved while there is no layout. */
    placeholderRatio?: number;
  }

  let { layout, image, alt = 'Raster map', error, placeholderRatio = 4 / 3 }: Props = $props();

  let canvas = $state<HTMLCanvasElement>();

  /*
   * The canvas is sized from the image, not the layout. When the panel resizes the layout changes straight
   * away but the new image takes a worker round trip. Sizing from the layout would clear the canvas (any change
   * to its width/height does) and leave old pixels that no longer match its size, which `ImageData` rejects.
   * Sized from the image, the old render stays on screen, scaled by CSS, until the new one replaces it.
   */
  const canvasSize = $derived(image ?? layout);

  $effect(() => {
    const context = canvas?.getContext('2d');
    if (!context || !image) return;
    const { width, height, pixels } = image;

    context.clearRect(0, 0, width, height);
    context.putImageData(new ImageData(new Uint8ClampedArray(pixels), width, height), 0, 0);
  });
</script>

<figure aria-busy={!image && !error}>
  {#if error}
    <div class="map message" style:aspect-ratio={placeholderRatio} role="alert">{error}</div>
  {:else if !canvasSize}
    <div class="map" style:aspect-ratio={placeholderRatio}></div>
  {:else}
    <canvas
      bind:this={canvas}
      class="map"
      class:ready={!!image}
      width={canvasSize.width}
      height={canvasSize.height}
      role="img"
      aria-label={alt}
    ></canvas>
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
  }

  canvas {
    opacity: 0;
    transition: opacity 0.25s;
  }

  canvas.ready {
    opacity: 1;
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
</style>
