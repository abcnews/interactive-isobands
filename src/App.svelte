<script lang="ts">
import IsobandMap from './components/IsobandMap/IsobandMap.svelte'
import ausClip from './aus-md.json'
import { ColourMode, SequentialPalette, getSequentialSteppedPalette } from '@abcnews/palette';

  // [grey, 25, 30, 35, 40, 45+]
  const colours = getSequentialSteppedPalette(5, SequentialPalette.Red, ColourMode.Light);

  // Lower bound of each coloured band. Anything below 25 gets colours[0].
  const thresholds = [25, 30, 35, 40, 45];

  const palette = (value: number): string => colours[thresholds.filter((t) => value >= t).length];

const logPalette = val => {
  console.log({val});
  return palette(val);
}

const forecasts = Array.from({length:6}).map((_,i) => {
  const targetDate = new Date(Date.now() + i*1000*60*60*24);
  const ymd = [
    targetDate.getFullYear(),
    targetDate.getMonth()+1,
    targetDate.getDate()
  ].map(val => String(val).padStart(2,'0')).join('-')

  return ({
  url: `https://abcnewsdata.sgp1.digitaloceanspaces.com/service-ecmwf-gridded-forecasts/ifs-t2m/${ymd}/aus-banded.tiff`,
  ymd: ymd
})
})
</script>

<main>
{#each forecasts as forecast}
  <div style="width:300px;position:relative;">
  <IsobandMap name={forecast.ymd} clipTo={ausClip} url={forecast.url} palette={logPalette} />
  </div>
{/each}
</main>

<style lang="scss">
  .container {
    margin: 0;
    padding: 0;
    font-family: 'ABCSans', sans-serif;
    text-align: center;
    padding: 1rem;
  }
  main{
    display:flex;
    flex-wrap: wrap;
  }
</style>
