<script module lang="ts">
  /**
   * Builder settings a data source can ask for when it loads (e.g. the forecast data wants the Summer
   * heat preset). The builder checks each value against what it supports and ignores anything unknown.
   */
  export type LoadedSettings = {
    /** A preset id, e.g. 'summer-heat'. */
    preset?: string;
    /** A projection id: 'australia' | 'equal-earth' | 'mercator'. */
    projection?: string;
    /** A crop shape id: 'none' | a built-in shape id. */
    clipChoice?: string;
    /** Fit the map to the whole globe (centred on Greenwich) rather than to the data's extent. Use for global data. */
    wholeWorld?: boolean;
    /** Keep everything outside the crop shape instead of inside it (e.g. oceans only). */
    clipInvert?: boolean;
  };

  /** What the loader hands back: the raw file contents, a name used for exports, and any requested settings. */
  export type LoadedData = {
    buffer: ArrayBuffer;
    name: string;
    settings?: LoadedSettings;
  };

  // ---------------------------------------------------------------------------
  // Preset data sources
  // ---------------------------------------------------------------------------

  const DATA_BASE_URL = 'https://abcnewsdata.sgp1.digitaloceanspaces.com/service-ecmwf-gridded-forecasts';

  /** Folders are dated from here... */
  const FIRST_DATE = '2026-10-16';
  /** ...up to this many days after today (a 6 day forecast). */
  const DAYS_AHEAD = 6;
  const TIME_ZONE = 'Australia/Sydney';

  /** Every dataset is a temperature, so they all use the Summer heat preset. */
  const DATASETS = [{ id: 'ifs-t2m', label: 'ECMWF IFS, 2m temperature', preset: 'summer-heat' }];

  /**
   * Regional settings: Australian data gets the conic projection and an Australia crop, fitted to the data.
   * Global data gets Equal Earth, a continents crop and a whole-world frame (centred on Greenwich).
   * Both set every field, so loading one after the other fully resets the builder rather than inheriting
   * the previous dataset's whole-world or invert choices.
   */
  const AUS_REGION = { projection: 'australia', clipChoice: 'aus', wholeWorld: false, clipInvert: false } satisfies LoadedSettings;
  const GLOBAL_REGION = {
    projection: 'equal-earth',
    clipChoice: 'world-simple',
    wholeWorld: true,
    clipInvert: false
  } satisfies LoadedSettings;

  const DATA_FILES = [
    { id: 'aus', label: 'Australia', file: 'aus.tiff', region: AUS_REGION },
    { id: 'aus-banded', label: 'Australia (banded)', file: 'aus-banded.tiff', region: AUS_REGION },
    { id: 'global', label: 'Global', file: 'global.tiff', region: GLOBAL_REGION },
    { id: 'global-banded', label: 'Global (banded)', file: 'global-banded.tiff', region: GLOBAL_REGION }
  ];

  type Tab = 'load' | 'presets';
  /** How to load data on the "Load data" tab. */
  type Mode = 'url' | 'file';

  /** Today's date in Sydney as YYYY-MM-DD, regardless of the browser's own time zone. */
  const todayInSydney = () => new Intl.DateTimeFormat('en-CA', { timeZone: TIME_ZONE }).format(new Date());

  const addDays = (iso: string, days: number) => {
    const d = new Date(`${iso}T00:00:00Z`);
    d.setUTCDate(d.getUTCDate() + days);
    return d.toISOString().slice(0, 10);
  };

  /** Every available date from FIRST_DATE to today + DAYS_AHEAD, inclusive. */
  const availableDates = (today: string) => {
    const last = addDays(today, DAYS_AHEAD);
    const dates: string[] = [];
    for (let d = FIRST_DATE; d <= last; d = addDays(d, 1)) dates.push(d);
    return dates;
  };

  const fileNameFromUrl = (url: string) => {
    try {
      const last = new URL(url).pathname.split('/').filter(Boolean).pop();
      return last ? decodeURIComponent(last) : 'isobands';
    } catch {
      return 'isobands';
    }
  };
</script>

