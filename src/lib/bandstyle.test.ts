import type { FeatureCollection, MultiPolygon } from 'geojson';
import { describe, expect, it } from 'vitest';
import { applyPalette } from './bandstyle.ts';

const bands: FeatureCollection<MultiPolygon> = {
  type: 'FeatureCollection',
  features: [10, 20].map((classValue) => ({
    type: 'Feature',
    properties: { classValue, lower: classValue - 5 },
    geometry: { type: 'MultiPolygon', coordinates: [] }
  }))
};

describe('applyPalette', () => {
  it('colours each band from its class value and keeps existing properties', () => {
    const [low, high] = applyPalette(bands, (v) => (v < 15 ? '#111111' : '#222222')).features;
    expect(low.properties).toMatchObject({ classValue: 10, lower: 5, fill: '#111111', 'fill-opacity': 1, 'stroke-width': 0 });
    expect(high.properties?.fill).toBe('#222222');
  });

  it('does not change the input', () => {
    applyPalette(bands, () => '#000000');
    expect(bands.features[0].properties).not.toHaveProperty('fill');
  });
});
