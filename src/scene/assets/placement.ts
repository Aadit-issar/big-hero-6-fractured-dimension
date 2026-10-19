import { Euler, Quaternion, Vector3 } from 'three';
import { createSeededRandom } from '../../simulation/seededRandom';
import type { SimulationEngine } from '../../simulation/simulationEngine';
import type { Vec3 } from '../../simulation/types';
import { VORTEX, cavernPoint, cavernRadius } from '../dimension/layout';
import { assetSpec } from './assetRegistry';

/** Deterministic placement of decorative physical objects (rendering only).
 *
 * The layout is a seeded, world-anchored function of the engine's world (read
 * through the public API only): it never follows the camera and never changes
 * with quality. It is composed in regions so that the whole explorable space is
 * populated with meaningful density variation:
 *  - landmark wreck sites (the capsule crash and its debris trail; a concrete wall
 *    breach; a torn industrial structure; a far funnel breach; a Baymax scatter),
 *  - hazard accumulation zones at the highest sampled field hazard,
 *  - per-island debris ecosystems just outside each island's swept path,
 *  - fold-seam framing around the real connection sites (outside their clearance
 *    and never in front of an aperture),
 *  - a low sediment layer, a high drift layer and the vortex inflow spiral,
 *  - lighter ambient scatter through the cavern, modulated by a seeded
 *    low-frequency density field (dense, medium and deliberately quiet areas).
 * Every piece is validated against every island's swept path, fold endpoints,
 * aperture sightlines, candidate traversal exits, the opening pose and its
 * sightline, other pieces, and (for elongated pieces) island-to-island alignments
 * so wreckage never reads as a bridge or a connection. */

export type Quat = readonly [number, number, number, number];
export interface FoldSite { readonly id: string; readonly position: Vec3; readonly normal: Vec3 }
export interface PlacementInputs {
  readonly islandPaths: ReadonlyArray<{ readonly samples: readonly Vec3[]; readonly clearance: number }>;
  readonly foldPoints: readonly Vec3[];
  readonly exitPoints: readonly Vec3[];
  readonly opening: Vec3;
  readonly openingTarget: Vec3;
  readonly islandCentres: Readonly<Record<string, Vec3>>;
  /** Valid connection sites: mean entry position and normal over the sampled horizon. */
  readonly foldSites: readonly FoldSite[];
  /** Field hazard sampled at t = 0 over the islands' reference volume (world positions). */
  readonly hazard: ReadonlyArray<{ readonly position: Vec3; readonly hazard: number }>;
}
/** Measured model sizes (metres) from public/assets/models/manifest.json. */
export type AssetSizes = Readonly<Record<string, readonly [number, number, number]>>;

export interface DebrisInstance {
  readonly asset: string;
  readonly cluster: string;
  /** Composition region (landmark site, island ecosystem, ambient, ...). */
  readonly region: string;
  readonly position: Vec3;
  readonly quaternion: Quat;
  readonly scale: number;
  readonly radius: number;
  /** Decorative drift (model time): bob amplitude (m), period (s), phase, spin axis and rate (rad/s). */
  readonly drift: { readonly amplitude: Vec3; readonly period: number; readonly phase: number; readonly spinAxis: Vec3; readonly spinRate: number };
}

export type FormationKind = 'swarm' | 'cluster' | 'chain' | 'inactive';
export interface MicrobotFormation {
  readonly id: string;
  readonly kind: FormationKind;
  readonly centre: Vec3;
  readonly radius: number;
  /** Swirl axis and angular speed (rad/s at the core) of the formation's coherent motion. */
  readonly axis: Vec3;
  readonly omega: number;
  readonly units: ReadonlyArray<{ readonly position: Vec3; readonly quaternion: Quat; readonly phase: number }>;
}

export interface DimensionLayout {
  readonly debris: readonly DebrisInstance[];
  readonly formations: readonly MicrobotFormation[];
  readonly rejected: Readonly<Record<string, number>>;
}

/** Candidate traversal exits, mirroring ExplorerState.traverse's search grid. */
const EXIT_OFFSETS = [0.8, 1.2, 1.6, 2], EXIT_LIFTS = [0, 0.4, 0.8, 1.3, 1.9, 2.7];
/** Clearance margins (m). */
export const CLEARANCE = { island: 1.5, fold: 7, exit: 2, opening: 5, sightline: 2.5, apertureView: 34, apertureCone: 0.33 } as const;

/** Reads only the public engine API; nothing is written back. */
export function placementInputs(engine: SimulationEngine, horizon = 240, step = 4): PlacementInputs {
  const times: number[] = [];
  for (let t = 0; t <= horizon; t += step) times.push(t);
  const islandPaths = engine.world.islands.map((island) => ({ samples: times.map((t) => engine.evaluateIsland(island, t)), clearance: island.radius + island.height }));
  const foldPoints: Vec3[] = [], exitPoints: Vec3[] = [];
  const sites = new Map<string, { p: Vector3; n: Vector3; k: number }>();
  for (const t of times) for (const c of engine.network.getConnections(t)) {
    if (!c.valid) continue;
    foldPoints.push(c.entryWorldPosition, c.exitWorldPosition);
    const s = sites.get(c.id) ?? { p: new Vector3(), n: new Vector3(), k: 0 };
    s.p.add(v(c.entryWorldPosition)); s.n.add(v(c.entryNormal)); s.k += 1; sites.set(c.id, s);
    for (const [dest, sign] of [[c.exitReferencePosition, 1], [c.entryReferencePosition, -1]] as const) {
      for (const o of EXIT_OFFSETS) for (const l of EXIT_LIFTS) {
        exitPoints.push(engine.network.map([dest[0] + c.axis[0] * o * sign, dest[1] + c.axis[1] * o * sign + l, dest[2] + c.axis[2] * o * sign], t));
      }
    }
  }
  const foldSites = [...sites.entries()].sort(([a], [b]) => a.localeCompare(b)).map(([id, s]) => ({ id, position: arr(s.p.divideScalar(s.k)), normal: arr(s.n.normalize()) }));
  const pose = engine.explorer.pose(0);
  const islandCentres = Object.fromEntries(engine.world.islands.map((i) => [i.id, engine.evaluateIsland(i, 0)]));
  // Hazard over the reference volume spanned by the islands (t = 0, fixed lattice).
  const refs = engine.world.islands.map((i) => i.referencePosition);
  const lo = [0, 1, 2].map((k) => Math.min(...refs.map((r) => r[k]!)) - 2), hi = [0, 1, 2].map((k) => Math.max(...refs.map((r) => r[k]!)) + 2);
  const hazard: Array<{ position: Vec3; hazard: number }> = [];
  const N = 11;
  for (let a = 0; a <= N; a += 1) for (let b = 0; b <= N; b += 1) for (let c = 0; c <= N; c += 1) {
    const s = engine.sampleField([lo[0]! + (hi[0]! - lo[0]!) * a / N, lo[1]! + (hi[1]! - lo[1]!) * b / N, lo[2]! + (hi[2]! - lo[2]!) * c / N], 0);
    if (Number.isFinite(s.hazard)) hazard.push({ position: s.worldPosition, hazard: s.hazard });
  }
  return { islandPaths, foldPoints, exitPoints, opening: pose.position, openingTarget: pose.target, islandCentres, foldSites, hazard };
}

