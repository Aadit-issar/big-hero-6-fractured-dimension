/**
 * Hiro's microbot — parametric hard-surface model (editable source of truth).
 *
 * Run:  npx tsx assets-src/microbot/buildMicrobot.ts
 * Out:  public/assets/models/microbot.glb (+ microbot.stats.json)
 *
 * Construction (dimensions normalised to total length 1, then scaled to metres):
 *  - Two mirrored arms: lofts of a bevelled-octagon cross-section through
 *    authored stations (inner chamfer → maximum → seam ring → two-facet long
 *    taper → seam ring → end chamfer → recessed end cap). Faces are flat-shaded;
 *    narrow bevel strips along every longitudinal edge catch edge highlights.
 *  - Recessed slots and panel seams are real geometry: holes triangulated into
 *    the planar loft faces, with walls and floors inset along the face normal.
 *  - Central joint: a lathe around the arm axis with an equatorial groove and
 *    two latitude grooves, joined to the arms by short octagonal necks.
 * Every triangle is oriented against an analytic outward normal, so mirrored
 * parts and concave pockets wind correctly by construction (verified by
 * scripts in assets-src/microbot/inspect.ts).
 * Proportions were measured from the orthographic panels of
 * `Design/Object Designs/ChatGPT Image Oct 17, 2026, 10_46_23 PM.png`.
 */
import { mkdirSync, writeFileSync } from 'node:fs';
import { ShapeUtils, Vector2 } from 'three';
import { writeGlb } from '../gltf/writeGlb';
import type { GltfMaterial, Primitive } from '../gltf/writeGlb';

export const PARAMS = {
  /** Real-world length in metres (film microbots are fingertip-scale; assumption). */
  length: 0.04,
  sphereRadius: 0.0925,
  /** Closed octagonal necks running from inside the sphere to inside the arm. */
  neck: { from: 0.05, to: 0.1, half: 0.05 },
  /** Fraction of the octagon half-size removed at each corner (diagonal facets). */
  cornerCut: 0.36,
  /** Bevel strip width as a fraction of the half-size. */
  bevel: 0.035,
  /** Profile (x, half-size) along +x, traversed from the inner-face centre to the tip centre. */
  stations: [
    // The inner face sits slightly inside the ball so the joint reads as seated.
    [0.09, 0.0],
    [0.09, 0.072],     // inner face rim
    [0.135, 0.0915],   // inner chamfer → maximum section
    [0.165, 0.0915],
    [0.168, 0.0895],   // seam ring
    [0.172, 0.0895],
    [0.175, 0.0912],
    [0.3, 0.0745],     // facet crease of the long taper
    [0.43, 0.0525],
    [0.433, 0.0505],   // seam ring before the end chamfer
    [0.437, 0.0505],
    [0.44, 0.0518],
    [0.485, 0.0265],   // end chamfer
    [0.485, 0.019],    // end-cap rim step
    [0.479, 0.019],    // recess wall
    [0.479, 0.0],      // recessed end face
  ] as Array<[number, number]>,
  seamDepth: 0.0035,
  slotDepth: 0.012,
  jointSegments: 44,
};

type V3 = [number, number, number];
const sub = (a: V3, b: V3): V3 => [a[0] - b[0], a[1] - b[1], a[2] - b[2]];
const addv = (a: V3, b: V3): V3 => [a[0] + b[0], a[1] + b[1], a[2] + b[2]];
const mul = (a: V3, s: number): V3 => [a[0] * s, a[1] * s, a[2] * s];
const cross = (a: V3, b: V3): V3 => [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]];
const dot = (a: V3, b: V3) => a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
const norm = (a: V3): V3 => { const l = Math.hypot(...a) || 1; return [a[0] / l, a[1] / l, a[2] / l]; };

