<script lang="ts">
  import type { Snippet } from 'svelte';

  interface Props {
    /** Heading text */
    children: Snippet;
    /** Centre-aligns the text */
    centre?: boolean;
  }

  let { children, centre = false }: Props = $props();
</script>

<!-- An h1 because the graphic lives in an iframe, so this is the top heading of its own document. -->
<h1 class="abc-heading" class:abc-heading--centre={centre}>{@render children()}</h1>

<style>
  /*
   * ABC "Viz Heading Bold/xs", the same at every width. No margin: the parent layout sets the spacing.
   * Colour is inherited so the host page controls it, including dark mode.
   */
  .abc-heading {
    box-sizing: border-box;
    margin: 0;
    color: inherit;
    font-family: abcsans, 'fallback sans', sans-serif;
    font-size: 18px;
    font-weight: 700;
    line-height: 1.25;
    text-wrap: balance;
  }

  .abc-heading--centre {
    text-align: center;
  }
</style>
