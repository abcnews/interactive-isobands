<script lang="ts">
  import type { Snippet } from 'svelte';

  interface Props {
    /** Attribution text and links */
    children: Snippet;
  }

  let { children }: Props = $props();
</script>

<p class="abc-attribution">{@render children()}</p>

<style>
  /* Typography matches ABC figure captions; colours are inherited so the host page controls them. */
  .abc-attribution {
    box-sizing: border-box;
    margin: 0;
    color: inherit;
    font-family: abcsans, 'fallback sans', sans-serif;
    font-size: 12px;
    font-weight: 400;
    line-height: 20px;

    :global(a) {
      color: inherit;
      text-decoration: none;
    }

    :global(a:hover) {
      text-decoration: underline;
    }
  }
</style>
