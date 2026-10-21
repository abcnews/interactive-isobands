import { ColourMode, SequentialPalette, getSequentialSteppedPalette } from '@abcnews/palette';

/**
 * "Summer heat": a stepped (not interpolated) red palette.
 * Colours are [grey, 25-30, 30-35, 35-40, 40-45, 45+]; anything under 25 gets the grey.
 */
export const SUMMER_HEAT_THRESHOLDS = [25, 30, 35, 40, 45];

const SUMMER_HEAT_COLOURS = getSequentialSteppedPalette(SUMMER_HEAT_THRESHOLDS.length, SequentialPalette.Red, ColourMode.Light);

/** Colour for values outside a custom min/max: the grey the Summer heat palette uses below its first threshold. */
export const OUT_OF_RANGE_COLOUR = SUMMER_HEAT_COLOURS[0];

export const summerHeatPalette = (value: number): string => {
  const step = SUMMER_HEAT_THRESHOLDS.filter((t) => value >= t).length;
  return SUMMER_HEAT_COLOURS[Math.min(step, SUMMER_HEAT_COLOURS.length - 1)];
};
