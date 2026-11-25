import { WorkerClient } from 'workiq';
import { encodePng, renderRasterPixels, type ColourScale, type RasterLayout, type RenderedImage } from './rastergrid.ts';

/** What the host sends for a `renderRaster` job. */
export type RenderRasterJob = {
  buffer: ArrayBuffer;
  layout: RasterLayout;
  colourScale: ColourScale;
};

new WorkerClient({
  // PNG-encoded here, off the main thread: a much smaller message than raw RGBA, and ready for an SVG <image>.
  // workiq wants [payload, transferList]; a Blob is passed by reference, so there's nothing to transfer.
  renderRaster: async ({ buffer, layout, colourScale }: RenderRasterJob): Promise<[RenderedImage, Transferable[]]> => {
    const { pixels, reusedSampleMap } = await renderRasterPixels(buffer, layout, colourScale);
    return [{ blob: await encodePng(pixels, layout.width, layout.height), reusedSampleMap }, []];
  }
});
