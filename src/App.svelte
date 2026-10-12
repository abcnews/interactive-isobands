<script lang="ts">
import IsobandMap from './components/IsobandMap/IsobandMap.svelte'
import ausClip from './aus-md.json'
import { ColourMode, SequentialPalette, getSequentialSteppedPalette } from '@abcnews/palette';

  // [grey, 25, 30, 35, 40, 45+]
  const colours = getSequentialSteppedPalette(5, SequentialPalette.Red, ColourMode.Light);

  // Lower bound of each coloured band. Anything below 25 gets colours[0].
  const thresholds = [25, 30, 35, 40, 45];

  const palette = (value: number): string => colours[thresholds.filter((t) => value >= t).length];

</script>

<main>
{#each Array.from({length:6})}
  <div style="width:300px;position:relative;">
  <IsobandMap name="Australia" clipTo={ausClip} url="/aus-banded.tiff" palette={palette} />
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
