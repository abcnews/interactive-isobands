import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { describe, it } from 'vitest';
import { fitProjection, type ProjectionId } from './geo.ts';
import {
  buildSampleMap,
  choosePixelWidth,
  createGradientScale,
  createSteppedScale,
  paintPixels,
  renderRasterPixels,
  sampleBilinear,
  type RasterGrid,
  type RasterLayout
} from './rastergrid.ts';

/** 2x2 grid covering lon 0-2, lat 0-2, north-up. */
const grid = (values: number[], noData: number | null = null): RasterGrid => ({
  values,
  width: 2,
  height: 2,
  origin: [0, 2],
  resolution: [1, -1],
  noData
});

describe('sampleBilinear', () => {
  it('returns pixel values at pixel centres', () => {
    assert.equal(sampleBilinear(grid([1, 2, 3, 4]), 1, 0), 2);
  });

  it('blends between pixel centres', () => {
    assert.equal(sampleBilinear(grid([0, 10, 0, 10]), 0.5, 0), 5);
  });

  it('re-weights around nodata instead of fading', () => {
    assert.equal(sampleBilinear(grid([-9999, 10, 10, 10], -9999), 0.5, 0.5), 10);
  });

  it('is NaN beyond half a pixel outside the grid', () => {
    assert.ok(Number.isNaN(sampleBilinear(grid([1, 2, 3, 4]), -0.6, 0)));
  });
});

describe('buildSampleMap', () => {
  it('maps pixels to fractional grid positions', () => {
    // Identity-ish projection: 2x2 output where pixel (x, y) is lon x+.5, lat 2-(y+.5).
    const map = buildSampleMap({ invert: ([x, y]) => [x, 2 - y] }, { width: 2, height: 2 }, grid([1, 2, 3, 4]));
    assert.deepEqual([...map.slice(0, 2)], [0, 0]);
    assert.deepEqual([...map.slice(6, 8)], [1, 1]);
  });

  it('leaves NaN where the projection has no inverse', () => {
    const map = buildSampleMap({ invert: () => null }, { width: 1, height: 1 }, grid([1, 2, 3, 4]));
    assert.ok(Number.isNaN(map[0]));
  });
});

describe('colour scales', () => {
  it('packs colours as ABGR', () => {
    const scale = createSteppedScale([10, 20], ['#0000ff', '#00ff00', 'rgb(255, 0, 0)']);
    assert.deepEqual(scale.colours, [0xffff0000, 0xff00ff00, 0xff0000ff]);
  });

  it('needs one more colour than thresholds', () => {
    assert.throws(() => createSteppedScale([10, 20], ['#000', '#fff']));
  });

  it('paints transparent where there is no data and colours elsewhere', () => {
    const scale = createGradientScale([0, 10], v => (v > 5 ? '#ffffff' : '#000000'));
    const pixels = paintPixels(grid([10, 10, 10, 10]), new Float32Array([0, 0, Number.NaN, Number.NaN]), scale, { width: 2, height: 1 });
    assert.deepEqual([...pixels], [255, 255, 255, 255, 0, 0, 0, 0]);
  });
});

describe('choosePixelWidth', () => {
  it('waits for a measurement', () => {
    assert.equal(choosePixelWidth(0, 2), undefined);
    assert.equal(choosePixelWidth(Number.NaN, 2), undefined);
  });

  it('scales by device pixel ratio and rounds up to a step', () => {
    assert.equal(choosePixelWidth(230, 1), 300);
    assert.equal(choosePixelWidth(230, 2), 500);
    assert.equal(choosePixelWidth(300, 1), 300);
  });

  it('gives near-identical panels the same width', () => {
    assert.equal(choosePixelWidth(229, 2), choosePixelWidth(231, 2));
  });

  it('clamps to sensible limits', () => {
    assert.equal(choosePixelWidth(50, 1), 200);
    assert.equal(choosePixelWidth(2000, 3), 1600);
  });

  it('treats a bad pixel ratio as 1', () => {
    assert.equal(choosePixelWidth(230, 0), 300);
  });
});

/*
 * Runs the real pipeline (GeoTIFF read, sample map, paint) in Node against the bundled sample raster.
 * It checks the output is sane and that the sample map is reused between panels.
 */

const tiffBytes = readFileSync(new URL('../../public/aus-banded.tiff', import.meta.url));
const tiff = tiffBytes.buffer.slice(tiffBytes.byteOffset, tiffBytes.byteOffset + tiffBytes.byteLength) as ArrayBuffer;
const boundary = JSON.parse(readFileSync(new URL('../aus-md.json', import.meta.url), 'utf8'));

const stepped = createSteppedScale([25, 30, 35, 40, 45], ['#999999', '#999999', '#cc0000', '#cc0000', '#cc0000', '#cc0000']);
/** Red channel rises with the value, so every sampled value gets its own colour. */
const smooth = createGradientScale([20, 45], value =>
  `#${Math.round(Math.min(255, Math.max(0, ((value - 20) / 25) * 255))).toString(16).padStart(2, '0')}0000`
);

/** Fits the Australian projection to the boundary at a pixel width, as `createRasterFrame` does in the browser. */
const layoutAt = (width: number, projectionId: ProjectionId = 'australia'): RasterLayout => {
  const fit = fitProjection(projectionId, boundary, false, width, 0)!;
  const [x, y] = fit.projection.translate();
  return { projectionId, centreLon: 0, scale: fit.projection.scale(), translate: [x, y], width, height: fit.height };
};

/** Fraction of pixels that are not fully transparent. */
const coverage = (pixels: Uint8ClampedArray) =>
  pixels.filter((_, i) => i % 4 === 3 && pixels[i] > 0).length / (pixels.length / 4);

describe('renderRasterPixels', () => {
  it('paints data inside the map and leaves the corners transparent', async () => {
    const layout = layoutAt(300);
    const { pixels } = await renderRasterPixels(tiff.slice(0), layout, stepped);

    assert.equal(pixels.length, layout.width * layout.height * 4);
    assert.ok(coverage(pixels) > 0.3, 'expected a good share of pixels to have data');
    assert.equal(pixels[3], 0, 'top-left corner is outside the raster');
  });

  it('gradient output uses more distinct colours than stepped output', async () => {
    const layout = layoutAt(300);
    const distinctColours = async (scale: typeof stepped) => {
      const { pixels } = await renderRasterPixels(tiff.slice(0), layout, scale);
      return new Set(new Uint32Array(pixels.buffer)).size;
    };
    assert.ok((await distinctColours(smooth)) > (await distinctColours(stepped)));
  });

  it('reuses the sample map for the same layout and grid', async () => {
    const layout = layoutAt(300);
    await renderRasterPixels(tiff.slice(0), layout, stepped);
    const { reusedSampleMap } = await renderRasterPixels(tiff.slice(0), layout, stepped);
    assert.equal(reusedSampleMap, true);
  });

  it('rebuilds the sample map when the layout changes', async () => {
    await renderRasterPixels(tiff.slice(0), layoutAt(300), stepped);
    const { reusedSampleMap } = await renderRasterPixels(tiff.slice(0), layoutAt(400), stepped);
    assert.equal(reusedSampleMap, false);
  });

  it('builds the sample map once for six panels in turn, as the single worker will', async () => {
    const layout = layoutAt(500);
    const results = [];
    for (let panel = 0; panel < 6; panel++) results.push(await renderRasterPixels(tiff.slice(0), layout, stepped));

    assert.equal(results.filter(({ reusedSampleMap }) => reusedSampleMap).length, 5);
  });
});
