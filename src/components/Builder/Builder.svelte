<script lang="ts">
  import { BuilderStyleRoot } from '@abcnews/components-builder';
  import BuilderUi from './BuilderUi.svelte';
  import FileLoader, { type LoadedData } from './FileLoader.svelte';

  // $state.raw: the buffer is large, and deep proxies are slow.
  let data = $state.raw<LoadedData>();
  /** True while the user is swapping the data for something else. */
  let changing = $state(false);
  let loadError = $state<string>();

  const handleLoad = (next: LoadedData) => {
    data = next;
    changing = false;
    loadError = undefined;
  };

  // The builder couldn't make sense of the file: drop it and go back to the loader.
  const handleInvalid = (message: string) => {
    data = undefined;
    changing = false;
    loadError = message;
  };

</script>

<BuilderStyleRoot>
  {#if !data || changing}
    <FileLoader error={loadError} onload={handleLoad} oncancel={data ? () => (changing = false) : undefined} />
  {/if}

  <!-- Stays mounted while the loader is showing, so cancelling restores the user's range and colours. -->
  {#if data && !changing}
    <!-- Surfaces a render/init error on screen and in the console instead of leaving a blank page. -->
    <BuilderUi {data} onchange={() => (changing = true)} oninvalid={handleInvalid} />
  {/if}
</BuilderStyleRoot>