/** Triangle builder; every triangle is wound to face `out`. */
class MeshBuilder {
  positions: number[] = [];
  normals: number[] = [];
  indices: number[] = [];
  /** Flat triangle facing `out` (geometric normal used for shading). */
  tri(a: V3, b: V3, c: V3, out: V3): void {
    let g = cross(sub(b, a), sub(c, a));
    if (Math.hypot(...g) < 1e-14) return; // degenerate
    if (dot(g, out) < 0) { [b, c] = [c, b]; g = mul(g, -1); }
    this.push([a, b, c], [norm(g), norm(g), norm(g)]);
  }
  quad(a: V3, b: V3, c: V3, d: V3, out: V3): void { this.tri(a, b, c, out); this.tri(a, c, d, out); }
  /** Smooth triangle with per-vertex normals; winding follows the mean normal. */
  triSmooth(p: [V3, V3, V3], n: [V3, V3, V3]): void {
    const g = cross(sub(p[1], p[0]), sub(p[2], p[0]));
    if (Math.hypot(...g) < 1e-14) return;
    const mean = addv(addv(n[0], n[1]), n[2]);
    if (dot(g, mean) < 0) { this.push([p[0], p[2], p[1]], [n[0], n[2], n[1]]); return; }
    this.push(p, n);
  }
  private push(p: V3[], n: V3[]): void {
    const base = this.positions.length / 3;
    for (let i = 0; i < 3; i += 1) { this.positions.push(...p[i]!); this.normals.push(...n[i]!); }
    this.indices.push(base, base + 1, base + 2);
  }
}

/** Bevelled octagon (y, z) of half-size h: 16 points; main face j spans points 2j+1 → 2j+2. */
function section(h: number): Array<[number, number]> {
  if (h <= 0) return Array.from({ length: 16 }, () => [0, 0]);
  const c = PARAMS.cornerCut * h, b = PARAMS.bevel * h;
  const oct: Array<[number, number]> = [
    [h, h - c], [h - c, h], [-(h - c), h], [-h, h - c], [-h, -(h - c)], [-(h - c), -h], [h - c, -h], [h, -(h - c)],
  ];
  const pts: Array<[number, number]> = [];
  for (let i = 0; i < 8; i += 1) {
    const p = oct[i]!, prev = oct[(i + 7) % 8]!, next = oct[(i + 1) % 8]!;
    const dp = Math.hypot(prev[0] - p[0], prev[1] - p[1]), dn = Math.hypot(next[0] - p[0], next[1] - p[1]);
    pts.push([p[0] + ((prev[0] - p[0]) / dp) * b, p[1] + ((prev[1] - p[1]) / dp) * b]);
    pts.push([p[0] + ((next[0] - p[0]) / dn) * b, p[1] + ((next[1] - p[1]) / dn) * b]);
  }
  return pts;
}
// Main face j (points 2j+1 → 2j+2) outward directions in (y, z): j=0 +z side … see FACE.
export const FACE = { upperZDiag: 0, zSide: 1, lowerZDiag: 2, bottom: 3, lowerNegZDiag: 4, negZSide: 5, upperNegZDiag: 6, top: 7 } as const;

interface Feature { readonly polygon: Array<[number, number]>; readonly depth: number }

/** Planar face (a, b, c, d) with recessed polygon holes. u runs a→b, v runs a→d. */
function featuredQuad(body: MeshBuilder, recess: MeshBuilder, a: V3, b: V3, c: V3, d: V3, out: V3, features: readonly Feature[]): void {
  let n = norm(cross(sub(b, a), sub(d, a)));
  if (dot(n, out) < 0) n = mul(n, -1);
  const at = (u: number, v: number): V3 => addv(addv(mul(a, (1 - u) * (1 - v)), mul(b, u * (1 - v))), addv(mul(c, u * v), mul(d, (1 - u) * v)));
  const contour = [new Vector2(0, 0), new Vector2(1, 0), new Vector2(1, 1), new Vector2(0, 1)];
  const holes = features.map((f) => f.polygon.map(([u, v]) => new Vector2(u, v)));
  const all = [...contour, ...holes.flat()].map((p) => at(p.x, p.y));
  for (const [i, j, k] of ShapeUtils.triangulateShape(contour, holes)) body.tri(all[i!]!, all[j!]!, all[k!]!, n);
  for (const f of features) {
    const rim = f.polygon.map(([u, v]) => at(u, v));
    const floor = rim.map((p) => sub(p, mul(n, f.depth)));
    // Polygon orientation about n decides which side of each edge is the pocket interior.
    let area: V3 = [0, 0, 0];
    for (let i = 0; i < rim.length; i += 1) area = addv(area, cross(rim[i]!, rim[(i + 1) % rim.length]!));
    const orient = Math.sign(dot(area, n)) || 1;
    for (let i = 0; i < rim.length; i += 1) {
      const j = (i + 1) % rim.length;
      const edge = sub(rim[j]!, rim[i]!);
      const intoPocket = mul(cross(n, edge), orient); // walls face the pocket interior
      recess.quad(rim[i]!, rim[j]!, floor[j]!, floor[i]!, intoPocket);
    }
    const flat = f.polygon.map(([u, v]) => new Vector2(u, v));
    for (const [i, j, k] of ShapeUtils.triangulateShape(flat, [])) recess.tri(floor[i!]!, floor[j!]!, floor[k!]!, n);
  }
}

