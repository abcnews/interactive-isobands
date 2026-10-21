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
  /* Matches ABC article h2 typography; colour is inherited so the host page controls it. */
  .abc-heading {
    box-sizing: border-box;
    margin: 40px 0 16px;
    color: inherit;
    font-family: abcsans, 'fallback sans', sans-serif;
    font-size: 32px;
    font-weight: 700;
    line-height: 40px;
  }

  .abc-heading--centre {
    text-align: center;
  }
</style>
