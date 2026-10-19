/** Hard-surface modelling kit shared by the asset generators (metres, +y up).
 * Every triangle is oriented against an explicit outward normal, so parts built
 * from prisms, sweeps and shells are closed and outward-facing by construction
 * (checked on export by assets-src/microbot/inspect.ts). */
import { ShapeUtils, Vector2 } from 'three';
import { createNoise3, fbm } from '../../src/scene/terrain/noise';

export type V3 = [number, number, number];
export type V2 = [number, number];
export type RGB = [number, number, number];

export const sub = (a: V3, b: V3): V3 => [a[0] - b[0], a[1] - b[1], a[2] - b[2]];
export const add = (a: V3, b: V3): V3 => [a[0] + b[0], a[1] + b[1], a[2] + b[2]];
export const mul = (a: V3, s: number): V3 => [a[0] * s, a[1] * s, a[2] * s];
export const cross = (a: V3, b: V3): V3 => [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]];
export const dot = (a: V3, b: V3) => a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
export const len = (a: V3) => Math.hypot(a[0], a[1], a[2]);
export const norm = (a: V3): V3 => { const l = len(a) || 1; return [a[0] / l, a[1] / l, a[2] / l]; };
export const lerp3 = (a: V3, b: V3, t: number): V3 => [a[0] + (b[0] - a[0]) * t, a[1] + (b[1] - a[1]) * t, a[2] + (b[2] - a[2]) * t];

/** Deterministic PRNG (mulberry32) for generators. */
export function rng(seed: number): () => number {
  let s = seed >>> 0;
  return () => { s = (s + 0x6d2b79f5) >>> 0; let t = s; t = Math.imul(t ^ (t >>> 15), t | 1); t ^= t + Math.imul(t ^ (t >>> 7), t | 61); return ((t ^ (t >>> 14)) >>> 0) / 4294967296; };
}

/** Rigid transform: rotation (3 basis columns) + translation. */
export interface Frame { readonly x: V3; readonly y: V3; readonly z: V3; readonly o: V3 }
export const IDENTITY: Frame = { x: [1, 0, 0], y: [0, 1, 0], z: [0, 0, 1], o: [0, 0, 0] };
export const apply = (f: Frame, p: V3): V3 => add(f.o, add(add(mul(f.x, p[0]), mul(f.y, p[1])), mul(f.z, p[2])));
export const applyDir = (f: Frame, d: V3): V3 => add(add(mul(f.x, d[0]), mul(f.y, d[1])), mul(f.z, d[2]));
export function rotation(axis: V3, angle: number): Frame {
  const [x, y, z] = norm(axis), c = Math.cos(angle), s = Math.sin(angle), t = 1 - c;
  return { x: [t * x * x + c, t * x * y + s * z, t * x * z - s * y], y: [t * x * y - s * z, t * y * y + c, t * y * z + s * x], z: [t * x * z + s * y, t * y * z - s * x, t * z * z + c], o: [0, 0, 0] };
}
export function compose(a: Frame, b: Frame): Frame {
  return { x: applyDir(a, b.x), y: applyDir(a, b.y), z: applyDir(a, b.z), o: apply(a, b.o) };
}
export const translate = (o: V3): Frame => ({ ...IDENTITY, o });

export class MeshBuilder {
  positions: number[] = [];
  normals: number[] = [];
  colors: number[] = [];
  indices: number[] = [];
  constructor(public color: RGB = [1, 1, 1], public colorFn?: (p: V3, n: V3) => RGB) {}
  private push(p: V3[], n: V3[]): void {
    const base = this.positions.length / 3;
    for (let i = 0; i < 3; i += 1) {
      this.positions.push(...p[i]!); this.normals.push(...n[i]!);
      this.colors.push(...(this.colorFn ? this.colorFn(p[i]!, n[i]!) : this.color));
    }
    this.indices.push(base, base + 1, base + 2);
  }
  tri(a: V3, b: V3, c: V3, out: V3): void {
    let g = cross(sub(b, a), sub(c, a));
    if (len(g) < 1e-12) return;
    if (dot(g, out) < 0) { [b, c] = [c, b]; g = mul(g, -1); }
    const n = norm(g);
    this.push([a, b, c], [n, n, n]);
  }
  quad(a: V3, b: V3, c: V3, d: V3, out: V3): void { this.tri(a, b, c, out); this.tri(a, c, d, out); }
  triSmooth(p: [V3, V3, V3], n: [V3, V3, V3]): void {
    const g = cross(sub(p[1], p[0]), sub(p[2], p[0]));
    if (len(g) < 1e-12) return;
    if (dot(g, add(add(n[0], n[1]), n[2])) < 0) { this.push([p[0], p[2], p[1]], [n[0], n[2], n[1]]); return; }
    this.push(p, n);
  }
  get triangleCount(): number { return this.indices.length / 3; }
}