const rect = (u0: number, u1: number, v0: number, v1: number): Array<[number, number]> => [[u0, v0], [u1, v0], [u1, v1], [u0, v1]];

/** Slots and seams keyed `${segment}:${face}`; segment k joins stations k and k+1.
 * u runs along the arm from the inner end to the tip; v runs across the face. */
function features(): Map<string, Feature[]> {
  const map = new Map<string, Feature[]>();
  if (!DETAILS.on) return map;
  const add = (seg: number, face: number, f: Feature) => { const k = `${seg}:${face}`; map.set(k, [...(map.get(k) ?? []), f]); };
  const s = PARAMS.slotDepth, m = PARAMS.seamDepth;
  for (const side of [FACE.zSide, FACE.negZSide]) {
    add(6, side, { polygon: rect(0.05, 0.15, 0.56, 0.84), depth: s });
    add(6, side, { polygon: [[0.05, 0.18], [0.155, 0.18], [0.155, 0.3], [0.1, 0.3], [0.1, 0.46], [0.05, 0.46]], depth: s });
    add(6, side, { polygon: [[0.24, 0.885], [0.97, 0.885], [0.97, 0.905], [0.24, 0.905]], depth: m });
    add(6, side, { polygon: [[0.24, 0.1], [0.62, 0.1], [0.7, 0.16], [0.97, 0.16], [0.97, 0.18], [0.69, 0.18], [0.61, 0.12], [0.24, 0.12]], depth: m });
    add(7, side, { polygon: [[0.03, 0.885], [0.55, 0.885], [0.66, 0.78], [0.94, 0.78], [0.94, 0.8], [0.67, 0.8], [0.56, 0.905], [0.03, 0.905]], depth: m });
    add(7, side, { polygon: [[0.03, 0.16], [0.9, 0.16], [0.9, 0.18], [0.03, 0.18]], depth: m });
  }
  for (const diag of [FACE.upperZDiag, FACE.lowerZDiag, FACE.lowerNegZDiag, FACE.upperNegZDiag]) add(6, diag, { polygon: rect(0.06, 0.13, 0.3, 0.7), depth: s * 0.7 });
  for (const cap of [FACE.top, FACE.bottom]) {
    add(6, cap, { polygon: rect(0.24, 0.97, 0.47, 0.53), depth: m });
    add(7, cap, { polygon: rect(0.03, 0.9, 0.47, 0.53), depth: m });
  }
  return map;
}

/** Arm along sign·x. The -x arm is a 180° rotation about y of the +x arm, so slots
 * and seams sit symmetrically on both sides (a true mirror would swap handedness). */
function buildArm(body: MeshBuilder, recess: MeshBuilder, sign: 1 | -1): void {
  const st = PARAMS.stations;
  const feats = features();
  const place = (x: number, y: number, z: number): V3 => [sign * x, y, sign * z];
  for (let k = 0; k < st.length - 1; k += 1) {
    const [x0, h0] = st[k]!, [x1, h1] = st[k + 1]!;
    const s0 = section(h0), s1 = section(h1);
    // Outward normal in the (x, radial) profile plane: perpendicular to the traversal.
    const dx = x1 - x0, dh = h1 - h0, len = Math.hypot(dx, dh);
    const nx = -dh / len, nr = dx / len;
    for (let e = 0; e < 16; e += 1) {
      const e2 = (e + 1) % 16;
      const a = place(x0, ...s0[e]!), b = place(x1, ...s1[e]!), c = place(x1, ...s1[e2]!), d = place(x0, ...s0[e2]!);
      // Radial outward direction of this edge (midpoint of the section edge).
      const mid = [(s0[e]![0] + s0[e2]![0] + s1[e]![0] + s1[e2]![0]) / 4, (s0[e]![1] + s0[e2]![1] + s1[e]![1] + s1[e2]![1]) / 4];
      const ml = Math.hypot(mid[0]!, mid[1]!) || 1;
      const out: V3 = [sign * nx, nr * (mid[0]! / ml), sign * nr * (mid[1]! / ml)];
      if (h0 === 0 || h1 === 0) {
        // End caps: fan to the centre; normal along ±x.
        const centre = h0 === 0 ? a : b, p = h0 === 0 ? b : a, q = h0 === 0 ? c : d;
        body.tri(centre, p, q, [sign * nx, 0, 0]);
        continue;
      }
      const face = e % 2 === 1 ? (e - 1) / 2 : -1;
      const list = face >= 0 ? feats.get(`${k}:${face}`) : undefined;
      if (list?.length) featuredQuad(body, recess, a, b, c, d, out, list);
      else body.quad(a, b, c, d, out);
    }
  }
}