<script lang="ts">
  import { ButtonGroup, FilePicker, Loader, Tabs } from '@abcnews/components-builder';

  type Props = {
    /** An error from the previous attempt (e.g. the builder couldn't parse the file). */
    error?: string;
    /** Called with the file's contents once it has been read or downloaded. */
    onload: (data: LoadedData) => void;
    /** When provided, shows a cancel button (used when data is already loaded and the user is swapping it). */
    oncancel?: () => void;
  };

  let { error, onload, oncancel }: Props = $props();

  // Computed once per mount, which is plenty for a tool that isn't left open overnight.
  const today = todayInSydney();
  const dates = availableDates(today);

  let activeTab = $state<Tab>('presets');
  let mode = $state<Mode>('url');
  let busy = $state(false);
  let localError = $state<string>();

  // Preset
  let datasetId = $state(DATASETS[0].id);
  let date = $state(dates.includes(today) ? today : dates[dates.length - 1]);
  let fileId = $state('aus-banded');

  /** The picker can be cleared or typed past its min/max, so check the date really has data. */
  const dateAvailable = $derived(dates.includes(date));
  const presetDataset = $derived(DATASETS.find((d) => d.id === datasetId) ?? DATASETS[0]);
  const presetFile = $derived(DATA_FILES.find((f) => f.id === fileId) ?? DATA_FILES[0]);
  /** The builder settings that come with the chosen dataset and area. */
  const presetSettings = $derived<LoadedSettings>({ preset: presetDataset.preset, ...presetFile.region });
  const presetUrl = $derived(`${DATA_BASE_URL}/${datasetId}/${date}/${presetFile.file}`);

  // URL
  let customUrl = $state('');

  // Filesystem
  let file = $state<File | null>(null);

  const shownError = $derived(localError ?? error);

  // ---------------------------------------------------------------------------
  // Loading
  // ---------------------------------------------------------------------------

  let controller: AbortController | undefined;

  const loadUrl = async (url: string, name: string, settings?: LoadedSettings) => {
    controller?.abort();
    const current = new AbortController();
    controller = current;
    busy = true;
    localError = undefined;
    try {
      const response = await fetch(url, { signal: current.signal });
      if (!response.ok) throw new Error(`the server responded with ${response.status}`);
      const buffer = await response.arrayBuffer();
      if (current.signal.aborted) return;
      onload({ buffer, name, settings });
    } catch (e) {
      if (current.signal.aborted) return;
      console.error('[isobands] could not fetch', url, e);
      // fetch rejects with a bare TypeError for network failures and for CORS blocks alike.
      const hint = e instanceof TypeError ? ' This is usually a network or CORS problem.' : '';
      localError = `Could not load that file: ${e instanceof Error ? e.message : e}.${hint}`;
    } finally {
      if (!current.signal.aborted) busy = false;
    }
  };

  const loadPreset = () => loadUrl(presetUrl, `${datasetId}-${date}-${presetFile.id}.tiff`, presetSettings);

  const loadCustomUrl = () => {
    const url = customUrl.trim();
    if (!url) return;
    try {
      new URL(url);
    } catch {
      localError = 'That does not look like a valid URL.';
      return;
    }
    loadUrl(url, fileNameFromUrl(url));
  };

  // A file chosen from the filesystem is read as soon as it's picked.
  $effect(() => {
    const picked = file;
    if (!picked) return;
    let stale = false;
    busy = true;
    localError = undefined;
    picked
      .arrayBuffer()
      .then((buffer) => {
        if (!stale) onload({ buffer, name: picked.name });
      })
      .catch((e) => {
        if (stale) return;
        console.error('[isobands] could not read file', e);
        localError = `Could not read that file: ${e instanceof Error ? e.message : e}`;
      })
      .finally(() => {
        if (!stale) busy = false;
      });
    return () => {
      stale = true;
    };
  });

  // Abandon any in-flight download if the loader goes away.
  $effect(() => () => controller?.abort());

  const setMode = (next: Mode) => {
    mode = next;
    localError = undefined;
  };

  // Don't carry an error from one tab over to the other.
  $effect(() => {
    activeTab;
    localError = undefined;
  });
</script>

<div class="loader">
  <Tabs
    items={[
      { id: 'load', label: 'Load data' },
      { id: 'presets', label: 'Presets' }
    ]}
    bind:activeId={activeTab}
  />

  <fieldset disabled={busy}>
    {#if activeTab === 'presets'}
      <div class="row">
        <label for="dataset">Dataset</label>
        <select id="dataset" bind:value={datasetId}>
          {#each DATASETS as d}
            <option value={d.id}>{d.label}</option>
          {/each}
        </select>
      </div>
      <div class="row">
        <label for="date">Date</label>
        <input id="date" type="date" min={dates[0]} max={dates[dates.length - 1]} bind:value={date} />
      </div>
      <div class="row">
        <label for="file">Area</label>
        <select id="file" bind:value={fileId}>
          {#each DATA_FILES as f}
            <option value={f.id}>{f.label}</option>
          {/each}
        </select>
      </div>
      <p class="url"><small>{presetUrl}</small></p>
      <button type="button" disabled={!dateAvailable} onclick={loadPreset}>Load</button>
    {:else}
      <ButtonGroup>
        <button type="button" aria-pressed={mode === 'url'} onclick={() => setMode('url')}>From URL</button>
        <button type="button" aria-pressed={mode === 'file'} onclick={() => setMode('file')}>From file</button>
      </ButtonGroup>

      {#if mode === 'url'}
        <div class="row">
          <label for="url">GeoTIFF URL</label>
          <input id="url" type="url" placeholder="https://…/file.tiff" bind:value={customUrl} onkeydown={(e) => e.key === 'Enter' && loadCustomUrl()} />
        </div>
        <button type="button" disabled={!customUrl.trim()} onclick={loadCustomUrl}>Load</button>
      {:else}
        <FilePicker types=".tif,.tiff,.geotiff" bind:file />
      {/if}
    {/if}

    {#if busy}<Loader>Loading data</Loader>{/if}
    {#if shownError}<p role="alert"><small>{shownError}</small></p>{/if}
  </fieldset>

  {#if oncancel}
    <p><button type="button" onclick={oncancel}>Cancel</button></p>
  {/if}
</div>

<style>
  .loader {
    max-width: 28rem;
    margin: 4rem auto;
    padding: 0 1rem;
  }

  fieldset {
    min-width: 0;
    border-radius: 0;
    border-top: none;
    margin: 0;
  }

  /* Label and control share a line. */
  .row {
    display: flex;
    align-items: center;
    gap: 0.5rem;
    margin-block: 0.5rem;
  }

  .row label {
    flex: 0 0 7.5em;
    margin: 0;
  }

  .row select,
  .row input {
    flex: 1;
    min-width: 0;
  }

  .url {
    overflow-wrap: anywhere;
    opacity: 0.7;
  }
</style>