/** Signed area of a 2D polygon (CCW > 0). */
export function area2(poly: readonly V2[]): number {
  let a = 0;
  for (let i = 0; i < poly.length; i += 1) { const p = poly[i]!, q = poly[(i + 1) % poly.length]!; a += p[0] * q[1] - q[0] * p[1]; }
  return a / 2;
}

/** Closed prism: planar polygon (local x–y) extruded along local z from z0 to z1.
 * `jitter` optionally displaces cap vertices along z (rough break faces). */
export function prism(mb: MeshBuilder, poly: readonly V2[], z0: number, z1: number, frame: Frame = IDENTITY, holes: readonly (readonly V2[])[] = []): void {
  const ccw = area2(poly) > 0 ? poly : [...poly].reverse();
  const contour = ccw.map(([x, y]) => new Vector2(x, y));
  const holeVec = holes.map((h) => (area2(h) > 0 ? [...h].reverse() : h).map(([x, y]) => new Vector2(x, y)));
  const all = [...contour, ...holeVec.flat()];
  const tris = ShapeUtils.triangulateShape(contour, holeVec);
  const down = applyDir(frame, [0, 0, -1]), up = applyDir(frame, [0, 0, 1]);
  for (const [i, j, k] of tris) {
    const p = (idx: number, z: number) => apply(frame, [all[idx]!.x, all[idx]!.y, z]);
    mb.tri(p(i!, z0), p(j!, z0), p(k!, z0), down);
    mb.tri(p(i!, z1), p(j!, z1), p(k!, z1), up);
  }
  const wall = (ring: readonly V2[], outwardSign: number) => {
    const sgn = area2(ring) > 0 ? 1 : -1;
    for (let i = 0; i < ring.length; i += 1) {
      const a = ring[i]!, b = ring[(i + 1) % ring.length]!;
      // For a CCW ring the outward normal is to the right of the edge direction.
      const out: V3 = applyDir(frame, [(b[1] - a[1]) * sgn * outwardSign, -(b[0] - a[0]) * sgn * outwardSign, 0]);
      mb.quad(apply(frame, [a[0], a[1], z0]), apply(frame, [b[0], b[1], z0]), apply(frame, [b[0], b[1], z1]), apply(frame, [a[0], a[1], z1]), out);
    }
  };
  wall(poly, 1);
  for (const h of holes) wall(h, -1);
}

/** Box from centre and half-extents in a frame. */
export function box(mb: MeshBuilder, half: V3, frame: Frame = IDENTITY): void {
  prism(mb, [[-half[0], -half[1]], [half[0], -half[1]], [half[0], half[1]], [-half[0], half[1]]], -half[2], half[2], frame);
}

/** Parallel-transport frames along a polyline (no twisting or flipping). */
export function transportFrames(path: readonly V3[]): Array<{ p: V3; t: V3; n: V3; b: V3 }> {
  const out: Array<{ p: V3; t: V3; n: V3; b: V3 }> = [];
  const tangent = (i: number) => norm(i === 0 ? sub(path[1]!, path[0]!) : i === path.length - 1 ? sub(path[i]!, path[i - 1]!) : sub(path[i + 1]!, path[i - 1]!));
  let t = tangent(0);
  let n = norm(Math.abs(t[1]) < 0.9 ? cross(t, [0, 1, 0]) : cross(t, [1, 0, 0]));
  for (let i = 0; i < path.length; i += 1) {
    const t2 = tangent(i);
    const axis = cross(t, t2), s = len(axis);
    if (s > 1e-9) { const ang = Math.atan2(s, dot(t, t2)); n = applyDir(rotation(axis, ang), n); }
    t = t2;
    n = norm(sub(n, mul(t, dot(n, t))));
    out.push({ p: path[i]!, t, n, b: cross(t, n) });
  }
  return out;
}

/** Sweep a closed 2D profile (x→normal, y→binormal) along a path, with caps.
 * `scaleAt(i)` scales the profile per station; `flat` gives faceted sides. */
