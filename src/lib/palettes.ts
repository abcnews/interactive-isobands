import { ColourMode, SequentialPalette, getSequentialSteppedPalette } from '@abcnews/palette';
import { MediaQuery } from 'svelte/reactivity';

/**
 * The colour scheme in use. Inside an iframe, `prefers-color-scheme` reflects the `color-scheme`
 * the parent page sets on the embedding element (index.html declares `dark light`, so we accept
 * either), so this follows the host page rather than only the operating system.
 */
const prefersDark = new MediaQuery('prefers-color-scheme: dark');

export const colourScheme = {
  get mode() {
    return prefersDark.current ? ColourMode.Dark : ColourMode.Light;
  }
};

/**
 * "Summer heat": a stepped (not interpolated) red palette.
 * Colours are [grey, 25-30, 30-35, 35-40, 40-45, 45+]; anything under 25 gets the grey.
 */
export const SUMMER_HEAT_THRESHOLDS = [25, 30, 35, 40, 45];

const summerHeatColours = (mode: ColourMode) =>
  getSequentialSteppedPalette(SUMMER_HEAT_THRESHOLDS.length, SequentialPalette.Red, mode);

/**
 * Summer heat for the given colour mode. Dark mode needs its own steps (not just the light ones)
 * so the greys and reds keep their contrast against a dark page.
 */
export const createSummerHeatPalette = (mode: ColourMode) => {
  const colours = summerHeatColours(mode);
  return (value: number): string => {
    const step = SUMMER_HEAT_THRESHOLDS.filter((t) => value >= t).length;
    return colours[Math.min(step, colours.length - 1)];
  };
};

/** Colour for values outside a custom min/max: the grey the Summer heat palette uses below its first threshold. */
export const OUT_OF_RANGE_COLOUR = summerHeatColours(ColourMode.Light)[0];

export const summerHeatPalette = createSummerHeatPalette(ColourMode.Light);
