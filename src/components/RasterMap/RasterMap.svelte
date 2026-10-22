<script lang="ts">
  import type { RasterFrame } from '../../lib/rastergrid.ts';

  interface Props {
    /** Projection fit and boundary mask shared by the panels of a set. Reserves the right space before pixels arrive. */
    frame?: RasterFrame;
    /** RGBA pixels, `frame.layout.width` x `frame.layout.height`. Draws an empty placeholder until supplied. */
    pixels?: Uint8ClampedArray;
    /** Alt text describing the map for screen readers. */
    alt?: string;
    /** Shown in place of the map. */
    error?: string;
    /** Width / height of the space reserved while there is no frame. */
    placeholderRatio?: number;
  }

  let { frame, pixels, alt = 'Raster map', error, placeholderRatio = 4 / 3 }: Props = $props();

  let canvas = $state<HTMLCanvasElement>();

  // Paints the pixels, then keeps only what's inside the boundary (destination-in with the mask).
  $effect(() => {
    const context = canvas?.getContext('2d');
    if (!canvas || !context || !frame || !pixels) return;
    const { width, height } = frame.layout;

    context.clearRect(0, 0, width, height);
    context.putImageData(new ImageData(new Uint8ClampedArray(pixels), width, height), 0, 0);
    context.globalCompositeOperation = 'destination-in';
    context.drawImage(frame.mask, 0, 0);
    context.globalCompositeOperation = 'source-over';
  });
</script>

<figure aria-busy={!pixels && !error}>
  {#if error}
    <div class="map message" style:aspect-ratio={placeholderRatio} role="alert">{error}</div>
  {:else if !frame}
    <div class="map" style:aspect-ratio={placeholderRatio}></div>
  {:else}
    <canvas
      bind:this={canvas}
      class="map"
      class:ready={!!pixels}
      width={frame.layout.width}
      height={frame.layout.height}
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
