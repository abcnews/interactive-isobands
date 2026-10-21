import { geoContains } from 'd3-geo';
import type { FeatureCollection } from 'geojson';
import { describe, expect, it } from 'vitest';
import {
  area,
  bandCount,
  buildLayout,
  centreLongitude,
  collectPolygons,
  defaultProjectionFor,
  invertShape,
  niceInterval,
  preparePolygon,
  rangeFor,
  rewind,
  simplestyle
} from './geo.ts';

/** Anticlockwise (y up) square, as RFC 7946 wants for an exterior ring. */
const square = (x: number, y: number, size = 10) => [
  [x, y],
  [x + size, y],
  [x + size, y + size],
  [x, y + size],
  [x, y]
];

const bandsOf = (...rings: number[][][]): FeatureCollection => ({
  type: 'FeatureCollection',
  features: rings.map((ring) => ({
    type: 'Feature',
    properties: { fill: '#ff0000' },
    geometry: { type: 'Polygon', coordinates: [ring] }
  }))
});

describe('rewind', () => {
  it('winds exterior rings clockwise and holes anticlockwise', () => {
    const [exterior, hole] = rewind([square(0, 0, 10), square(2, 2, 2)]);
    expect(area(exterior)).toBeGreaterThan(0);
    expect(area(hole)).toBeLessThan(0);
  });
});

describe('simplestyle', () => {
  it('falls back to defaults for missing, null and non-numeric values', () => {
    expect(simplestyle({ fill: null, 'fill-opacity': 'x', 'stroke-width': null })).toEqual({
      fill: '#555555',
      fillOpacity: 0.6,
      stroke: 'none',
      strokeOpacity: 1,
      strokeWidth: 2
    });
  });

  it('reads numeric strings', () => {
    expect(simplestyle({ 'fill-opacity': '0.25' }).fillOpacity).toBe(0.25);
  });
});

describe('bands and ranges', () => {
  it('counts bands without float noise', () => {
    expect(bandCount(0, 1.1, 0.1)).toBe(11);
    expect(bandCount(5, 5, 1)).toBe(0);
  });

  it('picks a 1/2/5/10 interval', () => {
    expect(niceInterval(100)).toBe(10);
    expect(niceInterval(23)).toBe(5);
    expect(niceInterval(15)).toBe(2);
  });

  it('snaps a data range to its interval', () => {
    expect(rangeFor({ min: 3.2, max: 47.9 })).toEqual({ min: 0, max: 50, interval: 5, neutral: 25 });
    expect(rangeFor({ min: 7.4, max: 7.4 })).toMatchObject({ min: 7, max: 8, interval: 1 });
  });
});

describe('projection helpers', () => {
  it('keeps the Australian conic only for data around Australia', () => {
    expect(defaultProjectionFor([110, -45, 155, -10])).toBe('australia');
    expect(defaultProjectionFor([-180, -90, 180, 90])).toBe('equal-earth');
    expect(defaultProjectionFor([0, 0, 360, 90])).toBe('equal-earth');
    expect(defaultProjectionFor(undefined)).toBe('equal-earth');
  });

  it('centres compact regions across the antimeridian', () => {
    const fiji = [[177, -18], [179, -17], [-179, -16], [-178, -19]];
    expect(centreLongitude(fiji).mode).toBe('wrapped');
    expect(centreLongitude(fiji).centre).toBeCloseTo(179.5);
  });

  it('centres world-spanning data on the plain extent', () => {
    expect(centreLongitude([[-170, 0], [-60, 0], [10, 0], [120, 0], [170, 0]]).mode).toBe('planar');
  });
});

describe('invertShape', () => {
  it('cuts the shape out of a frame that covers the raster', () => {
    const shape = bandsOf(square(10, 10));
    const result = invertShape(shape, [0, 0, 30, 30]);
    if (!('shape' in result)) throw new Error('expected a shape');
    expect(result.holes).toBe(1);
    expect(result.frame).toEqual({ west: -1, south: -1, east: 31, north: 31 });
    const [[frame, hole]] = collectPolygons(result.shape);
    expect(area(frame)).toBeLessThan(0); // anticlockwise
    expect(area(hole)).toBeGreaterThan(0); // clockwise
  });

  it('reports shapes with no polygons', () => {
    const result = invertShape({ type: 'FeatureCollection', features: [] }, undefined);
    expect('problem' in result).toBe(true);
  });
});

describe('buildLayout', () => {
  it('returns nothing without bands', () => {
    expect(buildLayout({})).toBeUndefined();
    expect(buildLayout({ bands: bandsOf() })).toBeUndefined();
  });

  it('projects bands to paths with a data-driven height', () => {
    const layout = buildLayout({ bands: bandsOf(square(130, -30)), projection: 'equal-earth' });
    expect(layout?.width).toBe(1000);
    expect(layout?.height).toBeGreaterThan(0);
    expect(layout?.paths).toHaveLength(1);
    expect(layout?.paths[0].d).toMatch(/^M/);
    expect(layout?.paths[0].fill).toBe('#ff0000');
  });

  it('drops near-collinear slivers that d3 would read as the whole globe', () => {
    const sliver = [[23.88698, 8.61973], [23.80581, 8.66632], [24.56737, 8.22919], [23.88698, 8.61973]];
    expect(buildLayout({ bands: bandsOf(square(130, -30), sliver) })?.paths).toHaveLength(1);
  });

  it('keeps the filled side of a polygon circling the pole', () => {
    const strip = [[-180, -80], [-90, -80], [0, -80], [90, -80], [180, -80], [180, -90], [-180, -90], [-180, -80]];
    const prepared = preparePolygon([strip])!;
    const feature = { type: 'Polygon', coordinates: prepared } as const;
    expect(geoContains(feature, [0, -89])).toBe(true);
    expect(geoContains(feature, [0, 0])).toBe(false);
  });

  it('drops degenerate polygons', () => {
    const bands = bandsOf(square(130, -30), [[0, 0], [1, 1], [0, 0]]);
    expect(buildLayout({ bands })?.paths).toHaveLength(1);
  });

  it('fits Web Mercator without producing non-finite paths at the poles', () => {
    // Vertices every 60 degrees, as real band geometry has: four sparse corners would look like a region wrapping the antimeridian.
    const lons = [-180, -120, -60, 0, 60, 120, 180];
    const ring = [...lons.map((lon) => [lon, -90]), ...lons.toReversed().map((lon) => [lon, 90]), [-180, -90]];
    const layout = buildLayout({ bands: bandsOf(ring), projection: 'mercator' });
    expect(layout?.paths[0].d).toBeTruthy();
    expect(layout?.paths[0].d).not.toMatch(/NaN|Infinity/);
  });
});
