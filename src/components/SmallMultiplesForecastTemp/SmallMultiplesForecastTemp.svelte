<script lang="ts">
  import ausMd from '../../aus-md.json';
  import type { GeoJsonInput } from '../../lib/fastclip.ts';
  import { summerHeatPalette } from '../../lib/palettes.ts';
  import ABCAttribution from '../ABCAttribution/ABCAttribution.svelte';
  import ABCHeading from '../ABCHeading/ABCHeading.svelte';
  import IsobandMapFetch from '../IsobandMap/IsobandMapFetch.svelte';
  import SmallMultiples from '../SmallMultiples/SmallMultiples.svelte';

  const ausClip = ausMd as GeoJsonInput;

  /** Days shown, as 3 columns x 2 rows on desktop and 2 columns x 3 rows on mobile. */
  const DAYS = 6;

  const forecasts = Array.from({ length: DAYS }).map((_, i) => {
    const targetDate = new Date(Date.now() + i * 1000 * 60 * 60 * 24);
    const ymd = [targetDate.getFullYear(), targetDate.getMonth() + 1, targetDate.getDate()]
      .map(val => String(val).padStart(2, '0'))
      .join('-');

    return {
      key: ymd,
      label: targetDate.toLocaleDateString('en-AU', { weekday: 'long', day: 'numeric', month: 'short' }),
      url: `https://abcnewsdata.sgp1.digitaloceanspaces.com/service-ecmwf-gridded-forecasts/ifs-t2m/${ymd}/aus-banded.tiff`
    };
  });
</script>

<SmallMultiples items={forecasts}>
  {#snippet heading()}
    <ABCHeading centre>High temperature forecast</ABCHeading>
  {/snippet}

  {#snippet panel(forecast)}
    <IsobandMapFetch
      alt="Map of forecast maximum temperatures across Australia for {forecast.label}"
      projection="australia"
      clipTo={ausClip}
      url={forecast.url}
      palette={summerHeatPalette}
    />
  {/snippet}

  {#snippet caption()}
    <ABCAttribution>
      Data: <a href="https://www.ecmwf.int/en/forecasts/datasets">ECMWF</a>, © {new Date().getFullYear()} ECMWF,
      <a href="https://creativecommons.org/licenses/by/4.0/">CC BY 4.0</a>, modified into contour bands. ECMWF accepts
      no liability for errors, omissions, availability or loss from use.
    </ABCAttribution>
  {/snippet}
</SmallMultiples>
