// fastClip.ts
//
// Fast polygon clipping for GeoJSON using clipper-lib (pure JS, no WASM).
// Extra dep:  npm i clipper-lib
import type {
  Feature,
  FeatureCollection,
  Geometry,
  MultiPolygon,
  Polygon,
  Position,
} from "geojson";
// @ts-ignore -- clipper-lib ships no types; the parts we use are declared below
import ClipperLib from "clipper-lib";

/* ------------------------------- Types ------------------------------- */

/** Anything that can hold polygons: a FeatureCollection, a single Feature, or a bare geometry. */
export type GeoJsonInput = FeatureCollection | Feature | Geometry;

export type FastClipOptions = {
  /**
   * Decimal places of coordinate precision kept while clipping (default 5, ~1.1 m for lon/lat degrees).
   * Coordinates are scaled to integers by 10^decimalPlaces. Up to 5 keeps lon/lat inside
   * Clipper's fastest integer range; higher values are still correct but slower.
   */
  readonly decimalPlaces?: number;
};

type PolygonFeature = Feature<Polygon | MultiPolygon>;

/** The slice of clipper-lib's API this module uses. */
type IntPoint = { X: number; Y: number };
export type ClipperPath = IntPoint[];
type PolyNode = {
  Contour(): ClipperPath;
  Childs(): PolyNode[];
  IsHole(): boolean;
};
type ClipperInstance = {
  AddPaths(paths: ClipperPath[], polyType: number, closed: boolean): boolean;
  Execute(
    clipType: number,
    solution: PolyNode | ClipperPath[],
    subjectFill: number,
    clipFill: number,
  ): boolean;
};
type ClipperApi = {
  Clipper: new () => ClipperInstance;
  PolyTree: new () => PolyNode;
  PolyType: { ptSubject: number; ptClip: number };
  ClipType: { ctIntersection: number; ctUnion: number };
  PolyFillType: { pftEvenOdd: number };
};

const Clipper = ClipperLib as ClipperApi;

const DEFAULT_DECIMAL_PLACES = 5;

/* ------------------------------ GeoJSON ------------------------------ */

/** True when a feature has a Polygon or MultiPolygon geometry. */
const isPolygonFeature = (feature: Feature): feature is PolygonFeature =>
  feature.geometry?.type === "Polygon" ||
  feature.geometry?.type === "MultiPolygon";

/** Normalises any GeoJSON input to its polygon features, ignoring everything else. */
const toPolygonFeatures = (input: GeoJsonInput): PolygonFeature[] => {
  const features: Feature[] =
    input.type === "FeatureCollection"
      ? input.features
      : input.type === "Feature"
        ? [input]
        : [{ type: "Feature", properties: {}, geometry: input }];

  return features.filter(isPolygonFeature);
};

/** Lists a Polygon/MultiPolygon geometry as an array of polygon coordinate sets. */
const polygonsOf = (geometry: Polygon | MultiPolygon): Position[][][] =>
  geometry.type === "Polygon" ? [geometry.coordinates] : geometry.coordinates;

/* ---------------------------- Clipper bridge ------------------------- */

/** Scales a closed GeoJSON ring to a Clipper path (Clipper paths are implicitly closed, so the repeated last point is dropped). */
const ringToClipperPath = (ring: Position[], scale: number): ClipperPath =>
  ring.slice(0, -1).map(([x, y]) => ({
    X: Math.round(x * scale),
    Y: Math.round(y * scale),
  }));

/** Flattens polygons into one list of Clipper paths (outer rings and holes alike; even-odd fill sorts out which is which). */
const polygonsToClipperPaths = (
  polygons: Position[][][],
  scale: number,
): ClipperPath[] =>
  polygons.flatMap((polygon) =>
    polygon.map((ring) => ringToClipperPath(ring, scale)),
  );

/** Scales a Clipper path back to a closed GeoJSON ring. */
const clipperPathToRing = (path: ClipperPath, scale: number): Position[] => {
  const ring = path.map(({ X, Y }) => [X / scale, Y / scale]);
  return [...ring, ring[0]];
};

/**
 * Walks a Clipper PolyTree into GeoJSON polygons. Top-level nodes are outer
 * contours, their children are holes, and holes' children are outer contours again.
 */
const collectPolygons = (
  nodes: PolyNode[],
  scale: number,
  out: Position[][][],
): void => {
  for (const outer of nodes) {
    const holes = outer.Childs();
    out.push([
      clipperPathToRing(outer.Contour(), scale),
      ...holes.map((hole) => clipperPathToRing(hole.Contour(), scale)),
    ]);
    for (const hole of holes) collectPolygons(hole.Childs(), scale, out);
  }
};

