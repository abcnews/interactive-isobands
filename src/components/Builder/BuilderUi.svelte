<script module lang="ts">
  import { ColourMode, DivergentPalette, SequentialPalette } from '@abcnews/palette';
  import {
    BUILT_IN_SHAPES,
    MAX_BANDS,
    PROJECTIONS,
    PROJECTION_IDS,
    bandCount as countBands,
    buildLayout,
    buildSvg,
    centreLongitude,
    inspectTiff,
    invertShape,
    rangeFor,
    tidy,
    type Bbox,
    type ProjectionId
  } from '../../lib/geo.ts';
  import { OUT_OF_RANGE_COLOUR, summerHeatPalette } from '../../lib/palettes.ts';
  import { booleanCodec, createHashStore, enumCodec, numberCodec, type HashSchema } from './hashstore.svelte.ts';

  // Module scope: the store is created once (it registers window listeners), however many times this mounts.

  // ---------------------------------------------------------------------------
  // Presets
  // ---------------------------------------------------------------------------

  /**
   * A preset bundles a fixed range, band interval and colours. While one is selected,
   * the range/bands and colour controls are hidden and these values are used instead.
   */
  type Preset = {
    id: string;
    label: string;
    min: number;
    max: number;
    interval: number;
    palette: (value: number) => string;
  };


  const PRESETS = [
    {
      id: 'summer-heat',
      label: 'Summer heat',
      // The interval matches the 5° colour steps so band edges land on the thresholds.
      // min/max are deliberately wider than the thresholds so cool and extreme cells aren't dropped.
      min: 0,
      max: 55,
      interval: 5,
      palette: summerHeatPalette
    }
  ] as const satisfies readonly Preset[];

  const NO_PRESET = 'none';
  type PresetId = typeof NO_PRESET | (typeof PRESETS)[number]['id'];
  const PRESET_IDS: readonly PresetId[] = [NO_PRESET, ...PRESETS.map((p) => p.id)];

  // ---------------------------------------------------------------------------
  // Settings: synced with the URL hash, and the source of truth for everything below
  // ---------------------------------------------------------------------------

  type PaletteSource = 'abc-sequential' | 'abc-divergent';

  /**
   * Everything the user can configure that can live in a URL.
   * Not included (can't be represented in a hash): the GeoTIFF file and an uploaded custom crop shape.
   */
  type Settings = {
    preset: PresetId;
    // Custom range. Ignored while a preset is selected, but kept so switching back restores it.
    min: number;
    max: number;
    interval: number;
    neutral: number; // midpoint, only used by divergent palettes
    // Custom colours. Ignored while a preset is selected.
    paletteSource: PaletteSource;
    sequentialVariant: SequentialPalette;
    divergentKey: string;
    colourMode: ColourMode;
    reversed: boolean;
    extendEnds: boolean; // values outside min/max take the nearest end colour instead of grey
    clipChoice: string; // 'none' | built-in id | 'custom'
    // Map projection. Set from the data's extent whenever a file is loaded, then freely changeable.
    projection: ProjectionId;
    // User's choice (never auto-set from the data): fit the map to the whole globe, centred on Greenwich, instead of to the data's extent.
    wholeWorld: boolean;
    // Crop to everything *outside* the chosen shape (e.g. oceans only).
    clipInvert: boolean;
  };

  /** Range settings start as placeholders and are replaced by values derived from the data. */
  const DEFAULT_SETTINGS: Settings = {
    preset: 'summer-heat',
    min: 0,
    max: 1,
    interval: 0.1,
    neutral: 0.5,
    paletteSource: 'abc-sequential',
    sequentialVariant: SequentialPalette.Red,
    divergentKey: 'RedBlue',
    colourMode: ColourMode.Light,
    reversed: false,
    extendEnds: false,
    clipChoice: 'none',
    projection: 'australia',
    wholeWorld: false,
    clipInvert: false
  };

  const settingsSchema: HashSchema<Settings> = {
    preset: enumCodec<PresetId>(PRESET_IDS),
    min: numberCodec,
    max: numberCodec,
    interval: numberCodec,
    neutral: numberCodec,
    paletteSource: enumCodec<PaletteSource>(['abc-sequential', 'abc-divergent']),
    sequentialVariant: enumCodec(Object.values(SequentialPalette) as SequentialPalette[]),
    divergentKey: enumCodec(Object.keys(DivergentPalette)),
    colourMode: enumCodec(Object.values(ColourMode) as ColourMode[]),
    reversed: booleanCodec,
    extendEnds: booleanCodec,
    clipChoice: enumCodec(['none', ...BUILT_IN_SHAPES.map((s) => s.id), 'custom']),
    projection: enumCodec<ProjectionId>(PROJECTION_IDS),
    wholeWorld: booleanCodec,
    clipInvert: booleanCodec
  };

  const settings = createHashStore<Settings>(settingsSchema, DEFAULT_SETTINGS);

  /**
   * True when the URL supplied its own range (min/max/interval). Used to avoid overwriting a
   * restored range with values derived from the first file that's uploaded.
   */
  const hadStoredRange = (['min', 'max', 'interval'] as const).some((k) => settings.initialKeys.has(k));

  /**
   * If the page opened with a range in the URL, keep it for the first file loaded rather than
   * overwriting it with one derived from the data. Loading a different file afterwards re-derives.
   * Module scope so it's consumed once per page load, not once per mount.
   */
  let keepStoredRange = hadStoredRange;

  /** Same idea for the projection: a projection in the URL wins over the data-derived default on first load. */
  let keepStoredProjection = settings.initialKeys.has('projection');