export function sweep(mb: MeshBuilder, profile: readonly V2[], path: readonly V3[], opts: { scaleAt?: (i: number) => number; twist?: number; caps?: boolean; flat?: boolean } = {}): void {
  const frames = transportFrames(path);
  const prof = area2(profile) > 0 ? profile : [...profile].reverse();
  const rings = frames.map((f, i) => {
    const s = opts.scaleAt?.(i) ?? 1, tw = (opts.twist ?? 0) * (i / Math.max(1, path.length - 1));
    const c = Math.cos(tw), sn = Math.sin(tw);
    return prof.map(([x, y]) => { const xr = x * c - y * sn, yr = x * sn + y * c; return add(f.p, add(mul(f.n, xr * s), mul(f.b, yr * s))); });
  });
  for (let i = 0; i < rings.length - 1; i += 1) {
    const r0 = rings[i]!, r1 = rings[i + 1]!, f = frames[i]!;
    const tw = (opts.twist ?? 0) * (i / Math.max(1, path.length - 1)), c = Math.cos(tw), sn = Math.sin(tw);
    for (let k = 0; k < prof.length; k += 1) {
      const k2 = (k + 1) % prof.length;
      // Outward normal of a CCW profile edge is its right-hand perpendicular; this is
      // correct for concave profiles (e.g. I-beam inner flange faces) too.
      const ex = prof[k2]![0] - prof[k]![0], ey = prof[k2]![1] - prof[k]![1];
      const ox = ey * c - -ex * sn, oy = ey * sn + -ex * c;
      const out = add(mul(f.n, ox), mul(f.b, oy));
      if (opts.flat ?? true) mb.quad(r0[k]!, r1[k]!, r1[k2]!, r0[k2]!, out);
      else {
        const nrm = (r: V3[], j: number, f: { p: V3 }) => norm(sub(r[j]!, f.p));
        const n00 = nrm(r0, k, frames[i]!), n01 = nrm(r0, k2, frames[i]!), n10 = nrm(r1, k, frames[i + 1]!), n11 = nrm(r1, k2, frames[i + 1]!);
        mb.triSmooth([r0[k]!, r1[k]!, r1[k2]!], [n00, n10, n11]);
        mb.triSmooth([r0[k]!, r1[k2]!, r0[k2]!], [n00, n11, n01]);
      }
    }
  }
  if (opts.caps ?? true) {
    const contour = prof.map(([x, y]) => new Vector2(x, y));
    const tris = ShapeUtils.triangulateShape(contour, []);
    for (const [ri, f, sign] of [[0, frames[0]!, -1], [rings.length - 1, frames[frames.length - 1]!, 1]] as const) {
      const r = rings[ri]!;
      for (const [a, b, c] of tris) mb.tri(r[a!]!, r[b!]!, r[c!]!, mul(f.t, sign));
    }
  }
}

export const circle = (r: number, n: number): V2[] => Array.from({ length: n }, (_, i) => [r * Math.cos((i / n) * Math.PI * 2), r * Math.sin((i / n) * Math.PI * 2)] as V2);

/** Hollow tube (pipe wall) along a path: outer + inner surfaces and annular end caps.
 * `endCut` optionally makes each end ring jagged (torn metal). */
export function hollowTube(mb: MeshBuilder, path: readonly V3[], rOuter: number, rInner: number, segs: number, endJag?: (end: 0 | 1, angle: number) => number): void {
  const frames = transportFrames(path);
  const ring = (i: number, r: number, end?: 0 | 1) => {
    const f = frames[i]!;
    return Array.from({ length: segs }, (_, k) => {
      const a = (k / segs) * Math.PI * 2;
      const jag = end !== undefined && endJag ? endJag(end, a) : 0;
      return { p: add(add(f.p, mul(f.t, jag)), add(mul(f.n, Math.cos(a) * r), mul(f.b, Math.sin(a) * r))), n: norm(add(mul(f.n, Math.cos(a)), mul(f.b, Math.sin(a)))) };
    });
  };
  const last = path.length - 1;
  const outer = frames.map((_, i) => ring(i, rOuter, i === 0 ? 0 : i === last ? 1 : undefined));
  const inner = frames.map((_, i) => ring(i, rInner, i === 0 ? 0 : i === last ? 1 : undefined));
  for (let i = 0; i < last; i += 1) for (let k = 0; k < segs; k += 1) {
    const k2 = (k + 1) % segs;
    const o0 = outer[i]!, o1 = outer[i + 1]!, n0 = inner[i]!, n1 = inner[i + 1]!;
    mb.triSmooth([o0[k]!.p, o1[k]!.p, o1[k2]!.p], [o0[k]!.n, o1[k]!.n, o1[k2]!.n]);
    mb.triSmooth([o0[k]!.p, o1[k2]!.p, o0[k2]!.p], [o0[k]!.n, o1[k2]!.n, o0[k2]!.n]);
    const neg = (v: V3): V3 => mul(v, -1);
    mb.triSmooth([n0[k]!.p, n1[k2]!.p, n1[k]!.p], [neg(n0[k]!.n), neg(n1[k2]!.n), neg(n1[k]!.n)]);
    mb.triSmooth([n0[k]!.p, n0[k2]!.p, n1[k2]!.p], [neg(n0[k]!.n), neg(n0[k2]!.n), neg(n1[k2]!.n)]);
  }
  for (const [i, sign] of [[0, -1], [last, 1]] as const) {
    const o = outer[i]!, n = inner[i]!, t = mul(frames[i]!.t, sign);
    for (let k = 0; k < segs; k += 1) { const k2 = (k + 1) % segs; mb.quad(o[k]!.p, o[k2]!.p, n[k2]!.p, n[k]!.p, t); }
  }
}

