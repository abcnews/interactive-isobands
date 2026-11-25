<script lang="ts">
  import { getLayerCakeContext } from 'layercake';
  import type { MapCakeCustom } from '../RasterMap.svelte';

  interface Props {
    /** URL of the rendered PNG. */
    href: string;
    /** Id of the land clip path, so the picture only shows over land. */
    clipId: string;
  }

  let { href, clipId }: Props = $props();

  const k = getLayerCakeContext();
  const layout = $derived((k.custom as MapCakeCustom).layout);
</script>

<!--
  Stretched to the layout's rectangle. During a resize the previous picture (fitted at the old width) briefly
  fills the new layout; fitting is proportional, so it still lines up until the new one replaces it.
-->
<image
  {href}
  x="0"
  y="0"
  width={layout.width}
  height={layout.height}
  preserveAspectRatio="none"
  clip-path="url(#{clipId})"
/>