</script>

<script lang="ts">
  import {
    BuilderFrame,
    ButtonGroup,
    FilePicker,
    InputDistribution,
    Loader
  } from '@abcnews/components-builder';
  import { createContinuousScale, getNamedColour } from '@abcnews/palette';
  import type { FeatureCollection } from 'geojson';
  import { createIsobandsInWorker } from '../../lib/createisobandsworker.ts';
  import type { GeoJsonInput } from '../../lib/fastclip.ts';
  import IsobandMap from '../IsobandMap/IsobandMap.svelte';
  import type { LoadedData, LoadedSettings } from './FileLoader.svelte';

  type Props = {
    /** The raw GeoTIFF, supplied by the router (via FileLoader). */
    data: LoadedData;
    /** Asks the router to show the file loader again. */
    onchange: () => void;
    /** Called when the supplied file can't be read as a GeoTIFF, so the router can send the user back to the loader. */
    oninvalid: (message: string) => void;
  };

  let { data, onchange, oninvalid }: Props = $props();

  // ---------------------------------------------------------------------------
  // Constants
  // ---------------------------------------------------------------------------

  /** PNG export width in pixels. PNGs are always transparent. */
  const EXPORT_WIDTH = 4000;

  // Stringified so the details can be copied out of the console.
  const log = (message: string, details: unknown = {}) => console.debug(`[isobands] ${message} ${JSON.stringify(details)}`);

  type DataRange = { min: number; max: number };

  const divergentOptions = Object.entries(DivergentPalette).map(([key, value]) => ({
    key,
    value,
    label: key.replace(/([a-z])([A-Z])/g, '$1 / $2')
  }));

  // ---------------------------------------------------------------------------
  // State: data
  // ---------------------------------------------------------------------------

  type Phase = 'inspecting' | 'ready';

  // $state.raw: these are large, and deep proxies are slow and can't be structured-cloned.
  let tiffBuffer = $state.raw<ArrayBuffer>();
  let dataRange = $state.raw<DataRange>();
  let dataValues = $state.raw<number[]>([]);
  /** The raster's geographic extent (if georeferenced). Only used to sanity-check the generated bands. */
  let dataBbox = $state.raw<Bbox>();
  let phase = $state<Phase>('inspecting');

  // ---------------------------------------------------------------------------
  // Settings: the `settings` store (synced with the URL hash) is the source of truth for
  // preset, range, palette and crop choice. Write to it ($settings.x = ..., bind:value={$settings.x}).
  //
  // Read via the $derived aliases below rather than $settings.x directly in effects: a store
  // notifies on every change, but a $derived only invalidates its dependants when its own
  // value changes. Without that, dragging the range would re-run the crop-shape fetch effect.
  // ---------------------------------------------------------------------------

  /** The active preset, if any. A preset overrides the custom range and colour settings. */
  const preset = $derived<Preset | undefined>(PRESETS.find((p) => p.id === $settings.preset));

  // The range actually in use: the preset's when one is active, otherwise the user's own.
  const min = $derived(preset ? preset.min : $settings.min);
  const max = $derived(preset ? preset.max : $settings.max);
  const interval = $derived(preset ? preset.interval : $settings.interval);

  const neutral = $derived($settings.neutral); // midpoint, only used by divergent palettes
  const paletteSource = $derived($settings.paletteSource);
  const sequentialVariant = $derived($settings.sequentialVariant);
  const divergentKey = $derived($settings.divergentKey);
  const colourMode = $derived($settings.colourMode);
  const reversed = $derived($settings.reversed);
  const extendEnds = $derived($settings.extendEnds);
  const projectionId = $derived($settings.projection);
  const wholeWorld = $derived($settings.wholeWorld);
  const clipInvert = $derived($settings.clipInvert);

  // ---------------------------------------------------------------------------
  // State: clip shape
  // ---------------------------------------------------------------------------

  const clipChoice = $derived($settings.clipChoice); // 'none' | built-in id | 'custom'
  // Not in the store: an uploaded shape can be megabytes, which can't live in a URL.
  let customShapeText = $state('');
  let clipShape = $state.raw<GeoJsonInput>();
  let clipError = $state<string>();

  // ---------------------------------------------------------------------------
  // State: output
  // ---------------------------------------------------------------------------

  let bands = $state.raw<FeatureCollection>();
  let generating = $state(false);
  let error = $state<string>();
  let exportError = $state<string>();

  // ---------------------------------------------------------------------------
  // Derived
  // ---------------------------------------------------------------------------

  // The epsilon stops float noise turning 11.000000000000002 bands into 12.
  const bandCount = $derived(countBands(min, max, interval));

  /** True while a crop shape is chosen but not yet available. */
  const clipPending = $derived(clipChoice !== 'none' && !clipShape && !clipError);

  /**
   * The shape the bands are actually clipped to: the chosen shape, or with "Invert" on, everything *outside* it.
   * Built here (rather than inside createIsobands) as a polygon with the shape punched out of a frame that
   * covers the data, so it works with any clipper that handles polygons with holes.
   */
  const invertedClip = $derived.by(() => {
    if (!clipInvert || !clipShape) return undefined;
    const result = invertShape(clipShape, dataBbox);
    log('crop shape inverted', { ok: !result.problem, problem: result.problem, frame: result.frame, holes: result.holes });
    return result;
  });
  const effectiveClip = $derived(clipInvert ? invertedClip?.shape : clipShape);
  /** A reason the crop can't be used (failed to load, or can't be inverted). */
  const clipProblem = $derived(clipError ?? invertedClip?.problem);

  const rangeProblem = $derived.by(() => {
    if (preset) return undefined; // preset ranges are known-good
    if (!Number.isFinite(min) || !Number.isFinite(max) || !Number.isFinite(interval)) return 'Enter a number for min, max and interval.';
    if (max <= min) return 'Max must be greater than min.';
    if (interval <= 0) return 'Interval must be greater than zero.';
    if (bandCount > MAX_BANDS) return `That gives ${bandCount} bands. Increase the interval (limit ${MAX_BANDS}).`;
    if (paletteSource === 'abc-divergent' && !(min < neutral && neutral < max)) return 'The neutral value must sit between min and max.';
    return undefined;
  });

  /** The custom colour scale across [min, max] (including reversal). Not meant to be called outside that range. */
  const rangePalette = $derived.by<(value: number) => string>(() => {
    if (paletteSource === 'abc-divergent') {
      const variant = divergentOptions.find((o) => o.key === divergentKey)?.value ?? DivergentPalette.RedBlue;
      const scale = createContinuousScale(variant, colourMode, [min, neutral, max]);
      if (!reversed) return scale;

      // Swap the two halves of the palette while keeping the neutral colour at `neutral`.
      // A value that is t of the way from neutral to one end gets the colour that is
      // t of the way from neutral to the opposite end. (Mirroring around the midpoint of
      // min/max instead would drag the neutral point away from the chosen value.)
      return (v: number) => {
        if (v <= neutral) {
          const t = (neutral - v) / (neutral - min);
          return scale(neutral + t * (max - neutral));
        }
        const t = (v - neutral) / (max - neutral);
        return scale(neutral - t * (neutral - min));
      };
    }

    const scale = createContinuousScale(sequentialVariant, colourMode, [min, max]);
    // Sequential palettes have no neutral point, so mirroring around the midpoint is correct.
    return reversed ? (v: number) => scale(max - (v - min)) : scale;
  });

  /**
   * Builds the value -> colour function handed to createIsobands. Presets carry their own stepped
   * palette; custom palettes colour [min, max), and anything outside either gets the nearest end
   * colour (when "Extend end colours" is on) or the default grey.
   */
  const palette = $derived.by<(value: number) => string>(() => {
    if (preset) return preset.palette;
    const inRange = rangePalette;
    if (extendEnds) return (v: number) => inRange(Math.min(Math.max(v, min), max));
    return (v: number) => (v < min || v >= max ? OUT_OF_RANGE_COLOUR : inRange(v));
  });

  // ---------------------------------------------------------------------------
  // Loading the inputs
  // ---------------------------------------------------------------------------

  /**
   * Replaces the custom min/max/interval/neutral with sensible values for the data.
   * (Presets are unaffected: they have a fixed range.)
   */
  const applyDataRange = (r: DataRange) => {
    settings.update((s) => ({ ...s, ...rangeFor(r) }));
  };

  /**
   * Applies settings requested by the data source (e.g. the forecast data asks for the Summer heat
   * preset, a projection and a crop). Unknown values are ignored rather than trusted.
   */
  const applyRequestedSettings = (requested: LoadedSettings) => {
    const preset = PRESET_IDS.find((id) => id === requested.preset);
    const projection = PROJECTION_IDS.find((id) => id === requested.projection);
    const clipIds = ['none', ...BUILT_IN_SHAPES.map((s) => s.id)];
    const clipChoice = clipIds.find((id) => id === requested.clipChoice);
    settings.update((s) => ({
      ...s,
      ...(preset ? { preset } : {}),
      ...(projection ? { projection } : {}),
      ...(clipChoice ? { clipChoice } : {}),
      ...(typeof requested.wholeWorld === 'boolean' ? { wholeWorld: requested.wholeWorld } : {}),
      ...(typeof requested.clipInvert === 'boolean' ? { clipInvert: requested.clipInvert } : {})
    }));
  };

  // Inspects the supplied GeoTIFF whenever it changes.
  $effect(() => {
    const source = data.buffer;
    const requested = data.settings;
    tiffBuffer = undefined;
    dataRange = undefined;
    dataValues = [];
    dataBbox = undefined;
    bands = undefined;
    error = undefined;
    phase = 'inspecting';

    let stale = false;
    log('inspecting', { name: data.name, bytes: source.byteLength });

    (async () => {
      try {
        const range = await inspectTiff(source);
        if (stale) return;
        log('data range', { min: range.min, max: range.max, sampled: range.values.length });
        if (keepStoredRange) keepStoredRange = false;
        else applyDataRange(range);
        if (keepStoredProjection) keepStoredProjection = false;
        else {
          // Data entirely inside this lon/lat box (padded so offshore grids qualify) keeps the Australian conic.
          const [west, south, east, north] = range.bbox ?? [NaN, NaN, NaN, NaN];
          const aroundAustralia = west >= 100 && east <= 175 && south >= -55 && north <= 0;
          const next: ProjectionId = aroundAustralia ? 'australia' : 'equal-earth';
          log('projection', { bbox: range.bbox, projection: next });
          settings.update((s) => ({ ...s, projection: next }));
        }
        // Explicit requests from the data source win over both the URL and the data-derived defaults.
        if (requested) applyRequestedSettings(requested);
        tiffBuffer = source;
        dataRange = { min: range.min, max: range.max };
        dataValues = range.values;
        dataBbox = range.bbox;
        phase = 'ready';
      } catch (e) {
        if (stale) return;
        console.error('[isobands] could not read GeoTIFF', e);
        oninvalid(`Could not read that GeoTIFF: ${e instanceof Error ? e.message : e}`);
      }
    })();

    return () => {
      stale = true;
    };
  });

  $effect(() => {
    clipError = undefined;
    if (clipChoice === 'none') {
      clipShape = undefined;
      return;
    }
    if (clipChoice === 'custom') {
      if (!customShapeText) {
        clipShape = undefined;
        return;
      }
      try {
        clipShape = JSON.parse(customShapeText) as GeoJsonInput;
      } catch {
        clipShape = undefined;
        clipError = 'That file is not valid GeoJSON.';
      }
      return;
    }
    const shape = BUILT_IN_SHAPES.find((s) => s.id === clipChoice);
    if (!shape) return;
    const controller = new AbortController();
    fetch(shape.url, { signal: controller.signal })
      .then((r) => {
        if (!r.ok) throw new Error(`server responded with ${r.status}`);
        return r.json();
      })
      .then((json) => {
        log('crop shape loaded', { choice: clipChoice, type: json?.type, features: json?.features?.length });
        clipShape = json as GeoJsonInput;
      })
      .catch((e) => {
        if (controller.signal.aborted) return;
        clipShape = undefined;
        clipError = `Could not load ${shape.label}: ${e instanceof Error ? e.message : e}`;
      });
    return () => controller.abort();
  });

  // ---------------------------------------------------------------------------
  // Generating the bands (debounced so typing in number fields isn't painful)
  // ---------------------------------------------------------------------------

  $effect(() => {
    // Read every dependency up front so the effect re-runs when any change.
    const data = tiffBuffer;
    const range = dataRange;
    const boundary = effectiveClip;
    const colours = palette;
    const problem = rangeProblem;
    const waitingOnClip = clipPending || !!clipProblem;
    const opts = { min, max, interval };

    if (!data || !range || problem || waitingOnClip) {
      generating = false; // otherwise an in-flight run cancelled by this one leaves the spinner stuck
      return;
    }

    let stale = false;
    generating = true;
    const timer = setTimeout(async () => {
      error = undefined;
      const started = performance.now();
      log('creating isobands', {
        ...opts,
        clipped: !!boundary,
        clipType: (boundary as { type?: string } | undefined)?.type,
        bytes: data.byteLength
      });
      try {
        // Custom ranges only produce bands between min and max, so data outside would be dropped.
        // Add one wide band below and/or above (interval = its whole span) so that data is drawn
        // too; `colours` paints those bands grey, or with the nearest end colour if that option is on.
        // Presets need this too: their palettes already extend the end colours, but only for bands that exist.
        const parts = [opts];
        const loPad = Math.max(Math.abs(range.min), 1) * 1e-6;
        const hiPad = Math.max(Math.abs(range.max), 1) * 1e-6;
        if (range.min < min) {
          const lo = range.min - loPad;
          parts.push({ min: lo, max: min, interval: min - lo });
        }
        if (range.max > max) {
          const hi = range.max + hiPad;
          parts.push({ min: max, max: hi, interval: hi - max });
        }
        const [main, ...outside] = await Promise.all(
          // The jobs run in parallel across the worker pool.
          parts.map((part) => createIsobandsInWorker(data, { clipTo: boundary, palette: colours, ...part }))
        );
        // Outside bands first so the in-range bands draw on top.
        const result = { ...main, features: [...outside.flatMap((r) => r.features), ...main.features] };
        if (stale) return;
        log('isobands created', { features: result.features.length, ms: Math.round(performance.now() - started) });
        bands = result;
      } catch (e) {
        if (stale) return;
        bands = undefined;
        error = `Could not create isobands: ${e instanceof Error ? e.message : e}`;
        console.error('[isobands] createIsobands failed', e);
      } finally {
        if (!stale) generating = false;
      }
    }, 300);

    return () => {
      stale = true;
      clearTimeout(timer);
    };
  });

  // ---------------------------------------------------------------------------
  // Exports
  // ---------------------------------------------------------------------------

  const download = (blob: Blob, filename: string) => {
    const href = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = href;
    a.download = filename;
    a.click();
    setTimeout(() => URL.revokeObjectURL(href), 1000);
  };

  const baseName = $derived((data.name || 'isobands').replace(/\.[^.]+$/, ''));

  const exportGeoJson = () => {
    if (!bands) return;
    download(new Blob([JSON.stringify(bands)], { type: 'application/geo+json' }), `${baseName}.geojson`);
  };

  /** The map's centre longitude: the data's own centre, or Greenwich for a whole-world frame. */
  const centreLon = $derived(!bands || wholeWorld ? 0 : centreLongitude(bands));

  /** Built on demand for exports; the preview lays itself out inside IsobandMap. */
  const layoutForExport = () => buildLayout({ bands, projection: projectionId, wholeWorld, centreLon });

  const exportSvg = () => {
    const layout = layoutForExport();
    if (!layout) return;
    download(new Blob([buildSvg(layout)], { type: 'image/svg+xml' }), `${baseName}.svg`);
  };

  const exportPng = async () => {
    const layout = layoutForExport();
    if (!layout) return;
    exportError = undefined;
    const w = EXPORT_WIDTH;
    const h = Math.round((w * layout.height) / layout.width);
    const svgBlob = new Blob([buildSvg(layout, w)], { type: 'image/svg+xml' });
    const href = URL.createObjectURL(svgBlob);
    try {
      const img = new Image();
      img.src = href;
      await img.decode();
      const canvas = document.createElement('canvas');
      canvas.width = w;
      canvas.height = h;
      const ctx = canvas.getContext('2d')!;
      ctx.drawImage(img, 0, 0, w, h);
      const png = await new Promise<Blob | null>((resolve) => canvas.toBlob(resolve, 'image/png'));
      if (png) download(png, `${baseName}.png`);
    } catch (e) {
      exportError = `Could not export PNG: ${e instanceof Error ? e.message : e}`;
    } finally {
      URL.revokeObjectURL(href);
    }
  };

  const hasOutput = $derived(!!bands?.features.length);

  /** What to say when there's nothing to draw and nothing is loading. */
  const idleMessage = $derived.by(() => {
    if (rangeProblem) return rangeProblem;
    if (clipProblem) return clipProblem;
    if (clipPending) return 'Waiting for the crop shape…';
    if (bands && !bands.features.length) {
      const r = dataRange;
      return `No isobands were produced for ${min} to ${max}.${r ? ` The data ranges from ${tidy(r.min)} to ${tidy(r.max)}.` : ''}`;
    }
    return 'Preparing…';
  });
