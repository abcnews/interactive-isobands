<script lang="ts">
  import SmallMultiplesForecastTemp from './components/SmallMultiplesForecastTemp/SmallMultiplesForecastTemp.svelte';
  import { TypographyProvider } from '@abcnews/components-storylab';

  // The iframe is routed by its hash, e.g. `#viz=SmallMultiplesForecastTemp&start=2026-10-20&days=4`.
  const params = new URLSearchParams(window.location.hash.replace(/^#/, ''));
  const viz = params.get('viz') ?? 'SmallMultiplesForecastTemp';
  const [start, days, show] = [params.get('start'), params.get('days'), params.get('show')];
</script>

<TypographyProvider>
  {#if viz === 'SmallMultiplesForecastTemp'}
    <SmallMultiplesForecastTemp {start} {days} {show} />
  {:else}
    <p>Unknown viz: {viz}</p>
  {/if}
</TypographyProvider>
