import { innerWidth } from 'svelte/reactivity/window';

export const MOBILE = 0;
export const TABLET = 1;
export const DESKTOP = 2;
export const LARGE_DESKTOP = 3;

export const BREAKPOINT_NAMES = ['mobile', 'tablet', 'desktop', 'large-desktop'] as const;

type WidthMode = 'inline' | 'pull' | 'unknown';

// The iframe's own URL carries ?width=pull|inline. Anything else is treated as unknown.
const readWidthMode = (): WidthMode => {
  if (typeof window === 'undefined') return 'unknown';

  const widthParameter = new URLSearchParams(window.location.search).get('abcnewsodysseywidth');
  return widthParameter === 'pull' || widthParameter === 'inline' ? widthParameter : 'unknown';
};

const classifyWidth = (width: number, widthMode: WidthMode) => {
  // Each list is ordered largest first; the first entry the width reaches wins.
  const minimumWidthsByMode = {
    // Inline iframes never get wider than ~653px, so large desktop is not reachable.
    // The desktop cutoff must stay at or below 621, the fixed inline desktop width.
    inline: [
      { breakpoint: DESKTOP, minimumWidth: 600 },
      { breakpoint: TABLET, minimumWidth: 513 }
    ],
    // Pull tablet iframes are (page width - 32), so 736 is a ~768px page (iPad portrait).
    pull: [
      { breakpoint: LARGE_DESKTOP, minimumWidth: 1150 },
      { breakpoint: DESKTOP, minimumWidth: 736 },
      { breakpoint: TABLET, minimumWidth: 513 }
    ],
    // Without a mode, use the lowest safe cutoffs so no real desktop is called tablet.
    unknown: [
      { breakpoint: LARGE_DESKTOP, minimumWidth: 1150 },
      { breakpoint: DESKTOP, minimumWidth: 600 },
      { breakpoint: TABLET, minimumWidth: 513 }
    ]
  };

  return minimumWidthsByMode[widthMode].find(({ minimumWidth }) => width >= minimumWidth)?.breakpoint ?? MOBILE;
};

/**
 * Guesses the Odyssey breakpoint from the iframe's own width and ?width= mode.
 *
 * Iframe widths measured in Odyssey (inline / pull):
 *   mobile (page <= 544):  512 / 512
 *   tablet:                scales up from 512 (inline ~0.625 per page px, pull = page - 32)
 *   desktop (page >= 980): 621 / 928
 *   large desktop:         653 / 1200
 *
 * Larger tablets are deliberately treated as desktop.
 * Known limitation: inline large desktop (653px) looks identical to a ~768px
 * page, so it is reported as DESKTOP. Pull large desktop (1200px) is exact.
 */
export function useIframeBreakpoint() {
  const widthMode = readWidthMode();

  // Hidden or lazy iframes report a width of 0, and the server has no width at all.
  // In both cases keep the last real answer instead of flipping to mobile.
  let lastKnownBreakpoint = DESKTOP;

  const breakpoint = $derived.by(() => {
    const width = innerWidth.current;
    if (!width) return lastKnownBreakpoint;

    lastKnownBreakpoint = classifyWidth(width, widthMode);
    return lastKnownBreakpoint;
  });

  const breakpointName = $derived(BREAKPOINT_NAMES[breakpoint]);

  return {
    get breakpoint() {
      return breakpoint;
    },
    get breakpointName() {
      return breakpointName;
    }
  };
}