const v = (a: Vec3) => new Vector3(a[0], a[1], a[2]);
const arr = (a: Vector3): Vec3 => [a.x, a.y, a.z];
const qArr = (q: Quaternion): Quat => [q.x, q.y, q.z, q.w];

function segmentDistance(p: Vector3, a: Vector3, b: Vector3): number {
  const ab = b.clone().sub(a), t = Math.max(0, Math.min(1, p.clone().sub(a).dot(ab) / ab.lengthSq()));
  return p.distanceTo(a.clone().addScaledVector(ab, t));
}

// ---------- clearance (spatially indexed; identical results to a brute-force scan) ----------
interface Keep { readonly x: number; readonly y: number; readonly z: number; readonly pad: number; readonly kind: 'island' | 'fold' | 'exit' }
interface Index { readonly cell: number; readonly grid: Map<string, Keep[]>; readonly maxPad: number }
const indices = new WeakMap<PlacementInputs, Index>();
function indexFor(inputs: PlacementInputs): Index {
  let index = indices.get(inputs);
  if (index) return index;
  const cell = 8, grid = new Map<string, Keep[]>();
  let maxPad = 0;
  const add = (p: Vec3, pad: number, kind: Keep['kind']) => {
    const key = `${Math.floor(p[0] / cell)},${Math.floor(p[1] / cell)},${Math.floor(p[2] / cell)}`;
    const list = grid.get(key) ?? [];
    list.push({ x: p[0], y: p[1], z: p[2], pad, kind }); grid.set(key, list);
    maxPad = Math.max(maxPad, pad);
  };
  for (const path of inputs.islandPaths) for (const s of path.samples) add(s, path.clearance + CLEARANCE.island, 'island');
  for (const f of inputs.foldPoints) add(f, CLEARANCE.fold, 'fold');
  for (const e of inputs.exitPoints) add(e, CLEARANCE.exit, 'exit');
  index = { cell, grid, maxPad };
  indices.set(inputs, index);
  return index;
}
const ORDER: Record<Keep['kind'], number> = { island: 0, fold: 1, exit: 2 };

/** Why a sphere (centre, radius) is not allowed here, or null. */
export function clearanceViolation(inputs: PlacementInputs, p: Vec3, radius: number, placed: ReadonlyArray<{ position: Vec3; radius: number }> = []): string | null {
  const index = indexFor(inputs), reach = radius + index.maxPad, c = index.cell;
  let worst: Keep['kind'] | null = null;
  for (let i = Math.floor((p[0] - reach) / c); i <= Math.floor((p[0] + reach) / c); i += 1)
    for (let j = Math.floor((p[1] - reach) / c); j <= Math.floor((p[1] + reach) / c); j += 1)
      for (let k = Math.floor((p[2] - reach) / c); k <= Math.floor((p[2] + reach) / c); k += 1) {
        for (const q of index.grid.get(`${i},${j},${k}`) ?? []) {
          if (worst && ORDER[q.kind] >= ORDER[worst]) continue;
          if ((p[0] - q.x) ** 2 + (p[1] - q.y) ** 2 + (p[2] - q.z) ** 2 < (radius + q.pad) ** 2) worst = q.kind;
        }
      }
  if (worst) return worst;
  const pv = v(p);
  // Keep every aperture readable: no piece inside a cone along its entry normal.
  for (const site of inputs.foldSites) {
    const d = pv.clone().sub(v(site.position)), along = Math.abs(d.dot(v(site.normal)));
    if (along > CLEARANCE.apertureView + radius) continue;
    const lateral = Math.sqrt(Math.max(0, d.lengthSq() - along * along));
    if (lateral < 2.5 + along * CLEARANCE.apertureCone + radius) return 'aperture';
  }
  if (pv.distanceTo(v(inputs.opening)) < radius + CLEARANCE.opening) return 'opening';
  if (segmentDistance(pv, v(inputs.opening), v(inputs.openingTarget)) < radius + CLEARANCE.sightline) return 'sightline';
  for (const q of placed) if ((p[0] - q.position[0]) ** 2 + (p[1] - q.position[1]) ** 2 + (p[2] - q.position[2]) ** 2 < ((radius + q.radius) * 0.8) ** 2) return 'overlap';
  return null;
}

/** Elongated pieces (beams, walkways, pipes, poles) must not line up with a pair of
 * nearby islands: wreckage never reads as a bridge or a connection between islands. */
export function bridgeLike(inputs: PlacementInputs, p: Vec3, longAxis: Vector3): boolean {
  const centres = Object.values(inputs.islandCentres).map(v), pv = v(p);
  for (let a = 0; a < centres.length; a += 1) for (let b = a + 1; b < centres.length; b += 1) {
    const A = centres[a]!, B = centres[b]!, length = A.distanceTo(B);
    if (length > 55) continue;
    if (segmentDistance(pv, A, B) > 10) continue;
    if (Math.abs(longAxis.dot(B.clone().sub(A).normalize())) > 0.72) return true;
  }
  return false;
}

/** Uniform random rotation (Shoemake). */
function randomQuat(r: () => number): Quaternion {
  const u1 = r(), u2 = r() * Math.PI * 2, u3 = r() * Math.PI * 2;
  const a = Math.sqrt(1 - u1), b = Math.sqrt(u1);
  return new Quaternion(a * Math.sin(u2), a * Math.cos(u2), b * Math.sin(u3), b * Math.cos(u3));
}
/** Rotation by a random axis with angle up to `max` radians. */
function jitterQuat(r: () => number, max: number): Quaternion {
  const axis = new Vector3(r() - 0.5, r() - 0.5, r() - 0.5).normalize();
  return new Quaternion().setFromAxisAngle(axis, (r() * 2 - 1) * max);
}