function buildNecks(body: MeshBuilder): void {
  const { from, to, half } = PARAMS.neck;
  const s = section(half);
  for (const sign of [1, -1] as const) {
    for (let e = 0; e < 16; e += 1) {
      const e2 = (e + 1) % 16;
      const p = (x: number, i: number): V3 => [sign * x, s[i]![0], sign * s[i]![1]];
      const my = (s[e]![0] + s[e2]![0]) / 2, mz = (s[e]![1] + s[e2]![1]) / 2;
      body.quad(p(from, e), p(to, e), p(to, e2), p(from, e2), [0, my, sign * mz]);
      // Hidden end caps keep each neck a closed solid.
      body.tri([sign * from, 0, 0], p(from, e), p(from, e2), [-sign, 0, 0]);
      body.tri([sign * to, 0, 0], p(to, e), p(to, e2), [sign, 0, 0]);
    }
  }
}

/** Lathed joint sphere about x with three grooves (recess material). */
function buildJoint(joint: MeshBuilder, recess: MeshBuilder): void {
  const R = PARAMS.sphereRadius, segs = PARAMS.jointSegments;
  // One equatorial seam (perpendicular to the arm axis), as on the reference.
  const grooves = DETAILS.on ? [0] : [], gw = 0.0034, gd = 0.0034;
  type P = { x: number; r: number; nx: number; nr: number };
  type Run = { pts: P[]; groove: boolean };
  const runs: Run[] = [];
  const bounds = [-R, ...grooves.flatMap((g) => [g - gw, g + gw]), R];
  const rad = (x: number) => Math.sqrt(Math.max(0, R * R - x * x));
  for (let s = 0; s < bounds.length - 1; s += 1) {
    const lo = bounds[s]!, hi = bounds[s + 1]!;
    if (s % 2 === 1) {
      const rlo = rad(lo), rhi = rad(hi), inner = Math.min(rlo, rhi) - gd;
      runs.push({ groove: true, pts: [{ x: lo, r: rlo, nx: 1, nr: 0 }, { x: lo, r: inner, nx: 1, nr: 0 }] });
      runs.push({ groove: true, pts: [{ x: lo, r: inner, nx: 0, nr: 1 }, { x: hi, r: inner, nx: 0, nr: 1 }] });
      runs.push({ groove: true, pts: [{ x: hi, r: inner, nx: -1, nr: 0 }, { x: hi, r: rhi, nx: -1, nr: 0 }] });
      continue;
    }
    // Spherical run sampled uniformly in polar angle for even curvature resolution.
    const t0 = Math.acos(Math.max(-1, Math.min(1, lo / R))), t1 = Math.acos(Math.max(-1, Math.min(1, hi / R)));
    const steps = Math.max(2, Math.ceil((Math.abs(t0 - t1) / Math.PI) * DETAILS.jointRings));
    const pts: P[] = [];
    for (let i = 0; i <= steps; i += 1) {
      const t = t0 + ((t1 - t0) * i) / steps;
      pts.push({ x: R * Math.cos(t), r: R * Math.sin(t), nx: Math.cos(t), nr: Math.sin(t) });
    }
    runs.push({ groove: false, pts });
  }
  for (const run of runs) {
    const target = run.groove ? recess : joint;
    for (let i = 0; i < run.pts.length - 1; i += 1) {
      const p = run.pts[i]!, q = run.pts[i + 1]!;
      for (let s = 0; s < segs; s += 1) {
        const a0 = (s / segs) * Math.PI * 2, a1 = ((s + 1) / segs) * Math.PI * 2;
        const v = (pt: P, a: number): V3 => [pt.x, pt.r * Math.cos(a), pt.r * Math.sin(a)];
        const n = (pt: P, a: number): V3 => norm([pt.nx, pt.nr * Math.cos(a), pt.nr * Math.sin(a)]);
        target.triSmooth([v(p, a0), v(q, a0), v(q, a1)], [n(p, a0), n(q, a0), n(q, a1)]);
        target.triSmooth([v(p, a0), v(q, a1), v(p, a1)], [n(p, a0), n(q, a1), n(p, a1)]);
      }
    }
  }
}

