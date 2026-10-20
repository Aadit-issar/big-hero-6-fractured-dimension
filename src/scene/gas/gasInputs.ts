import type { SimulationEngine } from '../../simulation/simulationEngine';
import type { Vec3 } from '../../simulation/types';
import { cross, multiply, normalize, scale, sub } from '../../simulation/linearAlgebra';
import { MAX_FOLDS, MAX_HAZARDS, MAX_SHEARS } from './GasVolumePass';
import { disturbanceIntensity, moversFor, sheetSlip, swirlAxis } from '../../world/movers';
import type { DisturbanceDef } from '../../world/movers';

/** How strongly a connection state opens the surrounding gas (rendering only). */
export const FOLD_OPENING: Readonly<Record<string, number>> = { open: 1, unstable: 0.85, forming: 0.45, closing: 0.35, inactive: 0, closed: 0 };

export type Vec4 = readonly [number, number, number, number];

/** One spatial shear: [centre, weight], [displacement, radius], [plane normal, seam]. */
export type Shear = readonly [Vec4, Vec4, Vec4];
/** Radius (m) of the region around an endpoint whose gas echoes the far side.
 * Open folds sit in the near-empty central cavity, so the shear must reach the
 * cloud walls 70–110 m out to be seen at all. */
export const FOLD_SHEAR_RADIUS = 120;
/** Legibility gain on the real offsets. A fold's exit − entry is ≈ 1.6 m while gas
 * features are ≈ 100 m across, so the true offset would not visibly move the
 * cloud. Direction, relative magnitude and on/off state stay real; only the
 * magnitude is magnified (a rendering choice, documented in the report). */
export const FOLD_SHEAR_GAIN = 24;
/** Strain shear offset (m) at σ_min = 0, falling linearly to 0 at σ_min = 1. */
export const STRAIN_SHEAR_SCALE = 40;
export const STRAIN_SHEAR_RADIUS = 45;
/** Gas response to the movers' disturbances (src/world/movers.ts): at most this many shears are reserved for them. */
export const DISTURBANCE_SHEARS = 2;
/** Shear offset (m) at full intensity: a fracture sheet slips the cloud along its own slip direction; a swirl shears the layer normal to its axis. */
export const DISTURBANCE_SHEAR_OFFSET = 14;
/** Shear radius per unit of the disturbance's width (m per reference-unit sigma). */
export const DISTURBANCE_SHEAR_RADIUS_PER_SIGMA = 52;

const MAT_VEC = (m: readonly number[], v: Vec3): Vec3 => [m[0]! * v[0] + m[1]! * v[1] + m[2]! * v[2], m[3]! * v[0] + m[4]! * v[1] + m[5]! * v[2], m[6]! * v[0] + m[7]! * v[1] + m[8]! * v[2]];

/** Gas shear of one disturbance, from its real state: the reference-space slip/tangent direction and plane are pushed through the local Jacobian
 * of the same spatial map, so the cloud is cut and slipped exactly where and along what the objects feel. Wells have no shear (they act radially). */
function disturbanceShear(engine: SimulationEngine, d: DisturbanceDef, intensity: number, lattice: number): Shear | null {
  const kind = d.kind ?? 'swirl';
  if (kind === 'well' || intensity < 0.05) return null;
  const sample = engine.sampleField(d.centre, lattice);
  let tangent: Vec3, normalRef: Vec3;
  if (kind === 'sheet') { tangent = sheetSlip(d); normalRef = normalize(d.axis); }
  else { normalRef = swirlAxis(d, lattice); const helper: Vec3 = Math.abs(normalRef[1]) < 0.9 ? [0, 1, 0] : [1, 0, 0]; tangent = normalize(cross(normalRef, helper)); }
  const binormal = normalize(cross(normalRef, tangent));
  const jt = MAT_VEC(sample.jacobian, tangent), jb = MAT_VEC(sample.jacobian, binormal), jn = MAT_VEC(sample.jacobian, normalRef);
  let n = normalize(cross(jt, jb));
  if (n[0] * jn[0] + n[1] * jn[1] + n[2] * jn[2] < 0) n = scale(n, -1);
  const offset = scale(normalize(jt), DISTURBANCE_SHEAR_OFFSET * intensity);
  return [[...sample.worldPosition, 0.85 * intensity], [...offset, d.sigma * DISTURBANCE_SHEAR_RADIUS_PER_SIGMA], [...n, kind === 'sheet' ? 1 : 0]];
}

/** Simulation-derived shaping inputs for the gas, sampled on the 4 Hz model
 * lattice: fold endpoints (only real graph connections open passages), the
 * same hazard sample points the hazard shells use, and spatial shears. Fold
 * shears exist only for valid connections and displace along exit − entry; strain
 * shears use each hazard sample's compression axis and singular value. Read-only. */