</script>

{#snippet Viz()}
  {#if error}
    <p class="placeholder" role="alert">{error}</p>
  {:else if phase !== 'ready'}
    <Loader>Reading raster values</Loader>
  {:else if generating && !hasOutput}
    <Loader>Creating isobands</Loader>
  {:else if hasOutput}
    <div class="preview" aria-busy={generating}>
      <IsobandMap {bands} projection={projectionId} {wholeWorld} {centreLon} />
      {#if generating}<span class="updating">Updating…</span>{/if}
    </div>
  {:else}
    <p class="placeholder">{idleMessage}</p>
  {/if}
{/snippet}

{#snippet Sidebar()}
  <fieldset>
    <legend>Data</legend>
    <p class="data-name"><small>{data.name}</small></p>
    <button type="button" onclick={onchange}>Load different data</button>
  </fieldset>

  <fieldset>
    <legend>Presets</legend>
    <div class="row">
      <label for="preset">Preset</label>
      <select id="preset" bind:value={$settings.preset}>
        <option value={NO_PRESET}>None (custom)</option>
        {#each PRESETS as p}
          <option value={p.id}>{p.label}</option>
        {/each}
      </select>
    </div>
  </fieldset>

  {#if !preset}
  <fieldset>
    <legend>Range and bands</legend>
    <div class="distribution">
      <InputDistribution
        values={dataValues}
        color={palette}
        step={interval > 0 ? interval : undefined}
        disabled={!dataRange}
        bind:min={$settings.min}
        bind:max={$settings.max}
      />
    </div>
    <div class="row">
      <label for="interval">Interval</label>
      <input id="interval" type="number" min="0" step="any" bind:value={$settings.interval} />
      <small class="nowrap">{rangeProblem ? '' : `@ ${bandCount} bands`}</small>
    </div>
    {#if rangeProblem}
      <p role="alert"><small>{rangeProblem}</small></p>
    {/if}
  </fieldset>

  <fieldset>
    <legend>Colours</legend>
    <div class="row">
      <label for="palette-source">Palette</label>
      <select id="palette-source" bind:value={$settings.paletteSource}>
        <option value="abc-sequential">ABC sequential</option>
        <option value="abc-divergent">ABC divergent</option>
      </select>
    </div>

    {#if paletteSource === 'abc-sequential'}
      <div class="row">
        <label for="seq">Colour</label>
        <select id="seq" bind:value={$settings.sequentialVariant}>
          {#each Object.values(SequentialPalette) as v}
            <option value={v}>{v}</option>
          {/each}
        </select>
      </div>
    {/if}

    {#if paletteSource === 'abc-divergent'}
      <div class="row">
        <label for="div">Colours</label>
        <select id="div" bind:value={$settings.divergentKey}>
          {#each divergentOptions as o}
            <option value={o.key}>{o.label}</option>
          {/each}
        </select>
      </div>
      <div class="row">
        <label for="neutral">Neutral value</label>
        <input id="neutral" type="number" step="any" bind:value={$settings.neutral} />
      </div>
    {/if}

    <div class="row builder__inline">
      <span class="row-label" id="mode-label">Colour mode</span>
      <div class="builder__inline" role="radiogroup" aria-labelledby="mode-label">
        <label class="check">
          <input type="radio" name="colour-mode" value={ColourMode.Light} bind:group={$settings.colourMode} /> Light
        </label>
        <label class="check">
          <input type="radio" name="colour-mode" value={ColourMode.Dark} bind:group={$settings.colourMode} /> Dark
        </label>
      </div>
      <div class="toggles">
        <label
          class="check"
          title="Values outside min/max take the colour of the nearest band. When off, they are greyed out."
        >
          <input type="checkbox" bind:checked={$settings.extendEnds} /> Extend end colours
        </label>
        <label class="check">
          <input type="checkbox" bind:checked={$settings.reversed} /> Reverse
        </label>
      </div>
    </div>
  </fieldset>
  {/if}

  <fieldset>
    <legend>Crop to shape</legend>
    <div class="row">
      <label for="clip">Shape</label>
      <select id="clip" bind:value={$settings.clipChoice}>
        <option value="none">No crop</option>
        {#each BUILT_IN_SHAPES as s}
          <option value={s.id}>{s.label}</option>
        {/each}
        <option value="custom">Upload your own</option>
      </select>
    </div>
    {#if clipChoice === 'custom'}
      <FilePicker types=".json,.geojson" bind:value={customShapeText} readAsText={true} />
    {/if}
    {#if clipChoice !== 'none'}
      <label class="check" title="Show only what is outside the shape, e.g. choose Continents to keep just the oceans.">
        <input type="checkbox" bind:checked={$settings.clipInvert} /> Invert (keep everything outside the shape)
      </label>
    {/if}
    {#if clipProblem}<p role="alert"><small>{clipProblem}</small></p>{/if}
  </fieldset>

  <fieldset>
    <legend>Projection</legend>
    <div class="row">
      <label for="projection">Projection</label>
      <select id="projection" bind:value={$settings.projection}>
        {#each PROJECTIONS as p}
          <option value={p.id}>{p.label}</option>
        {/each}
      </select>
    </div>
    <label
      class="check"
      title="Fit the map to the whole globe, centred on Greenwich, instead of to the data. Keeps the map framing the same whatever the crop."
    >
      <input type="checkbox" bind:checked={$settings.wholeWorld} /> Whole world
    </label>
  </fieldset>

  <fieldset>
    <legend>Export</legend>
    <ButtonGroup>
      <button type="button" disabled={!hasOutput} onclick={exportGeoJson}>GeoJSON</button>
      <button type="button" disabled={!hasOutput} onclick={exportSvg}>SVG</button>
      <button type="button" disabled={!hasOutput} onclick={exportPng}>PNG</button>
    </ButtonGroup>
    {#if exportError}<p role="alert"><small>{exportError}</small></p>{/if}
  </fieldset>
{/snippet}
  <BuilderFrame {Viz} {Sidebar} />

<style>
  .placeholder {
    margin: 2em auto;
    text-align: center;
    opacity: 0.7;
  }

  /* The svg scales to fit the available space (contain), so the preview never scrolls. */
  .preview {
    position: relative;
    width: 100%;
    height: 100%;
    max-height: 100dvh;
    overflow: hidden;
  }

  .preview :global(figure),
  .preview :global(.map) {
    height: 100%;
    max-height: 100dvh;
  }

  .updating {
    position: absolute;
    top: 0.5em;
    right: 0.5em;
    font-size: 0.8em;
    opacity: 0.7;
  }

  /* Fieldsets default to min-width: min-content, so wide children push them past the sidebar. */
  fieldset {
    min-width: 0;
  }

  .distribution {
    min-width: 0;
    max-width: 100%;
  }

  .distribution :global(svg),
  .distribution :global(input[type='number']) {
    max-width: 100%;
  }

  /* Label and control share a line. */
  .row {
    display: flex;
    align-items: center;
    gap: 0.5rem;
  }

  .row label,
  .row .row-label {
    flex: 0 0 7.5em;
    margin: 0;
  }

  .row select,
  .row input:not([type='radio']):not([type='checkbox']) {
    flex: 1;
    min-width: 0;
  }

  .row.builder__inline {
    flex-wrap: wrap;
    gap: 0.5rem 1rem;
  }

  .row .check {
    flex: none;
    display: inline-flex;
    align-items: center;
    gap: 0.3em;
  }

  .row .toggles {
    display: flex;
    flex-wrap: wrap;
    gap: 0.5rem 1rem;
    margin-left: auto;
  }

  .nowrap {
    white-space: nowrap;
  }

  .data-name {
    overflow-wrap: anywhere;
  }
</style>