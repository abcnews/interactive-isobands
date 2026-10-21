<script module lang="ts">
  import { ColourMode, DivergentPalette, SequentialPalette, getSequentialSteppedPalette } from '@abcnews/palette';
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

  /**
   * "Summer heat", as used in App.svelte: a stepped (not interpolated) red palette.
   * Colours are [grey, 25-30, 30-35, 35-40, 40-45, 45+]; anything under 25 gets the grey.
   */
  const SUMMER_HEAT_THRESHOLDS = [25, 30, 35, 40, 45];
  const SUMMER_HEAT_COLOURS = getSequentialSteppedPalette(
    SUMMER_HEAT_THRESHOLDS.length,
    SequentialPalette.Red,
    ColourMode.Light
  );

  /** Colour for values outside a custom min/max: the same grey the Summer heat preset uses below its first threshold. */
  const OUT_OF_RANGE_COLOUR = SUMMER_HEAT_COLOURS[0];

  const PRESETS = [
    {
      id: 'summer-heat',
      label: 'Summer heat',
      // The interval matches the 5° colour steps so band edges land on the thresholds.
      // min/max are deliberately wider than the thresholds so cool and extreme cells aren't dropped.
      min: 0,
      max: 55,
      interval: 5,
      palette: (value: number): string => {
        const step = SUMMER_HEAT_THRESHOLDS.filter((t) => value >= t).length;
        return SUMMER_HEAT_COLOURS[Math.min(step, SUMMER_HEAT_COLOURS.length - 1)];
      }
    }
  ] as const satisfies readonly Preset[];

  const NO_PRESET = 'none';
  type PresetId = typeof NO_PRESET | (typeof PRESETS)[number]['id'];
  const PRESET_IDS: readonly PresetId[] = [NO_PRESET, ...PRESETS.map((p) => p.id)];

  // ---------------------------------------------------------------------------
  // Settings: synced with the URL hash, and the source of truth for everything below
  // ---------------------------------------------------------------------------

  /** Bundled boundaries. Served from /public. Add more here as they become available. */
  const BUILT_IN_SHAPES = [
    { id: 'world-simple', label: 'Continents', url: '../world-sm.geo.json' },
    { id: 'aus', label: 'Australia', url: '../aus-md.geo.json' },
    { id: 'aus-simple', label: 'Australia (Simplified)', url: '../aus-sm.geo.json' }
  ];

  // ---------------------------------------------------------------------------
  // Projections
  // ---------------------------------------------------------------------------

  const PROJECTIONS = [
    { id: 'australia', label: 'Australia (conic conformal)' },
    { id: 'equal-earth', label: 'Equal Earth' },
    { id: 'mercator', label: 'Web Mercator' }
  ] as const;

  type ProjectionId = (typeof PROJECTIONS)[number]['id'];
  const PROJECTION_IDS: readonly ProjectionId[] = PROJECTIONS.map((p) => p.id);

  /**
   * Data that sits entirely inside this lon/lat box (degrees) counts as "around Australia" and keeps
   * the Australian conic projection. Padded beyond the continent so offshore grids still qualify.
   */
  const AUSTRALIA_REGION = { west: 100, south: -55, east: 175, north: 0 };

  type Bbox = [west: number, south: number, east: number, north: number];

  /** Picks the starting projection for a dataset: Australian conic if it's around Australia, otherwise Equal Earth. */
  const defaultProjectionFor = (bbox: Bbox | undefined): ProjectionId => {
    if (!bbox) return 'equal-earth';
    const [west, south, east, north] = bbox;
    // If the extent isn't plausibly lon/lat degrees (e.g. a projected CRS, or a 0-360 grid), we can't judge it.
    const isDegrees = west >= -180 && east <= 180 && south >= -90 && north <= 90;
    if (!isDegrees) return 'equal-earth';
    const { west: w, south: s, east: e, north: n } = AUSTRALIA_REGION;
    return west >= w && east <= e && south >= s && north <= n ? 'australia' : 'equal-earth';
  };

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
  import { geoArea, geoConicConformal, geoEqualEarth, geoMercator, geoPath, type GeoProjection } from 'd3-geo';
  import { fromArrayBuffer } from 'geotiff';
  import type { Feature, FeatureCollection, Geometry, MultiPoint } from 'geojson';
  import { createIsobands } from '../../lib/createisobands.ts';
  import type { GeoJsonInput } from '../../lib/fastclip.ts';
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

  /** SVG user-space width. Height is derived from the data's projected shape. */
  const WIDTH = 1000;
  /** PNG export width in pixels. PNGs are always transparent. */
  const EXPORT_WIDTH = 4000;
  const MAX_BANDS = 60;
  /** Max number of raster values kept to draw the range histogram. */
  const SAMPLE_SIZE = 20000;
  /** When deriving an interval from the data, aim for roughly this many bands. */
  const TARGET_BANDS = 10;

  const log = (...args: unknown[]) => console.debug('[isobands]', ...args);
  const warn = (...args: unknown[]) => console.warn('[isobands]', ...args);

  /** Strips floating point noise (0.30000000000000004 -> 0.3). */
  const tidy = (n: number) => Number(n.toPrecision(10));

  const niceInterval = (range: number) => {
    const raw = range / TARGET_BANDS;
    const pow = 10 ** Math.floor(Math.log10(raw));
    const f = raw / pow;
    return tidy((f <= 1 ? 1 : f <= 2 ? 2 : f <= 5 ? 5 : 10) * pow);
  };

  type DataRange = { min: number; max: number };
  type Inspection = DataRange & { values: number[]; bbox?: Bbox };

  /** Reads band 1 of the GeoTIFF and returns its min/max plus an evenly strided sample of values, ignoring nodata. */
  const inspectTiff = async (buf: ArrayBuffer): Promise<Inspection> => {
    const tiff = await fromArrayBuffer(buf);
    const image = await tiff.getImage();
    const noData = image.getGDALNoData();
    log('geotiff', { width: image.getWidth(), height: image.getHeight(), bands: image.getSamplesPerPixel(), noData });
    const [raster] = (await image.readRasters({ samples: [0] })) as unknown as ArrayLike<number>[];
    let lo = Infinity;
    let hi = -Infinity;
    const stride = Math.max(1, Math.ceil(raster.length / SAMPLE_SIZE));
    const values: number[] = [];
    for (let i = 0; i < raster.length; i++) {
      const v = raster[i];
      // Skip NaN/Infinity, declared nodata, and common float sentinels like -3.4e38.
      if (!Number.isFinite(v) || v === noData || Math.abs(v) > 1e30) continue;
      if (v < lo) lo = v;
      if (v > hi) hi = v;
      if (i % stride === 0) values.push(v);
    }
    if (lo > hi) throw new Error('The GeoTIFF contains no valid values in its first band.');

    // Geographic extent, used to choose a projection. Not fatal if the file has no georeferencing.
    let bbox: Bbox | undefined;
    try {
      const [x1, y1, x2, y2] = image.getBoundingBox();
      bbox = [Math.min(x1, x2), Math.min(y1, y2), Math.max(x1, x2), Math.max(y1, y2)];
    } catch (e) {
      log('no bounding box', e);
    }
    return { min: lo, max: hi, values, bbox };
  };

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
  const bandCount = $derived(interval > 0 && max > min ? Math.ceil((max - min) / interval - 1e-9) : 0);

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
    let nextMin: number;
    let nextMax: number;
    let nextInterval: number;
    if (r.max === r.min) {
      nextMin = Math.floor(r.min);
      nextMax = nextMin + 1;
      nextInterval = 1;
    } else {
      nextInterval = niceInterval(r.max - r.min);
      nextMin = tidy(Math.floor(r.min / nextInterval) * nextInterval);
      nextMax = tidy(Math.ceil(r.max / nextInterval) * nextInterval);
    }
    settings.update((s) => ({
      ...s,
      min: nextMin,
      max: nextMax,
      interval: nextInterval,
      neutral: tidy((nextMin + nextMax) / 2)
    }));
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
          const next = defaultProjectionFor(range.bbox);
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
    const usingPreset = !!preset;

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
        // too; `colours` paints those bands grey, or with the nearest end colour if that option is on. Presets skip this: their
        // palettes already handle everything within their (deliberately wide) range.
        const parts = [opts];
        if (!usingPreset) {
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
        }
        const [main, ...outside] = await Promise.all(
          // The buffer is copied in case createIsobands transfers it (which would detach it for later runs).
          parts.map((part) => createIsobands(data.slice(0), { clipTo: boundary, palette: colours, ...part }))
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
  // Inverting the crop shape
  // ---------------------------------------------------------------------------

  /** Collects every polygon ([exterior, ...holes]) from any GeoJSON input: collections, features, geometries. */
  const collectPolygons = (input: unknown): number[][][][] => {
    const out: number[][][][] = [];
    const walk = (g: any) => {
      if (!g) return;
      switch (g.type) {
        case 'FeatureCollection':
          g.features?.forEach(walk);
          break;
        case 'Feature':
          walk(g.geometry);
          break;
        case 'GeometryCollection':
          g.geometries?.forEach(walk);
          break;
        case 'Polygon':
          out.push(g.coordinates);
          break;
        case 'MultiPolygon':
          out.push(...g.coordinates);
          break;
      }
    };
    walk(input);
    return out;
  };

  /** Returns the ring wound clockwise or anticlockwise (y up), reversing it if needed. */
  const orient = (ring: number[][], clockwise: boolean) => ((area(ring) > 0) === clockwise ? ring : [...ring].reverse());

  /**
   * Builds the "everything except this shape" polygon: a frame with each of the shape's polygons cut out as
   * a hole, plus any holes *in* the shape (lakes, say) added back as islands. The frame covers the shape and
   * the raster (or the whole world if the raster isn't georeferenced), padded so no hole touches its edge.
   * Follows RFC 7946 winding: frame anticlockwise, holes clockwise.
   */
  const invertShape = (shape: unknown, bbox: Bbox | undefined) => {
    const polygons = collectPolygons(shape);
    if (!polygons.length) {
      return { problem: 'That shape has no polygons, so it cannot be inverted.' } as const;
    }

    const { points } = collectPoints({
      type: 'FeatureCollection',
      features: polygons.map((coordinates) => ({ type: 'Feature', properties: {}, geometry: { type: 'Polygon', coordinates } }))
    });
    const shapeExtent = extentOf(points);
    const [w, s, e, n] = bbox && looksLikeDegrees(bbox) ? bbox : [-180, -90, 180, 90];
    const PAD = 1;
    const west = Math.min(shapeExtent.west, w) - PAD;
    const south = Math.min(shapeExtent.south, s) - PAD;
    const east = Math.max(shapeExtent.east, e) + PAD;
    const north = Math.max(shapeExtent.north, n) + PAD;

    const frame = [
      [west, south],
      [east, south],
      [east, north],
      [west, north],
      [west, south]
    ];
    const holes = polygons.map((polygon) => orient(polygon[0], true));
    const islands = polygons.flatMap((polygon) => polygon.slice(1).map((ring) => [orient(ring, false)]));

    const shapeOut = {
      type: 'FeatureCollection',
      features: [
        {
          type: 'Feature',
          properties: {},
          geometry: { type: 'MultiPolygon', coordinates: [[orient(frame, false), ...holes], ...islands] }
        }
      ]
    } as unknown as GeoJsonInput;
    return { shape: shapeOut, frame: { west, south, east, north }, holes: holes.length } as const;
  };

  // ---------------------------------------------------------------------------
  // Projecting to SVG paths (same approach as IsobandMap.svelte)
  // ---------------------------------------------------------------------------
  //
  // Every projection is fitted the same way: from the planar lon/lat *vertices* of the geometry
  // being drawn, never from the polygons themselves. d3's fit*, geoBounds and geoCentroid work on
  // the sphere, where a ring wound the "wrong" way means "everything except this shape". One such
  // ring (easy to get out of a clipper) makes the fit cover the whole globe. Fitting to points
  // can't be fooled by winding. Diagnostics are logged under [isobands] so a bad fit can be traced.

  /** Web Mercator's latitude limit: beyond this the projection runs off to infinity. */
  const MERCATOR_MAX_LAT = 85.0511;

  /** How to create each projection (unfitted). Adding a ProjectionId forces an entry here. */
  type ProjectionBuilder = {
    /** Returns a fresh, unfitted projection. `centreLon` is the data's centre longitude. */
    create: (centreLon: number) => GeoProjection;
    /** True if the projection can't take polar vertices (Web Mercator), so latitudes are clamped first. */
    clampLatitudes?: boolean;
    /** [south, north] latitudes that make up "the whole world" for this projection. Defaults to [-90, 90]. */
    worldLatitudes?: [number, number];
  };

  const PROJECTION_BUILDERS: Record<ProjectionId, ProjectionBuilder> = {
    // Conformal cones blow up towards the pole on the far side of their parallels, so stop short of it.
    australia: { create: () => geoConicConformal().parallels([-18, -36]).rotate([-134, 0]), worldLatitudes: [-90, 60] },
    'equal-earth': { create: (centreLon) => geoEqualEarth().rotate([-centreLon, 0]) },
    mercator: {
      create: (centreLon) => geoMercator().rotate([-centreLon, 0]),
      clampLatitudes: true,
      worldLatitudes: [-MERCATOR_MAX_LAT, MERCATOR_MAX_LAT]
    }
  };

  /** Smallest lon/lat span (degrees) we'll fit to, so a single point or a line doesn't give an infinite scale. */
  const MIN_SPAN = 0.01;

  type Extent = { west: number; south: number; east: number; north: number };

  /** Shoelace sum over lon/lat: > 0 means clockwise (y up). */
  const area = (ring: number[][]) =>
    ring.reduce((sum, [x, y], i) => sum + (ring[(i + 1) % ring.length][0] - x) * (ring[(i + 1) % ring.length][1] + y), 0);

  /** d3-geo wants exterior rings clockwise and holes anticlockwise. */
  const rewind = (polygon: number[][][]) =>
    polygon.map((ring, i) => ((area(ring) > 0) === (i === 0) ? ring : [...ring].reverse()));

  /**
   * Cleans one polygon for drawing: drops degenerate rings (fewer than 4 positions can't enclose
   * anything; clippers sometimes emit them) and fixes winding. Returns undefined if no usable exterior is left.
   */
  const preparePolygon = (polygon: number[][][], stats: { dropped: number }): number[][][] | undefined => {
    if (!polygon[0] || polygon[0].length < 4) {
      stats.dropped++;
      return undefined;
    }
    return rewind(polygon.filter((ring, i) => i === 0 || ring.length >= 4));
  };

  /** Clamps every latitude in a coordinate array to Web Mercator's limit. Vertices at +/-90 otherwise project to Infinity/NaN. */
  const clampLatitudes = (c: any): any =>
    typeof c[0] === 'number' ? [c[0], Math.max(-MERCATOR_MAX_LAT, Math.min(MERCATOR_MAX_LAT, c[1])), ...c.slice(2)] : c.map(clampLatitudes);

  /** Flattens every finite [lon, lat] vertex out of a collection, counting any that were skipped as non-finite. */
  const collectPoints = (collection: FeatureCollection) => {
    const points: number[][] = [];
    let skipped = 0;
    const walk = (c: any) => {
      if (typeof c[0] === 'number') {
        if (Number.isFinite(c[0]) && Number.isFinite(c[1])) points.push(c);
        else skipped++;
      } else c.forEach(walk);
    };
    for (const f of collection.features) if ('coordinates' in f.geometry) walk(f.geometry.coordinates);
    return { points, skipped };
  };

  const extentOf = (points: number[][]): Extent => {
    const e: Extent = { west: Infinity, south: Infinity, east: -Infinity, north: -Infinity };
    for (const [lon, lat] of points) {
      if (lon < e.west) e.west = lon;
      if (lon > e.east) e.east = lon;
      if (lat < e.south) e.south = lat;
      if (lat > e.north) e.north = lat;
    }
    return e;
  };

  /** Spacing (degrees) of the sample points along the world's edge. */
  const WORLD_STEP = 5;

  /** Points tracing the edge of the whole world (lon -180..180) between two latitudes. Enough for d3 to fit to. */
  const worldOutline = ([south, north]: [number, number]): number[][] => {
    const points: number[][] = [];
    for (let lon = -180; lon <= 180; lon += WORLD_STEP) points.push([lon, south], [lon, north]);
    for (let lat = Math.ceil(south / WORLD_STEP) * WORLD_STEP; lat <= north; lat += WORLD_STEP) points.push([-180, lat], [180, lat]);
    points.push([-180, south], [180, south], [-180, north], [180, north]);
    return points;
  };

  /**
   * The longitude to centre the map on. Defaults to the middle of the plain west-east extent, which puts
   * world-spanning data on the Greenwich side as expected. Only when the data is a compact region that
   * crosses the antimeridian (Fiji, NZ's Chatham Islands, Alaska's Aleutians...) does it centre on the
   * wrapped arc instead; otherwise such data would be split across both edges of the map.
   *
   * "Compact" matters: for world-spanning data the smallest arc just routes around whichever interior gap
   * is widest (e.g. the Pacific), which would wrongly centre the map on the antimeridian.
   */
  const MAX_WRAPPED_SPAN = 180;

  const centreLongitude = (points: number[][]) => {
    if (!points.length) return { centre: 0, mode: 'empty' as const, planarSpan: 0, wrappedSpan: 0 };
    const lons = Float64Array.from(points, (p) => p[0]).sort();
    const west = lons[0];
    const east = lons[lons.length - 1];
    const planarSpan = east - west;
    const planarCentre = (west + east) / 2;

    // Widest empty gap between neighbouring longitudes, counting the one across the antimeridian.
    let widestGap = west + 360 - east;
    let wrappedCentre = planarCentre;
    for (let i = 1; i < lons.length; i++) {
      const gap = lons[i] - lons[i - 1];
      if (gap > widestGap) {
        widestGap = gap;
        wrappedCentre = (lons[i] + lons[i - 1] + 360) / 2; // data spans lons[i] .. lons[i - 1] + 360
      }
    }
    const wrappedSpan = 360 - widestGap;

    const wrap = planarSpan > MAX_WRAPPED_SPAN && wrappedSpan <= MAX_WRAPPED_SPAN;
    const centre = wrap ? wrappedCentre : planarCentre;
    return {
      centre: ((centre + 540) % 360) - 180,
      mode: wrap ? ('wrapped' as const) : ('planar' as const),
      planarSpan,
      wrappedSpan
    };
  };

  /** True if the extent is plausibly lon/lat degrees (a projected CRS or 0-360 grid can't be compared). */
  const looksLikeDegrees = ([west, south, east, north]: Bbox) =>
    west >= -180 && east <= 180 && south >= -90 && north <= 90;

  /**
   * Creates the chosen projection fitted to WIDTH, plus the SVG height that fits the result.
   * Returns undefined (after logging why) if there's nothing finite to fit to.
   */
  const fitProjection = (id: ProjectionId, collection: FeatureCollection, world: boolean) => {
    const { points, skipped } = collectPoints(collection);
    if (skipped) warn('skipped non-finite vertices', { skipped });
    if (!points.length) {
      warn('nothing to fit: no finite vertices', { projection: id });
      return undefined;
    }

    // The data's own extent, used for diagnostics (and for fitting unless "whole world" is on).
    const extent = extentOf(points);

    // "Whole world": a fixed frame, centred on Greenwich, however much of the globe the (possibly cropped)
    // bands cover. Without it the frame follows the data, so a crop that drops Antarctica would zoom the map.
    const { centre: centreLon, mode: centreMode, planarSpan, wrappedSpan } = world
      ? { centre: 0, mode: 'world' as const, planarSpan: 360, wrappedSpan: 360 }
      : centreLongitude(points);

    let fitPoints: number[][];
    if (world) {
      fitPoints = worldOutline(PROJECTION_BUILDERS[id].worldLatitudes ?? [-90, 90]);
    } else {
      fitPoints = [...points];
      // Pad degenerate extents (one point, a straight N-S or E-W line) so the fit has something to scale to.
      if (extent.east - extent.west < MIN_SPAN || extent.north - extent.south < MIN_SPAN) {
        const lat = (extent.north + extent.south) / 2;
        fitPoints.push([centreLon - MIN_SPAN / 2, lat - MIN_SPAN / 2], [centreLon + MIN_SPAN / 2, lat + MIN_SPAN / 2]);
        warn('degenerate extent padded', extent);
      }
    }
    const target: MultiPoint = { type: 'MultiPoint', coordinates: fitPoints };

    // Fresh projection each time: fit* mutates it. fitWidth scales to WIDTH and pins the top of
    // the shape to y=0, so the bottom edge is the height we need.
    const projection = PROJECTION_BUILDERS[id].create(centreLon).fitWidth(WIDTH, target);
    const [[x0, y0], [x1, y1]] = geoPath(projection).bounds(target);
    const height = Math.ceil(y1);

    log('fit', {
      projection: id,
      wholeWorld: world,
      vertices: points.length,
      extent,
      centreLon,
      centreMode,
      lonSpan: { planar: planarSpan, wrapped: wrappedSpan },
      scale: projection.scale(),
      translate: projection.translate(),
      projectedBounds: [
        [x0, y0],
        [x1, y1]
      ],
      height
    });

    if (!Number.isFinite(projection.scale()) || !Number.isFinite(height)) {
      warn('fit produced a non-finite projection; falling back to the default height', { projection: id, extent });
      return undefined;
    }
    return { projection, height: Math.max(1, height), extent };
  };

  /** Projected paths plus the SVG height that fits them at WIDTH, so the aspect ratio comes from the data. */
  const layout = $derived.by(() => {
    const fallback = { height: WIDTH * 0.75, paths: [] };
    if (!bands?.features.length) return fallback;
    const started = performance.now();
    const clamp = !!PROJECTION_BUILDERS[projectionId].clampLatitudes;

    // Prepare the geometry: drop degenerate polygons, fix winding, clamp latitudes if the projection needs it.
    const stats = { dropped: 0 };
    const geometryTypes: Record<string, number> = {};
    const features: Feature[] = [];
    for (const f of bands.features) {
      const g = f.geometry;
      geometryTypes[g?.type ?? 'none'] = (geometryTypes[g?.type ?? 'none'] ?? 0) + 1;
      let geometry: Geometry = g;
      if (g?.type === 'Polygon') {
        const polygon = preparePolygon(g.coordinates, stats);
        if (!polygon) continue;
        geometry = { ...g, coordinates: polygon };
      } else if (g?.type === 'MultiPolygon') {
        const polygons = g.coordinates.map((p) => preparePolygon(p, stats)).filter((p): p is number[][][] => !!p);
        if (!polygons.length) continue;
        geometry = { ...g, coordinates: polygons };
      }
      if (clamp && geometry && 'coordinates' in geometry) {
        geometry = { ...geometry, coordinates: clampLatitudes(geometry.coordinates) } as Geometry;
      }
      features.push({ ...f, geometry } as Feature);
    }
    const collection: FeatureCollection = { type: 'FeatureCollection', features };
    log('layout input', {
      projection: projectionId,
      received: bands.features.length,
      drawn: features.length,
      droppedPolygons: stats.dropped,
      geometryTypes
    });
    if (!features.length) return fallback;

    // Spherical sanity check (diagnostic only; the fit doesn't depend on it). A polygon covering more than
    // a hemisphere is almost certainly a ring d3 reads as inverted, which draws as "the whole world minus this".
    const inverted = features.flatMap((f, i) => (geoArea(f) > 2 * Math.PI ? [i] : []));
    if (inverted.length) warn('features covering more than a hemisphere (likely inverted winding)', { count: inverted.length, firstIndexes: inverted.slice(0, 10) });

    const fit = fitProjection(projectionId, collection, wholeWorld);
    if (!fit) return fallback;

    // Diagnostic: bands should sit inside the raster. If they don't, the geometry is wrong before it reaches this
    // component (createIsobands / clipTo), and no amount of fitting here will make the map look right.
    const bbox = dataBbox;
    if (bbox && looksLikeDegrees(bbox)) {
      const [west, south, east, north] = bbox;
      const tol = 1;
      const { extent } = fit;
      if (extent.west < west - tol || extent.east > east + tol || extent.south < south - tol || extent.north > north + tol) {
        warn('band geometry extends beyond the raster: the clip/isoband output is oversized', { bandExtent: extent, rasterBbox: bbox });
      }
    }

    const toPath = geoPath(fit.projection);
    let empty = 0;
    const paths = collection.features.map((feature) => {
      const p = feature.properties ?? {};
      const d = toPath(feature) ?? '';
      if (!d) empty++;
      return {
        d,
        fill: typeof p.fill === 'string' ? p.fill : '#555555',
        fillOpacity: Number.isFinite(Number(p['fill-opacity'])) ? Number(p['fill-opacity']) : 0.6,
        stroke: typeof p.stroke === 'string' ? p.stroke : 'none',
        strokeOpacity: Number.isFinite(Number(p['stroke-opacity'])) ? Number(p['stroke-opacity']) : 1,
        strokeWidth: Number.isFinite(Number(p['stroke-width'])) ? Number(p['stroke-width']) : 2
      };
    });
    if (empty) warn('features that produced an empty path', { empty, of: paths.length });
    log('layout done', { paths: paths.length, height: fit.height, ms: Math.round(performance.now() - started) });
    return { height: fit.height, paths };
  });

  const paths = $derived(layout.paths);
  const height = $derived(layout.height);

  // ---------------------------------------------------------------------------
  // Exports
  // ---------------------------------------------------------------------------

  const escapeAttr = (s: string) => s.replace(/&/g, '&amp;').replace(/"/g, '&quot;').replace(/</g, '&lt;');

  const buildSvg = (width = WIDTH) => {
    const h = Math.round((width * height) / WIDTH);
    const body = paths
      .map(
        (p) =>
          `<path d="${p.d}" fill="${escapeAttr(p.fill)}" fill-opacity="${p.fillOpacity}" stroke="${escapeAttr(p.stroke)}" stroke-opacity="${p.strokeOpacity}" stroke-width="${p.strokeWidth}"/>`
      )
      .join('\n');
    return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${WIDTH} ${height}" width="${width}" height="${h}">\n${body}\n</svg>`;
  };

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

  const exportSvg = () => {
    if (!paths.length) return;
    download(new Blob([buildSvg()], { type: 'image/svg+xml' }), `${baseName}.svg`);
  };

  const exportPng = async () => {
    if (!paths.length) return;
    exportError = undefined;
    const w = EXPORT_WIDTH;
    const h = Math.round((w * height) / WIDTH);
    const svgBlob = new Blob([buildSvg(w)], { type: 'image/svg+xml' });
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

  const hasOutput = $derived(paths.length > 0);

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
      <svg viewBox="0 0 {WIDTH} {height}" preserveAspectRatio="xMidYMid meet" role="img" aria-label="Isobands preview">
        {#each paths as path}
          <path
            d={path.d}
            fill={path.fill}
            fill-opacity={path.fillOpacity}
            stroke={path.stroke}
            stroke-opacity={path.strokeOpacity}
            stroke-width={path.strokeWidth}
          />
        {/each}
      </svg>
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
    {#if preset}
      <p>
        <small>
          Uses a fixed range of {preset.min} to {preset.max} in steps of {preset.interval}, with its own colours.
        </small>
      </p>
    {/if}
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
    <p><small>Set from the data's extent when a file loads: Australian data keeps the conic projection, anything else starts on Equal Earth.</small></p>
    <p><small>Whole world fits the map to the full globe, centred on Greenwich. Leave it off to fit the map to the data.</small></p>
  </fieldset>

  <fieldset>
    <legend>Export</legend>
    <ButtonGroup>
      <button type="button" disabled={!hasOutput} onclick={exportGeoJson}>GeoJSON</button>
      <button type="button" disabled={!hasOutput} onclick={exportSvg}>SVG</button>
      <button type="button" disabled={!hasOutput} onclick={exportPng}>PNG</button>
    </ButtonGroup>
    <p><small>GeoJSON uses simplestyle properties, ready for Globey.</small></p>
    {#if exportError}<p role="alert"><small>{exportError}</small></p>{/if}
  </fieldset>
{/snippet}
BUILDER YO
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

  .preview svg {
    display: block;
    width: 100%;
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