/** Nearest clear centre to an authored anchor: a fixed (seed-free) search over
 * Fibonacci directions on shells of growing radius, so zones keep their intent
 * but never intrude on a swept island path, a fold or the opening view. */
export function nearestClear(inputs: PlacementInputs, anchor: Vec3, radius: number, placed: ReadonlyArray<{ position: Vec3; radius: number }> = [], maxDistance = 36): Vec3 | null {
  if (!clearanceViolation(inputs, anchor, radius, placed)) return anchor;
  const golden = Math.PI * (3 - Math.sqrt(5)), a = v(anchor);
  for (let d = 1.5; d <= maxDistance; d += 1.5) {
    for (let i = 0; i < 32; i += 1) {
      const y = 1 - ((i + 0.5) / 32) * 2, rr = Math.sqrt(1 - y * y), th = i * golden;
      const p = arr(a.clone().add(new Vector3(Math.cos(th) * rr, y * 0.6, Math.sin(th) * rr).multiplyScalar(d)));
      if (!clearanceViolation(inputs, p, radius, placed)) return p;
    }
  }
  return null;
}

const ELONGATED = new Set(['steel', 'walkway', 'pipe', 'scaffold']);
/** Model-space axis of the largest dimension. */
function longAxisOf(size: readonly [number, number, number]): Vector3 {
  const k = size[0] >= size[1] && size[0] >= size[2] ? 0 : size[1] >= size[2] ? 1 : 2;
  return new Vector3(k === 0 ? 1 : 0, k === 1 ? 1 : 0, k === 2 ? 1 : 0);
}

interface Context {
  readonly inputs: PlacementInputs;
  readonly sizes: AssetSizes;
  readonly r: () => number;
  readonly out: DebrisInstance[];
  readonly rejected: Record<string, number>;
}
const reject = (ctx: Context, why: string) => { ctx.rejected[why] = (ctx.rejected[why] ?? 0) + 1; };

interface PieceOptions {
  readonly cluster: string; readonly region: string;
  /** Orientation: a fixed base with jitter up to `coherence` (π = fully tumbled). */
  readonly base?: Quaternion; readonly coherence: number;
  readonly drift: number;
  /** Samples a candidate position (called per attempt). */
  readonly at: () => Vector3;
  readonly attempts?: number;
}
/** Places one piece of `asset`; returns it, or null when no clear pose was found. */
function piece(ctx: Context, asset: string, o: PieceOptions): DebrisInstance | null {
  const size = ctx.sizes[asset];
  if (!size) throw new RangeError(`No measured size for ${asset}`);
  const spec = assetSpec(asset), [smin, smax] = spec.scaleVariation, r = ctx.r;
  for (let attempt = 0; attempt < (o.attempts ?? 20); attempt += 1) {
    const scale = smin + r() * (smax - smin);
    const radius = 0.5 * Math.hypot(size[0], size[1], size[2]) * scale;
    const position = arr(o.at());
    const why = clearanceViolation(ctx.inputs, position, radius, ctx.out);
    if (why) { reject(ctx, why); continue; }
    const q = o.coherence >= Math.PI || !o.base ? randomQuat(r) : o.base.clone().multiply(jitterQuat(r, o.coherence));
    if (ELONGATED.has(spec.category) && bridgeLike(ctx.inputs, position, longAxisOf(size).applyQuaternion(q))) { reject(ctx, 'bridge'); continue; }
    const tumbled = o.coherence >= 1.2;
    const d: DebrisInstance = {
      asset: spec.id, cluster: o.cluster, region: o.region, position, quaternion: qArr(q), scale, radius,
      drift: {
        amplitude: [(r() - 0.5) * o.drift, (r() - 0.5) * o.drift * 1.6, (r() - 0.5) * o.drift],
        period: 30 + r() * 44, phase: r() * Math.PI * 2,
        spinAxis: arr(new Vector3(r() - 0.5, r() - 0.5, r() - 0.5).normalize()), spinRate: (r() - 0.5) * 0.02 * (tumbled ? 2.2 : 1),
      },
    };
    ctx.out.push(d);
    return d;
  }
  return null;
}

/** Soft (≈ Gaussian) offset inside an ellipsoid of the given half extents. */
function soft(r: () => number, spread: Vec3, base?: Quaternion): Vector3 {
  const g = () => (r() + r() + r() - 1.5) / 1.5;
  const o = new Vector3(g() * spread[0], g() * spread[1], g() * spread[2]);
  return base ? o.applyQuaternion(base) : o;
}

interface ClusterSpec {
  readonly cluster: string; readonly region: string;
  readonly centre: Vec3; readonly spread: Vec3;
  readonly base: Quaternion; readonly coherence: number;
  readonly pieces: ReadonlyArray<readonly [string, number]>;
  readonly drift: number;
  /** Max distance the cluster centre may move to find clearance. */
  readonly resolve?: number;
}
/** A coherent wreckage cluster around a clear centre; returns the resolved centre. */
function cluster(ctx: Context, s: ClusterSpec): Vector3 | null {
  // A single-piece cluster (a landmark) resolves its own full radius; others a core.
  const single = s.pieces.length === 1 && s.pieces[0]![1] === 1;
  const size = single ? ctx.sizes[s.pieces[0]![0]] : undefined;
  const core = size ? 0.5 * Math.hypot(...size) * assetSpec(s.pieces[0]![0]).scaleVariation[1] + 0.3 : Math.min(3, 0.35 * Math.min(...s.spread)) + 0.5;
  const resolved = nearestClear(ctx.inputs, s.centre, core, ctx.out, s.resolve ?? 24);
  if (!resolved) { reject(ctx, 'zone'); return null; }
  const c = v(resolved);
  for (const [asset, count] of s.pieces) for (let k = 0; k < count; k += 1) {
    piece(ctx, asset, { cluster: s.cluster, region: s.region, base: s.base, coherence: s.coherence, drift: s.drift, at: () => c.clone().add(soft(ctx.r, s.spread, s.base)) });
  }
  return c;
}

