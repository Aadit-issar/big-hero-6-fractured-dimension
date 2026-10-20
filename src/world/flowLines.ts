import type { Vec3 } from '../simulation/types';
import { frameAcceleration, sheetSlip, swirlAxis } from './movers';
import type { DisturbanceDef, DisturbanceFrame } from './movers';

/** Flow lines: streamlines of a disturbance's own acceleration field a_d(q, t) in REFERENCE space (the space the movers integrate in).
 * The visuals push the points through the unchanged map afterwards, so a line drawn in the Dimension is exactly the path a unit-mass
 * test particle would be pushed along by that disturbance (at that instant). Pure and allocation-free after construction. */
export const FLOW_POINTS = 24;
export const FLOW_LINES_PER_DISTURBANCE = 12;

const cross = (a: Vec3, b: Vec3): Vec3 => [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]];
const unit3 = (v: Vec3): Vec3 => { const n = Math.hypot(v[0], v[1], v[2]); return n > 1e-12 ? [v[0] / n, v[1] / n, v[2] / n] : [0, 1, 0]; };

/** Peak acceleration scale used to normalise brightness (so a line fades where the disturbance's force fades). */
export function flowScale(d: DisturbanceDef): number {
  return Math.max(1e-6, d.strength * (d.kind === 'sheet' ? 0.8 : 0.6));
}

/** Deterministic seed points (reference space) of one disturbance at time t. They are fixed offsets in the disturbance's own frame:
 * rings and heights around a swirl axis, a lattice either side of a sheet, a Fibonacci shell around a well. Writes 3 numbers per seed into `out`. */
export function flowSeeds(d: DisturbanceDef, t: number, out: Float64Array): void {
  const c = d.centre, s = d.sigma, kind = d.kind ?? 'swirl';
  const put = (i: number, p: Vec3) => { out[i * 3] = p[0]; out[i * 3 + 1] = p[1]; out[i * 3 + 2] = p[2]; };
  if (kind === 'swirl') {
    const n = swirlAxis(d, t), helper: Vec3 = Math.abs(n[1]) < 0.9 ? [0, 1, 0] : [1, 0, 0];
    const u1 = unit3(cross(n, helper)), u2 = cross(n, u1);
    const radii = [0.55, 0.95, 1.4], heights = [-0.7, 0, 0.7];
    for (let i = 0; i < FLOW_LINES_PER_DISTURBANCE; i += 1) {
      const rad = radii[i % 3]! * s, h = i < 9 ? heights[Math.floor(i / 3)]! * s : 0.0;
      const ang = i < 9 ? (i * 2.399) : (i - 9) * 2.1 + 0.5;
      const rr = i < 9 ? rad : (0.75 + 0.3 * (i - 9)) * s;
      put(i, [c[0] + rr * (Math.cos(ang) * u1[0] + Math.sin(ang) * u2[0]) + h * n[0], c[1] + rr * (Math.cos(ang) * u1[1] + Math.sin(ang) * u2[1]) + h * n[1], c[2] + rr * (Math.cos(ang) * u1[2] + Math.sin(ang) * u2[2]) + h * n[2]]);
    }
  } else if (kind === 'sheet') {
    const n = unit3(d.axis), slip = sheetSlip(d), b = cross(n, slip), delta = d.thickness ?? 0.2;
    const hs = [-2.2, -0.8, 0.8, 2.2], bs = [-0.7, 0, 0.7];
    for (let i = 0; i < FLOW_LINES_PER_DISTURBANCE; i += 1) {
      const h = hs[i % 4]! * delta, bb = bs[Math.floor(i / 4)]! * s;
      put(i, [c[0] + h * n[0] + bb * b[0], c[1] + h * n[1] + bb * b[1], c[2] + h * n[2] + bb * b[2]]);
    }
  } else {
    const golden = Math.PI * (3 - Math.sqrt(5));
    for (let i = 0; i < FLOW_LINES_PER_DISTURBANCE; i += 1) {
      const y = 1 - (2 * (i + 0.5)) / FLOW_LINES_PER_DISTURBANCE, rr = Math.sqrt(Math.max(0, 1 - y * y)), th = golden * i;
      const R = 1.25 * s;
      put(i, [c[0] + R * rr * Math.cos(th), c[1] + R * y, c[2] + R * rr * Math.sin(th)]);
    }
  }
}

/** Trace one streamline through (sx, sy, sz) (RK2 midpoint, fixed arc step) of a prepared disturbance frame. Points are ordered along the
 * force direction. `ref` receives FLOW_POINTS reference positions (3 numbers each, from `offset`), `mag` the normalised force magnitude
 * (0..~1) at each. Allocation-free. */
export function traceFlowLine(f: DisturbanceFrame, scale: number, sx: number, sy: number, sz: number, ref: Float64Array, mag: Float64Array, offset: number, scratch: Float64Array): void {
  const h = 0.16 * f.sigma, mid = Math.floor(FLOW_POINTS / 2);
  const write = (i: number, x: number, y: number, z: number, m: number) => { const o = (offset + i) * 3; ref[o] = x; ref[o + 1] = y; ref[o + 2] = z; mag[offset + i] = m; };
  frameAcceleration(f, sx, sy, sz, scratch);
  write(mid, sx, sy, sz, Math.hypot(scratch[0]!, scratch[1]!, scratch[2]!) / scale);
  for (let sign = 1; sign >= -1; sign -= 2) {
    let x = sx, y = sy, z = sz;
    const count = sign > 0 ? FLOW_POINTS - 1 - mid : mid;
    for (let k = 1; k <= count; k += 1) {
      frameAcceleration(f, x, y, z, scratch);
      let m = Math.hypot(scratch[0]!, scratch[1]!, scratch[2]!);
      if (m > 1e-9) {
        const mx = x + 0.5 * h * sign * scratch[0]! / m, my = y + 0.5 * h * sign * scratch[1]! / m, mz = z + 0.5 * h * sign * scratch[2]! / m;
        frameAcceleration(f, mx, my, mz, scratch);
        m = Math.hypot(scratch[0]!, scratch[1]!, scratch[2]!);
        if (m > 1e-9) { x += h * sign * scratch[0]! / m; y += h * sign * scratch[1]! / m; z += h * sign * scratch[2]! / m; }
      }
      write(mid + sign * k, x, y, z, m / scale);
    }
  }
}
