<script lang="ts">
  import { SequentialPalette, createContinuousScale } from '@abcnews/palette';
  import ausMd from '../../aus-md.json';
  import type { GeoJsonInput } from '../../lib/fastclip.ts';
  import { DATA_BASE_URL, resolveDateRange } from '../../lib/forecastdates.ts';
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
    /** Number of days, as a string from the URL hash. Defaults to 6; shortened if it would pass the last available date. */
    days?: string | null;
    /** Items to show, `|` separated: TITLE|DATES|ATTRIBUTION (case-insensitive). When set, anything not listed is hidden. */
    show?: string | null;
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

  let { start, days, show, renderer, file, look, min, max }: Props = $props();

  const visible = show ? new Set(show.toUpperCase().split('|').map(item => item.trim())) : undefined;
  const isShown = (item: 'TITLE' | 'DATES' | 'ATTRIBUTION') => !visible || visible.has(item);

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

  /** Default days shown, as 3 columns x 2 rows on desktop and 2 columns x 3 rows on mobile. */
  const DEFAULT_DAYS = 6;

  const forecasts = resolveDateRange({ start, days, defaultDays: DEFAULT_DAYS }).map(ymd => ({
    key: ymd,
    // Noon UTC so the label stays on the right calendar day in any browser time zone.
    label: new Date(`${ymd}T12:00:00Z`).toLocaleDateString('en-AU', {
      weekday: 'long',
      day: 'numeric',
      month: 'short',
      timeZone: 'UTC'
    }),
    url: `${DATA_BASE_URL}/ifs-t2m/${ymd}/${filename}`
  }));
</script>

<SmallMultiples items={forecasts} showLabels={isShown('DATES')}>
  {#snippet heading()}
    {#if isShown('TITLE')}
      <ABCHeading centre>High temperature forecast</ABCHeading>
    {/if}
  {/snippet}

  {#snippet panel(forecast)}
    {@const alt = `Map of forecast maximum temperatures across Australia for ${forecast.label}`}
    {#if isRaster}
      <RasterMapFetch {alt} projection="australia" clipTo={ausClip} url={forecast.url} {colourScale} />
    {:else}
      <IsobandMapFetch {alt} projection="australia" clipTo={ausClip} url={forecast.url} palette={stepPalette} />
    {/if}
  {/snippet}

  {#snippet caption()}
    {#if isShown('ATTRIBUTION')}
      <ABCAttribution>
        Data: <a href="https://www.ecmwf.int/en/forecasts/datasets">ECMWF</a>, © {new Date().getFullYear()} ECMWF,
        <a href="https://creativecommons.org/licenses/by/4.0/">CC BY 4.0</a>, modified into contour bands. ECMWF accepts
        no liability for errors, omissions, availability or loss from use.
      </ABCAttribution>
    {/if}
  {/snippet}
</SmallMultiples>
