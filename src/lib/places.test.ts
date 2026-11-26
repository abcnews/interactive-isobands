import { geoIdentity, type GeoProjection } from 'd3-geo';
import { describe, expect, it } from 'vitest';
import { CAPITAL_CITIES, positionPlaces, sidesNeedingGutter } from './places.ts';

describe('positionPlaces', () => {
  it('converts projected pixels to panel percentages', () => {
    // Identity with y flipped: lon/lat map straight to px.
    const projection = geoIdentity().reflectY(true) as unknown as GeoProjection;
    const [place] = positionPlaces({
      places: [{ name: 'Test', longitude: 50, latitude: -25, align: 'left' }],
      projection,
      width: 200,
      height: 100
    });
    expect(place).toMatchObject({ name: 'Test', align: 'left', xPercent: 25, yPercent: 25 });
  });

  it('drops places the projection cannot draw', () => {
    // Real projections return null for points they clip away.
    const projection = (() => null) as unknown as GeoProjection;
    expect(positionPlaces({ places: CAPITAL_CITIES, projection, width: 100, height: 100 })).toEqual([]);
  });
});

describe('sidesNeedingGutter', () => {
  const at = (xPercent: number, align: 'left' | 'right') => ({ name: 'Test', longitude: 0, latitude: 0, align, xPercent, yPercent: 50 });

  it('wants a gutter only where a name points at a nearby edge', () => {
    expect(sidesNeedingGutter([at(90, 'right'), at(50, 'left')])).toEqual({ left: false, right: true });
    expect(sidesNeedingGutter([at(10, 'left'), at(10, 'right')])).toEqual({ left: true, right: false });
  });
});
