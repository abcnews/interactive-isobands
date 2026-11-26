<script lang="ts">
  /**
   * @file
   * This component unpulls a pulled iframe back to the narrow Odyssey breakpoint.
   * The intention is to keep iframe breakpoints consistent when embedding multiple
   * pull widths on the one page, such as on the climate dashboard.
   */
  import type { Snippet } from 'svelte';

  let {
    isUnPulled = true,
    children
  }: {
    isUnPulled?: boolean;
    children?: Snippet;
  } = $props();
</script>

<div class="unpull" class:unpulled={isUnPulled}>
  {@render children?.()}
</div>

<style>
  /*
   * Assumes the content is always rendered inside a pull iframe, so the
   * viewport here is the iframe width (not the parent window width).
   *
   * Mobile, tablet and desktop share one max-width (the desktop normal width).
   * On narrow iframes, width: 100% means the content simply fills the iframe.
   */
  .unpull {
    --unpull-max-width: 621.33px;
    --unpull-max-width-large: 652.68px;
    box-sizing: border-box;
    width: 100%;
  }

  .unpull.unpulled {
    max-width: var(--unpull-max-width);
    margin-inline: auto;
  }

  /* Large desktop: the pull iframe is 1200px wide, normal width is slightly larger. */
  @media (min-width: 1200px) {
    .unpull.unpulled {
      max-width: var(--unpull-max-width-large);
    }
  }
</style>
