<script lang="ts" generics="T extends { key: string; label: string }">
  import type { Snippet } from 'svelte';

  interface Props {
    /** Panels to show; `key` identifies each one and `label` is the text above it */
    items: T[];
    /** Heading rendered above the grid */
    heading?: Snippet;
    /** Content of a single panel, below its label */
    panel: Snippet<[T]>;
    /** Attribution or notes rendered below the grid */
    caption?: Snippet;
    /** Narrowest width (px) of the figure's own box that gets three columns instead of two */
    desktopMinWidth?: number;
    /** Whether to render each panel's label */
    showLabels?: boolean;
  }

  let { items, heading, panel, caption, desktopMinWidth = 544, showLabels = true }: Props = $props();

  // Measured on the figure itself rather than with a viewport media query: embeds sit in columns and
  // iframes that are narrower than the window, so the viewport width says nothing about the space we have.
  let figureWidth = $state(0);
  const isDesktop = $derived(figureWidth >= desktopMinWidth);
  // Never more columns than panels, so a single panel (days=1) fills the full width.
  const columns = $derived(Math.min(items.length || 1, isDesktop ? 3 : 2));
</script>

<figure bind:clientWidth={figureWidth}>
  {@render heading?.()}
  <ul style:grid-template-columns="repeat({columns}, minmax(0, 1fr))">
    {#each items as item (item.key)}
      <li>
        {#if showLabels}<p>{item.label}</p>{/if}
        {@render panel(item)}
      </li>
    {/each}
  </ul>
  {#if caption}
    <figcaption>{@render caption()}</figcaption>
  {/if}
</figure>

<style lang="scss">
  figure {
    font-family: var(--sl-font-stack-sans);
    display: grid;
    gap: 2rem;
    margin: 0;
  }

  ul {
    display: grid;
    gap: 3rem;
    margin: 0;
    padding: 0;
    list-style: none;
    @media (max-width: 480px) {
      gap: 2rem;
    }
  }

  li {
    min-width: 0;
  }

  /* Matches ABC article paragraph typography; colour is inherited from the host page. */
  li p {
    margin: 0 0 8px;
    font-size: 18px;
    line-height: 27px;
    text-align: center;
  }
</style>
