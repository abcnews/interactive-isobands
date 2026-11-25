<script lang="ts">
  import { getLayerCakeContext } from 'layercake';
  import { boundaryPath } from '../../../lib/rastergrid.ts';
  import type { MapCakeCustom } from '../RasterMap.svelte';

  interface Props {
    /** Id other layers reference with `clip-path="url(#id)"`. */
    id: string;
  }

  let { id }: Props = $props();

  const k = getLayerCakeContext();
  /** Already projected by the panel's one fitted projection, in the layout's pixel space. */
  const d = $derived(boundaryPath((k.custom as MapCakeCustom).layout));
</script>

<!-- Goes in the Svg's defs. Even-odd so inner rings (lakes) cut holes. -->
<clipPath {id}>
  <path {d} clip-rule="evenodd" />
</clipPath>
