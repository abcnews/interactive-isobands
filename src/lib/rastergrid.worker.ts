import { WorkerClient } from 'workiq';
import { renderRasterPixels, type ColourScale, type RasterLayout } from './rastergrid.ts';

/** What the host sends for a `renderRaster` job. */
export type RenderRasterJob = {
  buffer: ArrayBuffer;
  layout: RasterLayout;
  colourScale: ColourScale;
};

new WorkerClient({
  renderRaster: async ({ buffer, layout, colourScale }: RenderRasterJob) => {
    const result = await renderRasterPixels(buffer, layout, colourScale);
    return [result, [result.pixels.buffer]];
  }
});