/** Seeded smooth density in [0, 1] (value noise, ≈ 70 m features). */
function densityField(seed: number): (p: Vector3) => number {
  const r = createSeededRandom(seed ^ 0x51ced);
  const table = Array.from({ length: 512 }, () => r());
  const h = (x: number, y: number, z: number) => table[(((x * 73856093) ^ (y * 19349663) ^ (z * 83492791)) >>> 0) % 512]!;
  return (p) => {
    const s = 1 / 70, x = p.x * s, y = p.y * s * 1.6, z = p.z * s;
    const ix = Math.floor(x), iy = Math.floor(y), iz = Math.floor(z);
    const fx = x - ix, fy = y - iy, fz = z - iz;
    const u = fx * fx * (3 - 2 * fx), w = fy * fy * (3 - 2 * fy), t = fz * fz * (3 - 2 * fz);
    const lerp = (a: number, b: number, k: number) => a + (b - a) * k;
    return lerp(lerp(lerp(h(ix, iy, iz), h(ix + 1, iy, iz), u), lerp(h(ix, iy + 1, iz), h(ix + 1, iy + 1, iz), u), w),
      lerp(lerp(h(ix, iy, iz + 1), h(ix + 1, iy, iz + 1), u), lerp(h(ix, iy + 1, iz + 1), h(ix + 1, iy + 1, iz + 1), u), w), t);
  };
}

const FILLERS = ['concrete_chunk_a', 'concrete_chunk_b', 'concrete_chunk_c', 'concrete_rubble_cluster_a', 'concrete_rubble_cluster_b', 'industrial_scaffold_pole_bent', 'industrial_cable_bundle', 'industrial_pipe_elbow_torn', 'industrial_junction_box_broken', 'baymax_plating_shard'];
const MIDS = ['concrete_slab_plain', 'concrete_slab_rebar', 'industrial_ibeam_twisted', 'industrial_ibeam_bolted', 'industrial_column_bent', 'industrial_facility_panel', 'industrial_pipe_large_fractured', 'industrial_walkway_section'];
const pick = <T>(r: () => number, list: readonly T[]): T => list[Math.floor(r() * list.length) % list.length]!;
const tilt = (x: number, y: number, z: number) => new Quaternion().setFromEuler(new Euler(x, y, z));

/** The dimension layout. All anchors derive from world data. Independent of
 * quality: presets change LOD distances and microbot prefixes, never placement. */