/**
 * Resolves a set of closed paths into polygons with holes nested, using even-odd fill.
 * Used to turn flat ring lists (e.g. marching-squares output) into GeoJSON polygons.
 * Paths are already scaled to integers by `scale`; output is scaled back down.
 */
export const pathsToPolygons = (
  paths: ClipperPath[],
  scale: number,
): Position[][][] => {
  const clipper = new Clipper.Clipper();
  clipper.AddPaths(paths, Clipper.PolyType.ptSubject, true);

  const tree = new Clipper.PolyTree();
  clipper.Execute(
    Clipper.ClipType.ctUnion,
    tree,
    Clipper.PolyFillType.pftEvenOdd,
    Clipper.PolyFillType.pftEvenOdd,
  );

  const polygons: Position[][][] = [];
  collectPolygons(tree.Childs(), scale, polygons);
  return polygons;
};

/** Merges two path sets into their union. Each set is filled even-odd on its own, so overlapping sets combine correctly. */
const unionPaths = (a: ClipperPath[], b: ClipperPath[]): ClipperPath[] => {
  const clipper = new Clipper.Clipper();
  clipper.AddPaths(a, Clipper.PolyType.ptSubject, true);
  clipper.AddPaths(b, Clipper.PolyType.ptClip, true);

  const solution: ClipperPath[] = [];
  clipper.Execute(
    Clipper.ClipType.ctUnion,
    solution,
    Clipper.PolyFillType.pftEvenOdd,
    Clipper.PolyFillType.pftEvenOdd,
  );
  return solution;
};

/** Builds the clip mask as one path set, unioning features if there are several (e.g. one per state). */
const buildClipPaths = (clip: GeoJsonInput, scale: number): ClipperPath[] => {
  const features = toPolygonFeatures(clip);
  if (features.length === 0) {
    throw new Error(
      "fastClip: clipGeoJson contains no Polygon or MultiPolygon features",
    );
  }
  return features
    .map((f) => polygonsToClipperPaths(polygonsOf(f.geometry), scale))
    .reduce(unionPaths);
};

/** Intersects one feature with the clip paths and returns the resulting polygons. */
const clipFeature = (
  feature: PolygonFeature,
  clipPaths: ClipperPath[],
  scale: number,
): Position[][][] => {
  const clipper = new Clipper.Clipper();
  clipper.AddPaths(
    polygonsToClipperPaths(polygonsOf(feature.geometry), scale),
    Clipper.PolyType.ptSubject,
    true,
  );
  clipper.AddPaths(clipPaths, Clipper.PolyType.ptClip, true);

  const tree = new Clipper.PolyTree();
  clipper.Execute(
    Clipper.ClipType.ctIntersection,
    tree,
    Clipper.PolyFillType.pftEvenOdd,
    Clipper.PolyFillType.pftEvenOdd,
  );

  const polygons: Position[][][] = [];
  collectPolygons(tree.Childs(), scale, polygons);
  return polygons;
};

/* ------------------------------ Public API --------------------------- */

/**
 * Clips every polygon feature in `geojson` to the area covered by `clipGeoJson`.
 *
 * - Each input feature becomes one MultiPolygon feature with its properties preserved.
 * - Features that fall entirely outside the clip area are dropped.
 * - Non-polygon features in `geojson` are ignored.
 * - If `clipGeoJson` holds several polygon features they are unioned into one clip area.
 * - Coordinates in the result are rounded to `decimalPlaces` (default 5).
 *
 * The clip geometry is converted once and reused for every input feature, so
 * cost scales with the number of input features rather than re-processing the clip each time.
 */
export const fastClip = (
  geojson: GeoJsonInput,
  clipGeoJson: GeoJsonInput,
  { decimalPlaces = DEFAULT_DECIMAL_PLACES }: FastClipOptions = {},
): FeatureCollection<MultiPolygon> => {
  const scale = 10 ** decimalPlaces;
  const clipPaths = buildClipPaths(clipGeoJson, scale);
  const clipped: Feature<MultiPolygon>[] = [];

  for (const feature of toPolygonFeatures(geojson)) {
    const polygons = clipFeature(feature, clipPaths, scale);
    if (polygons.length === 0) continue;

    clipped.push({
      type: "Feature",
      properties: feature.properties ?? {},
      geometry: { type: "MultiPolygon", coordinates: polygons },
    });
  }

  return { type: "FeatureCollection", features: clipped };
};
