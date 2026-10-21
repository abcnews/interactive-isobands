import type { FeatureCollection, MultiPolygon } from 'geojson';

/** Maps a band's class value to a CSS colour string. */
export type BandPalette = (value: number) => string;

const STYLE_FILL_OPACITY = 1;

/**
 * Adds simplestyle-spec properties, colouring each band with the given palette function.
 * Kept apart from the contouring code so the main thread can recolour worker output (functions can't
 * be posted to a worker) without bundling the contouring dependencies.
 */
export const applyPalette = (
  collection: FeatureCollection<MultiPolygon>,
  palette: BandPalette,
  propertyName = 'classValue'
): FeatureCollection<MultiPolygon> => ({
  ...collection,
  features: collection.features.map((feature) => ({
    ...feature,
    properties: {
      ...feature.properties,
      fill: palette(Number(feature.properties?.[propertyName])),
      'fill-opacity': STYLE_FILL_OPACITY,
      'stroke-width': 0,
      'stroke-opacity': 0
    }
  }))
});