/** Scale to metres and weld vertices that share both position and normal, so
 * flat faces keep hard edges while smooth surfaces share vertices. */
function scaled(b: MeshBuilder, s: number): Primitive['geometry'] {
  const map = new Map<string, number>();
  const positions: number[] = [], normals: number[] = [], indices: number[] = [];
  for (const i of b.indices) {
    const p = [b.positions[i * 3]! * s, b.positions[i * 3 + 1]! * s, b.positions[i * 3 + 2]! * s];
    const n = [b.normals[i * 3]!, b.normals[i * 3 + 1]!, b.normals[i * 3 + 2]!];
    const key = `${p.map((v) => Math.round(v * 1e8)).join(',')}|${n.map((v) => Math.round(v * 1e4)).join(',')}`;
    let index = map.get(key);
    if (index === undefined) { index = positions.length / 3; map.set(key, index); positions.push(...p); normals.push(...n); }
    indices.push(index);
  }
  return { positions: new Float32Array(positions), normals: new Float32Array(normals), indices: new Uint32Array(indices) };
}

/** Level-of-detail switches. Defaults reproduce the approved model exactly. */
const DETAILS = { on: true, jointRings: 44, necks: true };
export interface MicrobotLod { readonly stations: Array<[number, number]>; readonly bevel: number; readonly jointSegments: number; readonly jointRings: number; readonly necks: boolean }

/** Approved model with no arguments; reduced-detail swarm LODs with `lod`. */
export function buildMicrobot(lod?: MicrobotLod): { primitives: Primitive[]; materials: GltfMaterial[] } {
  const saved = { stations: PARAMS.stations, bevel: PARAMS.bevel, jointSegments: PARAMS.jointSegments };
  if (lod) Object.assign(PARAMS, { stations: lod.stations, bevel: lod.bevel, jointSegments: lod.jointSegments });
  Object.assign(DETAILS, lod ? { on: false, jointRings: lod.jointRings, necks: lod.necks } : { on: true, jointRings: 44, necks: true });
  const body = new MeshBuilder(), recess = new MeshBuilder(), joint = new MeshBuilder();
  try {
    buildArm(body, recess, 1);
    buildArm(body, recess, -1);
    if (DETAILS.necks) buildNecks(body);
    buildJoint(joint, recess);
  } finally {
    Object.assign(PARAMS, saved);
    Object.assign(DETAILS, { on: true, jointRings: 44, necks: true });
  }
  const materials: GltfMaterial[] = [
    { name: 'microbot_shell', baseColor: [0.02, 0.021, 0.024, 1], metallic: 0.45, roughness: 0.4 },
    { name: 'microbot_recess', baseColor: [0.004, 0.004, 0.005, 1], metallic: 0.15, roughness: 0.85 },
    { name: 'microbot_joint', baseColor: [0.028, 0.029, 0.033, 1], metallic: 0.6, roughness: 0.28 },
  ];
  const s = PARAMS.length;
  const primitives: Primitive[] = [
    { geometry: scaled(body, s), material: 0 },
    { geometry: scaled(recess, s), material: 1 },
    { geometry: scaled(joint, s), material: 2 },
  ];
  if (!lod) return { materials, primitives };
  // Drop empty primitives and their materials (LODs have no recesses).
  const used = primitives.filter((p) => p.geometry.indices.length > 0);
  return { materials: used.map((p) => materials[p.material]!), primitives: used.map((p, i) => ({ ...p, material: i })) };
}

const isMain = process.argv[1]?.replace(/\\/g, '/').endsWith('assets-src/microbot/buildMicrobot.ts');
if (isMain) {
  const { primitives, materials } = buildMicrobot();
  const glb = writeGlb({ name: 'HiroMicrobot', primitives, materials });
  mkdirSync('public/assets/models', { recursive: true });
  writeFileSync('public/assets/models/microbot.glb', glb);
  const triangles = primitives.reduce((n, p) => n + p.geometry.indices.length / 3, 0);
  const vertices = primitives.reduce((n, p) => n + p.geometry.positions.length / 3, 0);
  const stats = { file: 'public/assets/models/microbot.glb', bytes: glb.byteLength, meshes: 1, primitives: primitives.length, materials: materials.length, triangles, vertices, textures: 0, lengthMetres: PARAMS.length };
  writeFileSync('public/assets/models/microbot.stats.json', JSON.stringify(stats, null, 2) + '\n');
  console.log(JSON.stringify(stats));
}
