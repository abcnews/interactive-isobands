<script lang="ts">
  import { ModularLegend } from '@abcnews/components-dataviz';
  import { SequentialPalette, createContinuousScale } from '@abcnews/palette';
  import ausMd from '../../aus-md.json';
  import type { GeoJsonInput } from '../../lib/fastclip.ts';
  import { DATA_BASE_URL, forecastTitle, formatPanelDate, resolveDateRange } from '../../lib/forecastdates.ts';
  import { colourScheme, createSummerHeatPalette, summerHeatColours, SUMMER_HEAT_THRESHOLDS } from '../../lib/palettes.ts';
  import { createGradientScale, createSteppedScale } from '../../lib/rastergrid.ts';
  import ABCAttribution from '../ABCAttribution/ABCAttribution.svelte';
  import ABCHeading from '../ABCHeading/ABCHeading.svelte';
  import IsobandMapFetch from '../IsobandMap/IsobandMapFetch.svelte';
  import RasterMapFetch from '../RasterMap/RasterMapFetch.svelte';
  import SmallMultiples from '../SmallMultiples/SmallMultiples.svelte';

  type Props = {
    /** First day, YYYY-MM-DD. Defaults to today (Sydney); clamped to the dates that have data. */
    start?: string | null;
    /** Days to add to today (Sydney) for an evergreen start, e.g. `1` for tomorrow. Ignored when `start` is set. */
    startOffset?: string | null;
    /** Number of days, as a string from the URL hash. Defaults to 6; shortened if it would pass the last available date. */
    days?: string | null;
    /** Items to show, `|` separated: TITLE|LEGEND|DATES|ATTRIBUTION (case-insensitive). When set, anything not listed is hidden. */
    show?: string | null;
    /** Items to hide, `|` separated, same names as `show`. Applied after `show`. */
    hide?: string | null;
    /** `raster` draws interpolated canvases from continuous values; anything else (default) draws vector isobands from the banded file. */
    renderer?: string | null;
    /** Filename in each date's folder. Defaults to `aus.tiff` for the raster renderer and `aus-banded.tiff` otherwise. */
    file?: string | null;
    /** Raster only: `smooth` for a continuous gradient; anything else (default) gives stepped bands. */
    look?: string | null;
    /** Raster smooth look only: temperatures at the ends of the gradient. Default to the first and last band thresholds. */
    min?: string | null;
    max?: string | null;
  };

  let { start, startOffset, days, show, hide, renderer, file, look, min, max }: Props = $props();

  /** `TITLE|dates` → Set { 'TITLE', 'DATES' } */
  const parseItems = (list?: string | null) => new Set(list?.toUpperCase().split('|').map(item => item.trim()));

  // An item shows if `show` lists it (or isn't set) and `hide` doesn't.
  const [shown, hidden] = [parseItems(show), parseItems(hide)];
  const isShown = (item: 'TITLE' | 'LEGEND' | 'DATES' | 'ATTRIBUTION') => (!show || shown.has(item)) && !hidden.has(item);

  const ausClip = ausMd as GeoJsonInput;

  // Props come from the hash at load and never change, so reading them once is intended.
  const isRaster = renderer === 'raster';
  const filename = file ?? (isRaster ? 'aus.tiff' : 'aus-banded.tiff');
  const gradientDomain: [number, number] = [
    Number(min ?? SUMMER_HEAT_THRESHOLDS[0]),
    Number(max ?? SUMMER_HEAT_THRESHOLDS.at(-1))
  ];

  /** Follows the parent's light/dark scheme; a new palette re-colours the map. */
  const stepPalette = $derived(createSummerHeatPalette(colourScheme.mode));
  const colourScale = $derived(
    look === 'smooth'
      ? createGradientScale(gradientDomain, createContinuousScale(SequentialPalette.Red, colourScheme.mode, gradientDomain))
      : createSteppedScale(SUMMER_HEAT_THRESHOLDS, summerHeatColours(colourScheme.mode))
  );

  /**
   * Legend swatches: grey for under 25, then one red per band. Labels sit on the boundaries
   * (25, 30 … 45) and both ends are arrows, as the outer bands are open-ended.
   */
  const legendSwatches = $derived(summerHeatColours(colourScheme.mode).map(colour => ({ colour })));
  const legendTicks = SUMMER_HEAT_THRESHOLDS.map(threshold => `${threshold}°`);

  /** Default days shown, as 3 columns x 2 rows on desktop and 2 columns x 3 rows on mobile. */
  const DEFAULT_DAYS = 6;

  const dates = resolveDateRange({ start, startOffset, days, defaultDays: DEFAULT_DAYS });
  const title = forecastTitle({ dates });

  const forecasts = dates.map(ymd => ({
    key: ymd,
    label: formatPanelDate(ymd),
    url: `${DATA_BASE_URL}/ifs-t2m/${ymd}/${filename}`
  }));
</script>

<SmallMultiples items={forecasts} showLabels={isShown('DATES')}>
  {#snippet heading()}
    {#if isShown('TITLE')}
      <ABCHeading centre>{title}</ABCHeading>
    {/if}
    {#if isShown('LEGEND')}
      <div class="legend">
        <ModularLegend discreteLegends={legendSwatches} betweenTicks={legendTicks} continues="both" />
      </div>
    {/if}
  {/snippet}

  {#snippet panel(forecast)}
    {@const alt = `Map of forecast maximum temperatures across Australia for ${forecast.label.replace('\n', ' ')}`}
    {#if isRaster}
      <RasterMapFetch {alt} projection="australia" clipTo={ausClip} url={forecast.url} {colourScale} />
    {:else}
      <IsobandMapFetch {alt} projection="australia" clipTo={ausClip} url={forecast.url} palette={stepPalette} />
    {/if}
  {/snippet}

  {#snippet caption()}
    {#if isShown('ATTRIBUTION')}
      <ABCAttribution>
        Source: <a href="https://www.ecmwf.int/en/forecasts/datasets">ECMWF</a>, © {new Date().getFullYear()} ECMWF,
        <a href="https://creativecommons.org/licenses/by/4.0/">CC BY 4.0</a>, modified into contour bands. ECMWF accepts
        no liability for errors, omissions, availability or loss from use.
      </ABCAttribution>
    {/if}
  {/snippet}
</SmallMultiples>

<style>
  /* The legend caps its swatch widths and left-aligns them, so shrink-wrap it to centre under the heading. */
  .legend {
    width: fit-content;
    max-width: 100%;
    margin-inline: auto;
    /* Extra space before the maps, on top of the figure's grid gap. */
    margin-block-end: 10px;
  }
</style>
