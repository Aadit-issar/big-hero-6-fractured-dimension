import type { RouteCommand, Vec3Tuple } from '../../shared/liveLink';

/** Pure geometry for the 3D route: the polyline Baymax should follow, arc length measured in WORLD metres, and the ribbon vertex arrays.
 * Legs are straight and exactly as planned (no smoothing through obstacles). No three.js here, so it is unit-tested directly. */

/** Dash pattern in world metres (not screen pixels): the dashes keep their length and spacing at 5 m and at 150 m. */
export const DASH = { on: 1.7, off: 1.3 } as const;
export const DASH_PERIOD = DASH.on + DASH.off;

const dist = (a: Vec3Tuple, b: Vec3Tuple) => Math.hypot(a[0] - b[0], a[1] - b[1], a[2] - b[2]);

/** Baymax's current position followed by the remaining waypoints (from the active one). A passed waypoint is never drawn as part of the line. */
export function routePoints(baymax: Vec3Tuple, route: RouteCommand, activeIndex: number): Vec3Tuple[] {
  const first = Math.max(0, Math.min(activeIndex, route.waypoints.length - 1));
  return [baymax, ...route.waypoints.slice(first).map(w => w.position)];
}

/** Arc length measured from the END of the polyline backwards: u(end) = 0, u(start) = total length. Anchoring the dash phase at the end keeps
 * dashes fixed in the world while Baymax (the start of the polyline) moves, and makes "u decreasing" the direction of flight. */
export function arcFromEnd(points: readonly Vec3Tuple[]): number[] {
  const u = new Array<number>(points.length).fill(0);
  for (let i = points.length - 2; i >= 0; i -= 1) u[i] = u[i + 1]! + dist(points[i]!, points[i + 1]!);
  return u;
}

/** Whether world-space arc position `u` lies on a dash. */
export function dashOn(u: number): boolean {
  const m = ((u % DASH_PERIOD) + DASH_PERIOD) % DASH_PERIOD;
  return m < DASH.on;
}

export interface RibbonArrays {
  readonly segments: number;
  /** Segment start per vertex (4 per segment) and segment end per vertex. */
  readonly start: Float32Array;
  readonly end: Float32Array;
  /** (t along the segment 0|1, side −1|+1) per vertex. */
  readonly corner: Float32Array;
  /** (u at the segment start, u at the segment end) per vertex. */
  readonly u: Float32Array;
  readonly index: Uint32Array;
}

export function allocRibbon(maxSegments: number): RibbonArrays {
  const index = new Uint32Array(maxSegments * 6);
  for (let s = 0; s < maxSegments; s += 1) index.set([s * 4, s * 4 + 1, s * 4 + 2, s * 4 + 1, s * 4 + 3, s * 4 + 2], s * 6);
  return { segments: 0, start: new Float32Array(maxSegments * 12), end: new Float32Array(maxSegments * 12), corner: new Float32Array(maxSegments * 8), u: new Float32Array(maxSegments * 8), index };
}

const CORNERS: readonly (readonly [number, number])[] = [[0, -1], [0, 1], [1, -1], [1, 1]];
/** Fills the ribbon arrays for a polyline; returns the number of segments written (zero-length legs are skipped). */
export function fillRibbon(arrays: RibbonArrays, points: readonly Vec3Tuple[]): number {
  const u = arcFromEnd(points);
  const max = arrays.start.length / 12;
  let n = 0;
  for (let i = 0; i < points.length - 1 && n < max; i += 1) {
    const a = points[i]!, b = points[i + 1]!;
    if (dist(a, b) < 1e-4) continue;
    for (let k = 0; k < 4; k += 1) {
      const j = n * 4 + k;
      arrays.start.set(a, j * 3); arrays.end.set(b, j * 3);
      arrays.corner.set(CORNERS[k]!, j * 2); arrays.u[j * 2] = u[i]!; arrays.u[j * 2 + 1] = u[i + 1]!;
    }
    n += 1;
  }
  return n;
}

/** World position of a ribbon vertex before the screen-space widening: what the vertex shader computes as mix(start, end, t). */
export function ribbonVertexPosition(arrays: RibbonArrays, vertex: number): Vec3Tuple {
  const t = arrays.corner[vertex * 2]!;
  return [0, 1, 2].map(c => arrays.start[vertex * 3 + c]! + (arrays.end[vertex * 3 + c]! - arrays.start[vertex * 3 + c]!) * t) as unknown as Vec3Tuple;
}

/** The target's forecast path from `fromTime` onward: the interpolated position at `fromTime` followed by every later sample. */
export function remainingTargetPath(path: readonly { readonly simTime: number; readonly position: Vec3Tuple }[], fromTime: number, at: (t: number) => Vec3Tuple): Vec3Tuple[] {
  const later = path.filter(p => p.simTime > fromTime).map(p => p.position);
  return later.length === 0 ? [] : [at(fromTime), ...later];
}

/** Seconds of simulated time until the planned rendezvous (never negative). */
export const countdown = (plannedSimTime: number, now: number): number => Math.max(0, plannedSimTime - now);
