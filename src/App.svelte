<script lang="ts">
  import SmallMultiplesForecastTemp from './components/SmallMultiplesForecastTemp/SmallMultiplesForecastTemp.svelte';
  import { TypographyProvider } from '@abcnews/components-storylab';

  // The iframe is routed by its hash, e.g. `#viz=SmallMultiplesForecastTemp&start=2026-10-20&days=4`.
  const params = new URLSearchParams(window.location.hash.replace(/^#/, ''));
  const viz = params.get('viz') ?? 'SmallMultiplesForecastTemp';
  const [start, days, show, renderer, file, look, min, max] = ['start', 'days', 'show', 'renderer', 'file', 'look', 'min', 'max'].map(name =>
    params.get(name)
  );
</script>

<TypographyProvider>
  {#if viz === 'SmallMultiplesForecastTemp'}
    <SmallMultiplesForecastTemp {start} {days} {show} {renderer} {file} {look} {min} {max} />
  {:else}
    <p>Unknown viz: {viz}</p>
  {/if}
</TypographyProvider>

<style>
  /* The iframe must show the parent page through it. */
  :global(html, body) {
    background: transparent;
  }
</style>