export function layoutDimension(seed: number, inputs: PlacementInputs, sizes: AssetSizes): DimensionLayout {
  const r = createSeededRandom(seed ^ 0x0b5e55ed);
  const ctx: Context = { inputs, sizes, r, out: [], rejected: {} };
  const isl = (id: string) => v(inputs.islandCentres[id] ?? [0, 0, 0]);
  const ids = Object.keys(inputs.islandCentres).sort();
  const centres = ids.map(isl);
  const chamber = centres.reduce((s, c) => s.add(c), new Vector3()).divideScalar(Math.max(1, centres.length));
  const sweep = inputs.islandPaths.map((path) => {
    const c = path.samples.reduce((s, p) => s.add(v(p)), new Vector3()).divideScalar(path.samples.length);
    return { centre: c, reach: Math.max(...path.samples.map((p) => c.distanceTo(v(p)))) + path.clearance };
  });
  const radiusOf = (asset: string) => 0.5 * Math.hypot(...(sizes[asset] ?? [1, 1, 1]));

  // ---- A. Capsule crash site: THE landmark, mid-chamber left of the opening axis. ----
  // Sizes come from the measured bounds, so refined capsule GLBs drop in.
  const capsuleAnchor = isl('island-05').lerp(isl('island-11'), 0.5).add(new Vector3(-12, -3, 0));
  const shellRadius = radiusOf('capsule_shell_remnant');
  const shellAt = v(nearestClear(inputs, arr(capsuleAnchor), shellRadius + 1, ctx.out) ?? arr(capsuleAnchor));
  const shellBase = tilt(0.42, 0.7, -0.5);
  piece(ctx, 'capsule_shell_remnant', { cluster: 'landmark', region: 'capsule-site', base: shellBase, coherence: 0.02, drift: 0.12, at: () => shellAt.clone() });
  // Debris trail: the pod came in from the vortex side and shed parts as it tumbled.
  const trailDir = v(VORTEX).sub(shellAt).normalize().lerp(new Vector3(0.6, 0.15, 0.2), 0.45).normalize();
  const trailSide = new Vector3().crossVectors(trailDir, new Vector3(0, 1, 0)).normalize(), trailUp = new Vector3().crossVectors(trailSide, trailDir);
  const trailLength = 30 + shellRadius * 4;
  const trail: Array<readonly [string, number, number]> = [
    // [asset, count, position along the trail (0 = shell, 1 = first shed part)]
    ['capsule_heatshield_panel', 2, 0.92], ['capsule_rcs_thruster', 1, 0.8], ['capsule_collar_ring', 1, 0.62], ['capsule_upper_shell_fragment', 2, 0.46],
    ['capsule_rcs_thruster', 2, 0.36], ['capsule_antenna_broken', 1, 0.3], ['capsule_impact_fragment', 2, 0.2], ['capsule_instrument_unit', 2, 0.12],
  ];
  for (const [asset, count, along] of trail) for (let k = 0; k < count; k += 1) {
    let tries = 0;
    piece(ctx, asset, {
      cluster: 'capsule-trail', region: 'capsule-site', coherence: Math.PI, drift: 0.25, attempts: 60,
      at: () => {
        // The search widens along and across the trail if the first poses are blocked.
        tries += 1;
        const t = Math.min(1.1, Math.max(0.06, along + (r() - 0.5) * (0.12 + tries * 0.01))), lateral = 1.5 + t * 6 + tries * 0.15;
        return shellAt.clone().addScaledVector(trailDir, shellRadius + 1 + t * trailLength).addScaledVector(trailSide, (r() * 2 - 1) * lateral).addScaledVector(trailUp, (r() * 2 - 1) * lateral * 0.6);
      },
    });
  }
  // Baymax armour scattered just off the wreck (he came for its pilot).
  cluster(ctx, { cluster: 'capsule-baymax', region: 'capsule-site', centre: arr(shellAt.clone().addScaledVector(trailSide, -(shellRadius + 6)).addScaledVector(trailUp, -2)), spread: [4, 2.5, 4], base: new Quaternion(), coherence: Math.PI, drift: 0.2, resolve: 10,
    pieces: [['baymax_chest_armor', 1], ['baymax_shoulder_shell', 1], ['baymax_forearm_shell', 1], ['baymax_joint_shell', 1], ['baymax_plating_shard', 2]] });

  // ---- B. Concrete wall breach: a building fragment far left (between islands 09 and 12). ----
  const breachAnchor = isl('island-09').lerp(isl('island-12'), 0.55).add(new Vector3(4, 9, 4));
  const breachBase = tilt(0.25, 1.1, 0.35);
  const breachAt = cluster(ctx, { cluster: 'breach-wall', region: 'breach-site', centre: arr(breachAnchor), spread: [1, 1, 1], base: breachBase, coherence: 0.04, drift: 0.12, pieces: [['concrete_wall_breach', 1]] }) ?? breachAnchor;
  cluster(ctx, { cluster: 'breach-slabs', region: 'breach-site', centre: arr(breachAt), spread: [9, 5, 8], base: breachBase, coherence: 0.7, drift: 0.25,
    pieces: [['concrete_slab_rebar', 3], ['concrete_slab_plain', 2], ['concrete_chunk_a', 3], ['concrete_chunk_b', 3], ['concrete_chunk_c', 3], ['industrial_scaffold_pole_bent', 2], ['industrial_cable_bundle', 1]] });
  cluster(ctx, { cluster: 'breach-rubble', region: 'breach-site', centre: arr(breachAt.clone().add(new Vector3(3, -4, 2))), spread: [6, 3, 6], base: new Quaternion(), coherence: Math.PI, drift: 0.3,
    pieces: [['concrete_rubble_cluster_a', 3], ['concrete_rubble_cluster_b', 3], ['concrete_chunk_a', 2]] });

  // ---- C. Torn industrial structure: far right (between islands 10 and 13). ----
  const structureAnchor = isl('island-10').lerp(isl('island-13'), 0.5).add(new Vector3(6, 6, 2));
  const structure = tilt(0.35, -0.6, 0.8);
  const structureAt = cluster(ctx, { cluster: 'industrial-structure', region: 'industrial-site', centre: arr(structureAnchor), spread: [8, 5, 6], base: structure, coherence: 0.35, drift: 0.2,
    pieces: [['industrial_steel_girder_premium', 2], ['industrial_ibeam_bolted', 2], ['industrial_column_bent', 2], ['industrial_scaffold_section', 2], ['industrial_walkway_torn', 1], ['industrial_walkway_section', 2]] }) ?? structureAnchor;
  cluster(ctx, { cluster: 'industrial-services', region: 'industrial-site', centre: arr(structureAt.clone().add(new Vector3(-6, -3, 5))), spread: [7, 4, 6], base: tilt(-0.4, 1.3, 0.3), coherence: 0.7, drift: 0.25,
    pieces: [['industrial_pipe_large_fractured', 2], ['industrial_pipe_elbow_torn', 2], ['industrial_cable_bundle', 2], ['industrial_facility_panel', 2], ['industrial_junction_box_broken', 2], ['industrial_ibeam_twisted', 1]] });

  // ---- D. Funnel breach: a second (and last) wall breach as a silhouette toward the vortex. ----
  const funnelAnchor = v(cavernPoint(0.76)).add(new Vector3(-20, 6, 4));
  const funnelBase = tilt(-0.3, 0.4, 1.0);
  const funnelAt = cluster(ctx, { cluster: 'funnel-breach', region: 'funnel-site', centre: arr(funnelAnchor), spread: [1, 1, 1], base: funnelBase, coherence: 0.05, drift: 0.15, pieces: [['concrete_wall_breach', 1]] }) ?? funnelAnchor;
  cluster(ctx, { cluster: 'funnel-wreck', region: 'funnel-site', centre: arr(funnelAt), spread: [10, 6, 10], base: funnelBase, coherence: 1.0, drift: 0.35,
    pieces: [['concrete_slab_rebar', 2], ['industrial_ibeam_twisted', 2], ['industrial_steel_girder_premium', 1], ['industrial_walkway_torn', 1], ['concrete_chunk_b', 2], ['concrete_rubble_cluster_a', 2]] });

  // ---- E. Baymax remnants high at the back of the chamber (near island 14). ----
  const baymaxAnchor = isl('island-14').add(new Vector3(-14, 9, 8));
  const baymaxAt = cluster(ctx, { cluster: 'baymax-remnants', region: 'baymax-site', centre: arr(baymaxAnchor), spread: [4, 2.5, 4], base: new Quaternion(), coherence: Math.PI, drift: 0.2,
    pieces: [['baymax_chest_armor', 1], ['baymax_shoulder_shell', 1], ['baymax_forearm_shell', 2], ['baymax_joint_shell', 2], ['baymax_plating_shard', 3], ['industrial_cable_bundle', 1]] }) ?? baymaxAnchor;

  // ---- F. Low sediment: heavy slabs settled far below the islands (depth when looking down). ----
  const sedimentAnchor = new Vector3(chamber.x - 6, Math.min(...centres.map((c) => c.y)) - 9, chamber.z + 4);
  cluster(ctx, { cluster: 'low-sediment', region: 'low-sediment', centre: arr(sedimentAnchor), spread: [32, 3, 30], base: tilt(0.08, 0.4, 0.05), coherence: 0.45, drift: 0.12,
    pieces: [['concrete_slab_plain', 4], ['concrete_slab_rebar', 3], ['concrete_chunk_c', 4], ['concrete_rubble_cluster_b', 3], ['industrial_walkway_section', 1], ['industrial_facility_panel', 2]] });

  // ---- G. Hazard accumulation zones: the highest sampled hazard, ≥ 40 m apart and from sites. ----
  const occupied = [shellAt, breachAt, structureAt, funnelAt, baymaxAt, v(inputs.opening)];
  const hazardZones: Vector3[] = [];
  for (const h of [...inputs.hazard].sort((a, b) => b.hazard - a.hazard || a.position[0] - b.position[0])) {
    if (hazardZones.length >= 3 || h.hazard < 0.35) break;
    const p = v(h.position);
    if ([...occupied, ...hazardZones].some((o) => o.distanceTo(p) < 40)) continue;
    if (clearanceViolation(inputs, h.position, 4)) continue;
    hazardZones.push(p);
  }
  hazardZones.forEach((p, i) => cluster(ctx, { cluster: `hazard-${i}`, region: 'hazard', centre: arr(p), spread: [4.5, 3.5, 4.5], base: new Quaternion(), coherence: Math.PI, drift: 0.38, resolve: 8,
    pieces: [['concrete_chunk_a', 2], ['concrete_chunk_b', 2], ['concrete_chunk_c', 2], ['concrete_rubble_cluster_a', 2], ['concrete_rubble_cluster_b', 2], ['industrial_scaffold_pole_bent', 1], ['industrial_cable_bundle', 1], ['baymax_plating_shard', i === 0 ? 1 : 0]] }));

  // ---- H. Island ecosystems: debris shed by each island, just outside its swept path. ----
  // Characters vary per island so density varies: rubble halo, service wreckage, or quiet.
  ids.forEach((id, i) => {
    const s = sweep[i]!;
    const character = (i * 7 + seed) % 5; // 0,1 rubble · 2,3 services · 4 quiet
    const count = character === 4 ? 2 : 4 + Math.floor(r() * 4);
    for (let k = 0; k < count; k += 1) {
      const asset = character <= 1 ? pick(r, ['concrete_chunk_a', 'concrete_chunk_b', 'concrete_chunk_c', 'concrete_rubble_cluster_a', 'concrete_rubble_cluster_b', 'concrete_slab_plain'])
        : character <= 3 ? pick(r, ['industrial_cable_bundle', 'industrial_junction_box_broken', 'industrial_pipe_elbow_torn', 'industrial_facility_panel', 'concrete_chunk_a', 'industrial_scaffold_pole_bent'])
          : pick(r, ['concrete_chunk_c', 'concrete_rubble_cluster_a']);
      piece(ctx, asset, {
        cluster: id, region: 'island', coherence: Math.PI, drift: 0.3, attempts: 24,
        at: () => {
          // Below and beside more often than above: matter falling away from the rock.
          const dir = new Vector3(r() * 2 - 1, r() * 1.4 - 0.9, r() * 2 - 1).normalize();
          return s.centre.clone().addScaledVector(dir, s.reach + radiusOf(asset) + CLEARANCE.island + 1 + r() * 7);
        },
      });
    }
  });

  // ---- I. Fold-seam framing: a loose arc of wreckage caught beside each real connection site. ----
  inputs.foldSites.forEach((site, i) => {
    const c = v(site.position), n = v(site.normal);
    const side = new Vector3().crossVectors(n, Math.abs(n.y) > 0.9 ? new Vector3(1, 0, 0) : new Vector3(0, 1, 0)).normalize();
    const up = new Vector3().crossVectors(side, n);
    const count = 2 + (i % 2);
    for (let k = 0; k < count; k += 1) {
      const asset = pick(r, ['concrete_slab_plain', 'industrial_facility_panel', 'concrete_chunk_b', 'industrial_ibeam_bolted', 'concrete_slab_rebar', 'industrial_cable_bundle']);
      // Tangential to a ring around the aperture axis (framing, not pointing at it).
      const angle = (k / count) * Math.PI * 2 + i * 1.3;
      const radial = side.clone().multiplyScalar(Math.cos(angle)).addScaledVector(up, Math.sin(angle));
      const base = new Quaternion().setFromUnitVectors(new Vector3(1, 0, 0), new Vector3().crossVectors(n, radial).normalize());
      piece(ctx, asset, { cluster: 'fold-seam', region: 'fold-seam', base, coherence: 0.5, drift: 0.2, attempts: 24,
        at: () => c.clone().addScaledVector(radial, CLEARANCE.fold + radiusOf(asset) + 3 + r() * 6).addScaledVector(n, (r() - 0.5) * 4) });
    }
  });

  // ---- J. High drift: light pieces scattered above the islands. ----
  const top = Math.max(...centres.map((c) => c.y));
  for (let k = 0; k < 14; k += 1) {
    const asset = pick(r, ['industrial_facility_panel', 'baymax_plating_shard', 'industrial_cable_bundle', 'concrete_chunk_c', 'industrial_scaffold_pole_bent', 'concrete_slab_plain']);
    piece(ctx, asset, { cluster: 'high-drift', region: 'high-drift', coherence: Math.PI, drift: 0.35, attempts: 12,
      at: () => new Vector3(chamber.x + (r() * 2 - 1) * 70, top + 10 + r() * 22, chamber.z + (r() * 2 - 1) * 70) });
  }

  // ---- K. Vortex inflow: large pieces spiralling toward the core. ----
  const vortex = v(VORTEX), fieldCentre = new Vector3(0, 2, -55), vAxis = vortex.clone().sub(fieldCentre).normalize();
  const vSide = new Vector3().crossVectors(vAxis, new Vector3(0, 1, 0)).normalize(), vUp = new Vector3().crossVectors(vSide, vAxis);
  const inflow = ['industrial_ibeam_twisted', 'concrete_slab_rebar', 'industrial_facility_panel', 'industrial_pipe_large_fractured', 'industrial_walkway_torn', 'concrete_slab_plain', 'industrial_column_bent', 'industrial_steel_girder_premium'];
  for (let i = 0; i < 26; i += 1) {
    const t = 0.3 + (i / 25) * 0.58, ang = i * 1.9, rad = 14 + t * 36;
    const c = fieldCentre.clone().lerp(vortex, t).addScaledVector(vSide, Math.cos(ang) * rad).addScaledVector(vUp, Math.sin(ang) * rad);
    // Pieces align with the spiral tangent: pulled along the flow.
    const tangent = new Vector3().crossVectors(vAxis, c.clone().sub(fieldCentre.clone().lerp(vortex, t))).normalize().addScaledVector(vAxis, 0.6).normalize();
    const asset = inflow[i % inflow.length]!;
    piece(ctx, asset, { cluster: `vortex-${i}`, region: 'vortex-inflow', base: new Quaternion().setFromUnitVectors(longAxisOf(sizes[asset] ?? [1, 1, 1]), tangent), coherence: 0.3, drift: 0.5, attempts: 10,
      at: () => c.clone().add(soft(r, [2, 2, 2])) });
  }

  // ---- K2. Mid-distance anchors from the opening view: large true-scale wreckage reads as scale. ----
  {
    const o = v(inputs.opening), f = v(inputs.openingTarget).sub(o).normalize();
    const side = new Vector3().crossVectors(f, new Vector3(0, 1, 0)).normalize();
    const at = (d: number, x: number, y: number) => arr(o.clone().addScaledVector(f, d).addScaledVector(side, x).add(new Vector3(0, y, 0)));
    cluster(ctx, { cluster: 'opening-anchors-left', region: 'opening-anchors', centre: at(38, -16, 3), spread: [5, 3, 5], base: tilt(0.6, 0.3, 0.9), coherence: 0.6, drift: 0.2, resolve: 14,
      pieces: [['concrete_slab_rebar', 2], ['industrial_steel_girder_premium', 1]] });
    cluster(ctx, { cluster: 'opening-anchors-right', region: 'opening-anchors', centre: at(55, 18, -4), spread: [5, 3, 5], base: tilt(-0.4, 1.1, 0.5), coherence: 0.6, drift: 0.2, resolve: 14,
      pieces: [['industrial_walkway_torn', 1], ['concrete_slab_rebar', 1], ['industrial_steel_girder_premium', 1]] });
  }

  // ---- L. Ambient scatter through the cavern: seeded density, quiet areas kept quiet. ----
  const density = densityField(seed);
  const sites = [shellAt, breachAt, structureAt, funnelAt, baymaxAt, ...hazardZones];
  const ambientTarget = 170;
  let placedAmbient = 0;
  const regionCap: Record<string, number> = { entrance: 18, funnel: 48, ambient: 110 }, regionCount: Record<string, number> = {};
  for (let attempt = 0; attempt < 7000 && placedAmbient < ambientTarget; attempt += 1) {
    // Region weights along the cavern: chamber 62 %, vortex funnel 24 %, entrance 14 %.
    const band = r(), u = band < 0.62 ? 0.31 + r() * 0.36 : band < 0.86 ? 0.67 + r() * 0.21 : 0.08 + r() * 0.22;
    const rad = cavernRadius(u), th = r() * Math.PI * 2, rho = Math.pow(r(), 0.6) * 0.62;
    const vertical = Math.sin(th) >= 0 ? rad.up : Math.min(rad.down, 60);
    const centre = v(cavernPoint(u));
    const horizontal = Math.min(rad.horizontal, 110);
    const p = centre.add(new Vector3(Math.cos(th) * horizontal * rho, Math.sin(th) * vertical * rho * 0.75, (r() - 0.5) * 16));
    const d = density(p);
    // Three bands: quiet (< 0.32, rarely populated), medium, dense.
    const keep = d < 0.32 ? 0.08 : d < 0.62 ? 0.45 : 0.9;
    if (r() > keep) continue;
    if (sites.some((s) => s.distanceTo(p) < 16)) continue;
    // Spacing grows in quiet areas: no uniform noise.
    const spacing = 7 + (1 - d) * 9;
    if (ctx.out.some((q) => q.region === 'ambient' && (q.position[0] - p.x) ** 2 + (q.position[1] - p.y) ** 2 + (q.position[2] - p.z) ** 2 < spacing * spacing)) continue;
    const asset = r() < 0.72 ? pick(r, FILLERS) : pick(r, MIDS);
    const region = u < 0.3 ? 'entrance' : u > 0.66 ? 'funnel' : 'ambient';
    if ((regionCount[region] ?? 0) >= regionCap[region]!) continue;
    const placedPiece = piece(ctx, asset, { cluster: `ambient-${region}`, region: region === 'ambient' ? 'ambient' : region, coherence: Math.PI, drift: 0.32, attempts: 1, at: () => p.clone() });
    if (placedPiece) { placedAmbient += 1; regionCount[region] = (regionCount[region] ?? 0) + 1; }
  }

  // ---- Microbot formations (true 38.8 mm units; large forms come from numbers). ----
  const formations: MicrobotFormation[] = [];
  const open = v(inputs.opening), target = v(inputs.openingTarget);
  const fwd = target.clone().sub(open).normalize();
  const right = new Vector3().crossVectors(fwd, new Vector3(0, 1, 0)).normalize(), up = new Vector3().crossVectors(right, fwd);
  const fromOpening = (f: number, x: number, y: number): Vec3 => arr(open.clone().addScaledVector(fwd, f).addScaledVector(right, x).addScaledVector(up, y));
  const debris = ctx.out;
  /** Resolves a clear centre near the anchor, then builds the formation there. */
  const tryFormation = (anchor: Vec3, radius: number, build: (centre: Vector3) => MicrobotFormation, maxDistance = 12) => {
    const c = nearestClear(inputs, anchor, radius, debris, maxDistance);
    if (!c) { reject(ctx, 'formation'); return; }
    formations.push(build(v(c)));
  };
  // Foreground discovery swarm: close enough to read as many small devices.
  tryFormation(fromOpening(7.5, -3.6, -1.2), 1.1, (c) => formation('swarm', 'opening-swarm', arr(c), 1.1, 650, [0.2, 1, 0.1], 0.06, r), 3);
  // Capsule landmark: a chain wrapping past the shell and a connected cluster.
  const tendril = [[-3, -1.5, 1], [-1.2, 0.6, 2], [1, 1.4, 0.5], [2.6, 0.2, -1.5], [3.4, -1.6, -2.4]].map(([x, y, z]) => new Vector3(x, y, z).multiplyScalar(1 + shellRadius * 0.25));
  tryFormation(arr(shellAt.clone().add(new Vector3(0, shellRadius + 1.2, 0))), 3.2 + shellRadius * 0.6, (c) => formation('chain', 'landmark-tendril', arr(c), 3.2 + shellRadius * 0.6, 240, [0, 1, 0], 0.012, r, tendril.map((o) => arr(c.clone().add(o)))), 6);
  tryFormation(arr(shellAt.clone().addScaledVector(trailSide, shellRadius + 2.4).add(new Vector3(0, -1.2, 0))), 0.28, (c) => formation('cluster', 'landmark-cluster', arr(c), 0.28, 240, [0.3, 1, 0], 0.03, r), 5);
  // Fold corridor: tendrils streaming alongside the primary passage (kept clear of endpoints).
  const corridor = arr(target.clone().addScaledVector(fwd, -18).addScaledVector(right, 9).addScaledVector(up, -1));
  for (let k = 0; k < 3; k += 1) {
    const anchor = v(corridor).add(new Vector3(k * 2.2, k * 1.4 - 1, -k * 3));
    tryFormation(arr(anchor), 4.5, (c) => formation('chain', `corridor-tendril-${k}`, arr(c), 4.5, 200, arr(fwd), 0.01, r,
      Array.from({ length: 6 }, (_, i) => arr(c.clone().addScaledVector(fwd, i * 1.6 - 4).addScaledVector(up, Math.sin(i * 0.9 + k) * 0.8).addScaledVector(right, Math.cos(i * 0.7 + k * 2) * 0.7)))), 24);
  }
  // Hazard: an inactive, partly compacted clump in the strongest accumulation zone.
  const hz = hazardZones[0] ?? isl('island-07').add(new Vector3(11, 4, 6));
  tryFormation(arr(hz.clone().add(new Vector3(-3, 2, 2))), 0.35, (c) => formation('inactive', 'hazard-inactive', arr(c), 0.35, 220, [1, 0.3, 0], 0.006, r), 8);
  // Island-adjacent swarms in calmer regions, spread over the chamber.
  tryFormation(arr(isl('island-05').add(new Vector3(-9, 3, 6))), 2.2, (c) => formation('swarm', 'island-swarm-a', arr(c), 2.2, 500, [0, 1, 0.2], 0.04, r));
  tryFormation(arr(isl('island-09').add(new Vector3(8, 4, 5))), 2.6, (c) => formation('swarm', 'island-swarm-b', arr(c), 2.6, 450, [0.2, 1, -0.1], 0.035, r));
  tryFormation(arr(isl('island-13').add(new Vector3(-6, 8, 8))), 2.4, (c) => formation('swarm', 'island-swarm-c', arr(c), 2.4, 420, [0.1, 1, 0.3], 0.038, r), 16);
  // Breach site: a chain threading past the wall; industrial site: a working cluster.
  tryFormation(arr(breachAt.clone().add(new Vector3(0, 4, 0))), 3.5, (c) => formation('chain', 'breach-tendril', arr(c), 3.5, 220, [0, 1, 0], 0.01, r,
    Array.from({ length: 6 }, (_, i) => arr(c.clone().add(new Vector3(i * 1.3 - 3.2, Math.sin(i * 1.1) * 1.2, Math.cos(i * 0.8) * 1.4))))), 10);
  tryFormation(arr(structureAt.clone().add(new Vector3(2, 5, -3))), 0.3, (c) => formation('cluster', 'industrial-cluster', arr(c), 0.3, 260, [0.2, 1, 0.1], 0.025, r), 10);
  // Vortex: a large loose swarm caught in the inflow.
  const vs = fieldCentre.clone().lerp(vortex, 0.42).addScaledVector(vSide, 22);
  tryFormation(arr(vs), 6, (c) => formation('swarm', 'vortex-swarm', arr(c), 6, 900, arr(vAxis), 0.05, r));

  return { debris, formations, rejected: ctx.rejected };
}

