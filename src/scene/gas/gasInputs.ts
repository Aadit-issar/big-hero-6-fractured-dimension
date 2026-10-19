import type { SimulationEngine } from '../../simulation/simulationEngine';
import type { Vec3 } from '../../simulation/types';
import { cross, multiply, normalize, scale, sub } from '../../simulation/linearAlgebra';
import { MAX_FOLDS, MAX_HAZARDS, MAX_SHEARS } from './GasVolumePass';

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
  for (const f of pairs.slice(0, 2)) {
    shears.push([[...f.entry, f.w], [...scale(sub(f.exit, f.entry), FOLD_SHEAR_GAIN), FOLD_SHEAR_RADIUS], [...f.entryNormal, 1]]);
    shears.push([[...f.exit, f.w], [...scale(sub(f.entry, f.exit), FOLD_SHEAR_GAIN), FOLD_SHEAR_RADIUS], [...f.exitNormal, 1]]);
  }
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

function dist2(a: Vec3, b: Vec3): number {
  return (a[0] - b[0]) ** 2 + (a[1] - b[1]) ** 2 + (a[2] - b[2]) ** 2;
}
