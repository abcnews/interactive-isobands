import type { GeoProjection } from 'd3-geo';
import type { PlaceLabelAlign } from '../components/PlaceLabel/PlaceLabel.svelte';

/** A labelled point on the map. */
export type Place = {
  name: string;
  longitude: number;
  latitude: number;
  /** Which side of the marker the name sits on. */
  align: PlaceLabelAlign;
};

/** A place projected into the map, as percentages of the panel so labels track the SVG as it scales. */
export type PositionedPlace = Place & { xPercent: number; yPercent: number };

/** State and territory capitals. Which side each name sits on is a design choice. */
export const CAPITAL_CITIES: Place[] = [
  { name: 'Darwin', longitude: 130.8456, latitude: -12.4634, align: 'left' },
  { name: 'Brisbane', longitude: 153.0251, latitude: -27.4698, align: 'right' },
  { name: 'Perth', longitude: 115.8605, latitude: -31.9505, align: 'left' },
  { name: 'Sydney', longitude: 151.2093, latitude: -33.8688, align: 'right' },
  { name: 'Adelaide', longitude: 138.6007, latitude: -34.9285, align: 'left' },
  { name: 'Canberra', longitude: 149.13, latitude: -35.2809, align: 'left' },
  { name: 'Melbourne', longitude: 144.9631, latitude: -37.8136, align: 'right' },
  { name: 'Hobart', longitude: 147.3272, latitude: -42.8821, align: 'right' }
];

/** How close (as a % of the panel width) a dot must be to an edge before its name can run past it. */
const EDGE_ZONE_PERCENT = 25;

/**
 * Which sides of the panel need a gutter: a side does when a name points towards it from a dot
 * near that edge (e.g. Brisbane and Hobart on the east). Names in the middle of the map fit.
 */
export const sidesNeedingGutter = (positioned: PositionedPlace[]) => ({
  left: positioned.some(({ align, xPercent }) => align === 'left' && xPercent < EDGE_ZONE_PERCENT),
  right: positioned.some(({ align, xPercent }) => align === 'right' && xPercent > 100 - EDGE_ZONE_PERCENT)
});

/**
 * Projects places into the panel. Percentages (not px) because the labels are HTML over a scaling
 * SVG: the panel's CSS size differs from the layout's pixel size. Places the projection can't draw
 * are dropped.
 */
export const positionPlaces = ({
  places,
  projection,
  width,
  height
}: {
  places: Place[];
  projection: GeoProjection;
  width: number;
  height: number;
}): PositionedPlace[] =>
  places.flatMap(place => {
    const [x, y] = projection([place.longitude, place.latitude]) ?? [];
    if (x === undefined || y === undefined) return [];
    return [{ ...place, xPercent: (x / width) * 100, yPercent: (y / height) * 100 }];
  });