/** Composition anchors after resolution, from a computed layout (views, tests, evidence). */
export function layoutSites(layout: DimensionLayout): Record<string, Vec3> {
  const out: Record<string, Vec3> = {};
  const groups = new Map<string, Vector3[]>();
  for (const d of layout.debris) groups.set(d.region, [...(groups.get(d.region) ?? []), v(d.position)]);
  for (const [region, points] of groups) out[region] = arr(points.reduce((s, p) => s.add(p), new Vector3()).divideScalar(points.length));
  const shell = layout.debris.find((d) => d.cluster === 'landmark');
  if (shell) out.landmark = shell.position;
  return out;
}

const MICROBOT_SPACING = 0.042; // centre-to-centre along a chain (unit length 38.8 mm)

function formation(kind: FormationKind, id: string, centre: Vec3, radius: number, count: number, axis: Vec3, omega: number, r: () => number, path?: Vec3[]): MicrobotFormation {
  const units: Array<{ position: Vec3; quaternion: Quat; phase: number }> = [];
  const c = v(centre), ax = v(axis).normalize();
  const X = new Vector3(1, 0, 0);
  if (kind === 'chain' && path) {
    // Points spaced along a Catmull–Rom-like polyline with parallel-transport
    // frames: each unit's arm axis follows the tangent; roll changes slowly.
    const pts = path.map(v), seg: Vector3[] = [];
    for (let i = 0; i < pts.length - 1; i += 1) for (let s = 0; s < 24; s += 1) {
      const p0 = pts[Math.max(0, i - 1)]!, p1 = pts[i]!, p2 = pts[i + 1]!, p3 = pts[Math.min(pts.length - 1, i + 2)]!, t = s / 24;
      const t2 = t * t, t3 = t2 * t;
      seg.push(new Vector3().addScaledVector(p0, -0.5 * t3 + t2 - 0.5 * t).addScaledVector(p1, 1.5 * t3 - 2.5 * t2 + 1).addScaledVector(p2, -1.5 * t3 + 2 * t2 + 0.5 * t).addScaledVector(p3, 0.5 * t3 - 0.5 * t2));
    }
    seg.push(pts[pts.length - 1]!.clone());
    let along = 0;
    let prevQ: Quaternion | null = null;
    for (let i = 1; i < seg.length && units.length < count; i += 1) {
      const a = seg[i - 1]!, b = seg[i]!, d = a.distanceTo(b);
      while (along <= d && units.length < count) {
        const p = a.clone().lerp(b, along / d), tan = b.clone().sub(a).normalize();
        // Minimal rotation from the previous unit's frame (no flips or twisting).
        const q: Quaternion = prevQ ? new Quaternion().setFromUnitVectors(X.clone().applyQuaternion(prevQ), tan).multiply(prevQ) : new Quaternion().setFromUnitVectors(X, tan);
        prevQ = q.clone();
        const roll = new Quaternion().setFromAxisAngle(X, units.length * 0.11 + (r() - 0.5) * 0.2);
        units.push({ position: arr(p), quaternion: qArr(q.clone().multiply(roll)), phase: units.length * 0.07 });
        along += MICROBOT_SPACING;
      }
      along -= d;
    }
  } else {
    for (let i = 0; i < count; i += 1) {
      let p: Vector3, dir: Vector3;
      if (kind === 'cluster') {
        // Nested shells; units point radially out of the mass (connected assembly).
        dir = new Vector3(r() * 2 - 1, r() * 2 - 1, r() * 2 - 1).normalize();
        p = c.clone().addScaledVector(dir, radius * (0.35 + 0.65 * Math.sqrt(r())));
      } else if (kind === 'inactive') {
        dir = new Vector3(1, 0, 0); // orientation is fully random below
        p = c.clone().add(new Vector3(r() * 2 - 1, (r() * 2 - 1) * 0.45, r() * 2 - 1).multiplyScalar(radius * Math.cbrt(r())));
      } else {
        // Loose swarm: ellipsoid volume; units align with the swirl flow (tangent about the axis).
        p = c.clone().add(new Vector3((r() * 2 - 1), (r() * 2 - 1) * 0.55, (r() * 2 - 1)).multiplyScalar(radius * Math.cbrt(r())));
        const rel = p.clone().sub(c), tangent = new Vector3().crossVectors(ax, rel);
        dir = tangent.lengthSq() > 1e-9 ? tangent.normalize() : new Vector3(1, 0, 0);
      }
      const jitter = kind === 'swarm' ? 0.35 : kind === 'cluster' ? 0.25 : Math.PI;
      const q = new Quaternion().setFromUnitVectors(X, dir).multiply(new Quaternion().setFromAxisAngle(X, r() * Math.PI * 2));
      units.push({ position: arr(p), quaternion: qArr(jitter >= Math.PI ? randomQuat(r) : jitterQuat(r, jitter).multiply(q)), phase: r() * Math.PI * 2 });
    }
  }
  return { id, kind, centre, radius, axis: arr(ax), omega, units };
}