/** Thick shell patch over a parametric surface S(u,v) (outward normal points away
 * from the origin), kept where mask(u,v) > 0. Each grid cell is clipped against
 * the mask's zero contour (marching-squares style) so broken edges are smooth
 * fractures, not grid steps. Crossing points depend only on the shared cell edge,
 * keeping neighbouring cells watertight; the offset inner surface (optionally in
 * another material) and boundary walls close the solid. */
export function shell(mb: MeshBuilder, S: (u: number, v: number) => V3, rawMask: (u: number, v: number) => number, thickness: number, res: number, inner?: MeshBuilder): void {
  const e = 1e-4;
  // Force the mask negative at the parameter border so every boundary is a contour.
  const mask = (u: number, v: number) => Math.min(rawMask(u, v), Math.min(u, v, 1 - u, 1 - v) * 4 - 0.02);
  const normalAt = (u: number, v: number): V3 => {
    const du = sub(S(Math.min(1, u + e), v), S(Math.max(0, u - e), v)), dv = sub(S(u, Math.min(1, v + e)), S(u, Math.max(0, v - e)));
    let n = norm(cross(du, dv));
    if (dot(n, S(u, v)) < 0) n = mul(n, -1);
    return n;
  };
  const back = inner ?? mb;
  const M: number[][] = [];
  for (let i = 0; i <= res; i += 1) { M.push([]); for (let j = 0; j <= res; j += 1) M[i]!.push(mask(i / res, j / res)); }
  type Pt = { u: number; v: number; crossing: boolean };
  for (let i = 0; i < res; i += 1) for (let j = 0; j < res; j += 1) {
    const corners: Array<[number, number]> = [[i, j], [i + 1, j], [i + 1, j + 1], [i, j + 1]];
    const poly: Pt[] = [];
    for (let k = 0; k < 4; k += 1) {
      const [ai, aj] = corners[k]!, [bi, bj] = corners[(k + 1) % 4]!;
      const ma = M[ai]![aj]!, mb2 = M[bi]![bj]!;
      if (ma > 0) poly.push({ u: ai / res, v: aj / res, crossing: false });
      if ((ma > 0) !== (mb2 > 0)) {
        const t = ma / (ma - mb2);
        poly.push({ u: (ai + (bi - ai) * t) / res, v: (aj + (bj - aj) * t) / res, crossing: true });
      }
    }
    if (poly.length < 3) continue;
    const P = poly.map((p) => S(p.u, p.v)), N = poly.map((p) => normalAt(p.u, p.v));
    const I = P.map((p, k) => sub(p, mul(N[k]!, thickness))), NI = N.map((n) => mul(n, -1));
    for (let k = 1; k < poly.length - 1; k += 1) {
      mb.triSmooth([P[0]!, P[k]!, P[k + 1]!], [N[0]!, N[k]!, N[k + 1]!]);
      back.triSmooth([I[0]!, I[k + 1]!, I[k]!], [NI[0]!, NI[k + 1]!, NI[k]!]);
    }
    for (let k = 0; k < poly.length; k += 1) {
      const k2 = (k + 1) % poly.length;
      if (!(poly[k]!.crossing && poly[k2]!.crossing)) continue;
      // Wall along the fracture: outward points away from the kept region (cell centroid).
      const centre = P.reduce((s2, p) => add(s2, p), [0, 0, 0] as V3).map((c) => c / P.length) as V3;
      back.quad(P[k]!, P[k2]!, I[k2]!, I[k]!, sub(lerp3(P[k]!, P[k2]!, 0.5), centre));
    }
  }
}

/** Jagged broken outline: a base polygon with fractal noise displacing each edge
 * inward (never outward, so authored bounds hold). */
export function brokenOutline(base: readonly V2[], seed: number, amplitude: number, perEdge = 9): V2[] {
  const noise = createNoise3(seed), out: V2[] = [];
  for (let i = 0; i < base.length; i += 1) {
    const a = base[i]!, b = base[(i + 1) % base.length]!;
    const ex = b[0] - a[0], ey = b[1] - a[1], el = Math.hypot(ex, ey);
    const nx = -ey / el, ny = ex / el; // inward for CCW
    for (let k = 0; k < perEdge; k += 1) {
      const t = k / perEdge;
      const jag = k === 0 ? 0 : Math.abs(fbm(noise, (i * perEdge + k) * 0.37, i * 1.7, 0.5, 3)) * amplitude * 2.2;
      out.push([a[0] + ex * t + nx * jag, a[1] + ey * t + ny * jag]);
    }
  }
  return out;
}

export { createNoise3, fbm };