export function gasSimulationInputs(engine: SimulationEngine, time: number, camera: Vec3): { readonly folds: Vec4[]; readonly hazards: Vec4[]; readonly shears: Shear[] } {
  const lattice = Math.floor(time * 4) / 4;
  const endpoints: Array<{ p: Vec3; w: number }> = [];
  const pairs: Array<{ entry: Vec3; exit: Vec3; entryNormal: Vec3; exitNormal: Vec3; w: number; d: number }> = [];
  for (const c of engine.network.getConnections(lattice)) {
    const w = c.valid ? FOLD_OPENING[c.state] ?? 0 : 0;
    if (w <= 0) continue;
    endpoints.push({ p: c.entryWorldPosition, w }, { p: c.exitWorldPosition, w });
    pairs.push({ entry: c.entryWorldPosition, exit: c.exitWorldPosition, entryNormal: c.entryNormal, exitNormal: c.exitNormal, w, d: Math.min(dist2(c.entryWorldPosition, camera), dist2(c.exitWorldPosition, camera)) });
  }
  pairs.sort((a, b) => a.d - b.d);
  const shears: Shear[] = [];
  const foldShears: Shear[] = [];
  for (const f of pairs.slice(0, 2)) {
    foldShears.push([[...f.entry, f.w], [...scale(sub(f.exit, f.entry), FOLD_SHEAR_GAIN), FOLD_SHEAR_RADIUS], [...f.entryNormal, 1]]);
    foldShears.push([[...f.exit, f.w], [...scale(sub(f.entry, f.exit), FOLD_SHEAR_GAIN), FOLD_SHEAR_RADIUS], [...f.exitNormal, 1]]);
  }
  // Disturbance shears (real mover-system state, nearest the camera first) take precedence over the second fold pair and the strain shears.
  const dist: Array<{ shear: Shear; d: number }> = [];
  for (const shear of disturbanceShearsAt(engine, lattice)) { const d = Math.sqrt(dist2([shear[0][0], shear[0][1], shear[0][2]], camera)); if (d < 170) dist.push({ shear, d }); }
  dist.sort((a, b) => a.d - b.d);
  shears.push(...foldShears.slice(0, 2));
  for (const e of dist.slice(0, DISTURBANCE_SHEARS)) shears.push(e.shear);
  shears.push(...foldShears.slice(2));
  endpoints.sort((a, b) => dist2(a.p, camera) - dist2(b.p, camera));
  const folds: Vec4[] = endpoints.slice(0, MAX_FOLDS).map((e) => [e.p[0], e.p[1], e.p[2], e.w]);
  const strained: Array<{ shear: Shear; hazard: number }> = [];
  const hazards: Vec4[] = [1, 2, 4, 6].slice(0, MAX_HAZARDS).map((index) => {
    const ref = engine.world.islands[index]!.referencePosition;
    const sample = engine.sampleField([ref[0], ref[1] + 1.1, ref[2]], lattice);
    // Strain shear: the plane faces the mapped compression axis; the offset grows
    // as the smallest singular value falls (space squeezed along that axis).
    const n = normalize(multiply(sample.jacobian, sample.compressionAxis));
    const tangent = normalize(cross(n, Math.abs(n[1]) > 0.9 ? [1, 0, 0] : [0, 1, 0]));
    const offset = scale(tangent, STRAIN_SHEAR_SCALE * Math.max(0, 1 - sample.minSingularValue));
    strained.push({ shear: [[...sample.worldPosition, sample.hazard], [...offset, STRAIN_SHEAR_RADIUS], [...n, 0]], hazard: sample.hazard });
    return [sample.worldPosition[0], sample.worldPosition[1], sample.worldPosition[2], sample.hazard];
  });
  strained.sort((a, b) => b.hazard - a.hazard);
  for (const s of strained) if (shears.length < MAX_SHEARS && s.hazard > 0.05) shears.push(s.shear);
  return { folds, hazards, shears };
}

const shearCache = new WeakMap<SimulationEngine, { readonly key: number; readonly shears: readonly Shear[] }>();
/** The disturbance shears at a lattice time, computed once per 4 Hz lattice step (the disturbances and the map change slowly). */
function disturbanceShearsAt(engine: SimulationEngine, lattice: number): readonly Shear[] {
  const hit = shearCache.get(engine);
  if (hit && hit.key === lattice) return hit.shears;
  const shears: Shear[] = [];
  for (const def of moversFor(engine).disturbances) { const s = disturbanceShear(engine, def, disturbanceIntensity(def, lattice), lattice); if (s) shears.push(s); }
  shearCache.set(engine, { key: lattice, shears });
  return shears;
}

function dist2(a: Vec3, b: Vec3): number {
  return (a[0] - b[0]) ** 2 + (a[1] - b[1]) ** 2 + (a[2] - b[2]) ** 2;
}
