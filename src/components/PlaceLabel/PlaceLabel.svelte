<script lang="ts" module>
  /** Which side of the symbol the text sits on. */
  export type PlaceLabelAlign = 'left' | 'right';
</script>

<script lang="ts">
  import { Symbol } from '@abcnews/components-dataviz';
  import { ColourMode } from '@abcnews/palette';
  import { colourScheme } from '../../lib/palettes.ts';

  interface Props {
    /** Place name, e.g. "Brisbane". */
    label: string;
    /** `right` puts the text to the right of the symbol, `left` to its left. */
    align?: PlaceLabelAlign;
    /** Horizontal position of the symbol's centre, from the left of the nearest positioned ancestor. Number = px; strings are any CSS length. */
    x: number | string;
    /** Vertical position of the symbol's centre, from the top of the nearest positioned ancestor. See `x`. */
    y: number | string;
    /** Show the name beside the symbol. When false, only the symbol is drawn. */
    showText?: boolean;
  }

  let { label, align = 'right', x, y, showText = true }: Props = $props();

  /** Drawn size of the round marker, in CSS px. */
  const SYMBOL_WIDTH = 6;

  const toLength = (value: number | string) => (typeof value === 'number' ? `${value}px` : value);

  /**
   * Light pages get a white dot with a black outline; dark pages a black dot with a white outline.
   * The Symbol's `scheme` sets the outline colour for a symbol drawn *on* that scheme (light → white
   * outline), so we pass the opposite scheme to get the outline we want.
   */
  const isDark = $derived(colourScheme.mode === ColourMode.Dark);
  const symbolColour = $derived(isDark ? 'black' : 'white');
  const symbolScheme = $derived(isDark ? 'light' : 'dark');
</script>

<!-- Decorative on a map that already has alt text, so hidden from screen readers like the lines. -->
<div class="place-label" aria-hidden="true" data-align={align} style:left={toLength(x)} style:top={toLength(y)} style:--symbol-width="{SYMBOL_WIDTH}px">
  <Symbol name="circle" variant="fill" width={SYMBOL_WIDTH} colour={symbolColour} scheme={symbolScheme} />
  {#if showText}
    <span class="text">{label}</span>
  {/if}
</div>

<style>
  /* ---- Placement ----
     The wrapper's top-left sits on (x, y); the transform moves the symbol's centre onto that point.
     Left-aligned labels reverse the row, so the symbol is at the right end instead. */
  .place-label {
    position: absolute;
    display: flex;
    align-items: center;
    gap: 6px;
    pointer-events: none;
    white-space: nowrap;
    transform: translate(calc(var(--symbol-width) / -2), -50%);

    &[data-align='left'] {
      flex-direction: row-reverse;
      transform: translate(calc(-100% + var(--symbol-width) / 2), -50%);
    }
  }

  /* ---- Text: "Marker Regular/sm" with the "LabelGlow" halo ---- */
  .text {
    --text-colour: var(--Text-text-primary, #000);
    --glow-colour: var(--ForegroundInverse, #fff);
    @media (prefers-color-scheme: dark) {
      --text-colour: var(--Text-text-primary, #fff);
      --glow-colour: var(--ForegroundInverse, #000);
    }

    color: var(--text-colour);
    text-wrap-style: balance;
    font-feature-settings: 'ss01' on;
    text-shadow:
      0 0 1px var(--glow-colour),
      0 0 1px var(--glow-colour),
      0 0 2px var(--glow-colour),
      0 0 2px var(--glow-colour);
    font-family: 'ABC Sans Nova', sans-serif;
    font-size: 14px;
    /* Mobile: same breakpoint SmallMultiples uses for its tighter grid. */
    @media (max-width: 480px) {
      font-size: 12px;
    }
    font-style: normal;
    font-weight: 400;
    line-height: 100%;
    letter-spacing: 0.42px;
  }
</style>
