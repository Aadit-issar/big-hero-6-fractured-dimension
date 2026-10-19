/**
 * Dimension asset library generator (editable source for every non-microbot asset).
 *
 * Run:  npx tsx assets-src/library/buildLibrary.ts
 * Out:  public/assets/models/<id>.glb, plus microbot LODs, and
 *       public/assets/models/manifest.json (measured bounds, triangles, bytes).
 *
 * Units: metres, +y up. The dimension renders 1 world unit = 1 metre
 * (see src/scene/assets/assetRegistry.ts for the scale convention).
 * All shapes are deterministic (fixed seeds); no third-party geometry.
 */
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { writeGlb } from '../gltf/writeGlb';
import type { GltfMaterial, Primitive } from '../gltf/writeGlb';
import { buildMicrobot } from '../microbot/buildMicrobot';
import type { MicrobotLod } from '../microbot/buildMicrobot';
import {
  add, apply, box, brokenOutline, circle, compose, createNoise3, cross, fbm, hollowTube, IDENTITY, lerp3, MeshBuilder, mul, norm, prism,
  rng, rotation, shell, sweep,
} from '../lib/kit';
import type { Frame, RGB, V2, V3 } from '../lib/kit';
import { writeAssetSizes } from './writeSizes';

// ------------------------------------------------------------------ materials
const M = {
  concrete: { name: 'concrete', baseColor: [0.33, 0.322, 0.31, 1], metallic: 0, roughness: 0.92 },
  rebar: { name: 'rebar_rusted', baseColor: [0.24, 0.15, 0.1, 1], metallic: 0.55, roughness: 0.72 },
  steelPaint: { name: 'steel_painted', baseColor: [0.2, 0.22, 0.26, 1], metallic: 0.45, roughness: 0.55 },
  steelRaw: { name: 'steel_bare', baseColor: [0.5, 0.5, 0.52, 1], metallic: 0.9, roughness: 0.36 },
  safety: { name: 'paint_safety_yellow', baseColor: [0.82, 0.56, 0.07, 1], metallic: 0.15, roughness: 0.5 },
  grating: { name: 'steel_grating', baseColor: [0.19, 0.19, 0.21, 1], metallic: 0.75, roughness: 0.5 },
  pipe: { name: 'pipe_steel_painted', baseColor: [0.24, 0.27, 0.3, 1], metallic: 0.35, roughness: 0.55 },
  kreiRed: { name: 'paint_krei_red', baseColor: [0.58, 0.07, 0.06, 1], metallic: 0.1, roughness: 0.45 },
  rubber: { name: 'cable_insulation', baseColor: [1, 1, 1, 1], metallic: 0, roughness: 0.62 },
  copper: { name: 'copper', baseColor: [0.95, 0.56, 0.36, 1], metallic: 1, roughness: 0.3 },
  panel: { name: 'panel_white', baseColor: [0.56, 0.57, 0.58, 1], metallic: 0.2, roughness: 0.42 },
  capsuleShell: { name: 'capsule_composite', baseColor: [0.62, 0.63, 0.64, 1], metallic: 0.1, roughness: 0.38 },
  heatShield: { name: 'capsule_heatshield', baseColor: [0.06, 0.06, 0.07, 1], metallic: 0.05, roughness: 0.82 },
  alloy: { name: 'alloy_machined', baseColor: [0.6, 0.62, 0.66, 1], metallic: 0.95, roughness: 0.28 },
  baymaxRed: { name: 'baymax_armour_red', baseColor: [0.62, 0.035, 0.045, 1], metallic: 0.15, roughness: 0.26 },
  baymaxPurple: { name: 'baymax_armour_purple', baseColor: [0.16, 0.08, 0.3, 1], metallic: 0.15, roughness: 0.3 },
  innerMech: { name: 'mechanism_grey', baseColor: [0.34, 0.36, 0.39, 1], metallic: 0.8, roughness: 0.42 },
} satisfies Record<string, GltfMaterial>;
type MatKey = keyof typeof M;

/** Asset under construction: one builder per material. */
class Asset {
  private readonly parts = new Map<MatKey, MeshBuilder>();
  constructor(readonly id: string) {}
  mb(key: MatKey, colorFn?: (p: V3, n: V3) => RGB): MeshBuilder {
    let b = this.parts.get(key);
    if (!b) { b = new MeshBuilder([1, 1, 1], colorFn); this.parts.set(key, b); }
    else if (colorFn) b.colorFn = colorFn;
    return b;
  }
  export(): { glb: Uint8Array; triangles: number; vertices: number; min: V3; max: V3; materials: string[] } {
    const keys = [...this.parts.keys()].filter((k) => this.parts.get(k)!.triangleCount > 0);
    const materials = keys.map((k) => M[k] as GltfMaterial);
    const primitives: Primitive[] = keys.map((k, i) => ({ geometry: weld(this.parts.get(k)!), material: i }));
    const glb = writeGlb({ name: this.id, primitives, materials });
    const min: V3 = [Infinity, Infinity, Infinity], max: V3 = [-Infinity, -Infinity, -Infinity];
    let triangles = 0, vertices = 0;
    for (const p of primitives) {
      triangles += p.geometry.indices.length / 3; vertices += p.geometry.positions.length / 3;
      for (let i = 0; i < p.geometry.positions.length; i += 3) for (let k = 0; k < 3; k += 1) {
        min[k] = Math.min(min[k]!, p.geometry.positions[i + k]!); max[k] = Math.max(max[k]!, p.geometry.positions[i + k]!);
      }
    }
    return { glb, triangles, vertices, min, max, materials: materials.map((m) => m.name) };
  }
}

/** Weld vertices sharing position, normal and colour. */
function weld(b: MeshBuilder): Primitive['geometry'] {
  const map = new Map<string, number>();
  const positions: number[] = [], normals: number[] = [], colors: number[] = [], indices: number[] = [];
  for (const i of b.indices) {
    const p = b.positions.slice(i * 3, i * 3 + 3), n = b.normals.slice(i * 3, i * 3 + 3), c = b.colors.slice(i * 3, i * 3 + 3);
    const key = `${p.map((v) => Math.round(v * 1e6)).join(',')}|${n.map((v) => Math.round(v * 1e3)).join(',')}|${c.map((v) => Math.round(v * 255)).join(',')}`;
    let index = map.get(key);
    if (index === undefined) { index = positions.length / 3; map.set(key, index); positions.push(...p); normals.push(...n); colors.push(...c.map((v) => Math.min(1, Math.max(0, v)))); }
    indices.push(index);
  }
  const allWhite = colors.every((v) => v > 0.999);
  return { positions: new Float32Array(positions), normals: new Float32Array(normals), indices: new Uint32Array(indices), ...(allWhite ? {} : { colors: new Float32Array(colors) }) };
}

// --------------------------------------------------------------- colour helpers
const clamp01 = (v: number) => Math.min(1, Math.max(0, v));
function concreteColour(seed: number) {
  const n = createNoise3(seed);
  return (p: V3, nrm: V3): RGB => {
    const stain = fbm(n, p[0] * 1.3, p[1] * 1.3, p[2] * 1.3, 4) * 0.22;
    const aggregate = fbm(n, p[0] * 9 + 3, p[1] * 9, p[2] * 9, 2) * 0.08;
    // Fresh break faces (near-horizontal normals in slab space) are lighter and cleaner.
    const fresh = Math.abs(nrm[1]) < 0.6 ? 0.06 : 0;
    const v = clamp01(0.92 + stain + aggregate + fresh);
    return [v, v * 0.99, v * 0.97];
  };
}
function wearColour(seed: number, amount = 0.25) {
  const n = createNoise3(seed);
  return (p: V3): RGB => {
    const w = clamp01(0.85 + fbm(n, p[0] * 2.2, p[1] * 2.2, p[2] * 2.2, 3) * amount);
    return [w, w, w];
  };
}

// --------------------------------------------------------------- frames
/** Frame whose local z maps to world +y (for slab-like prisms lying in x–z). */
const LIE: Frame = { x: [1, 0, 0], y: [0, 0, -1], z: [0, 1, 0], o: [0, 0, 0] };
const at = (o: V3, base: Frame = IDENTITY): Frame => ({ ...base, o });

// --------------------------------------------------------------- concrete
function rebarGrid(a: Asset, w: number, d: number, spacing: number, layers: number[], seed: number, protrude: number) {
  const r = rng(seed), mb = a.mb('rebar');
  const bar = circle(0.0085, 6);
  const run = (from: V3, to: V3) => {
    // Extend past the rectangle edge and bend the free end (torn reinforcement).
    const dir = norm(add(to, mul(from, -1)));
    const ext = protrude * (0.2 + r());
    const bend: V3 = norm(add(dir, [(r() - 0.5) * 1.2, (r() - 0.3) * 1.4, (r() - 0.5) * 1.2]));
    const end1 = add(to, mul(dir, ext * 0.4)), end2 = add(end1, mul(bend, ext * 0.6));
    sweep(mb, bar, [from, lerp3(from, to, 0.5), to, end1, end2], { flat: false });
  };
  for (const y of layers) {
    for (let x = -w / 2 + spacing / 2; x < w / 2; x += spacing) if (r() > 0.15) run([x, y, d / 2 - 0.02], [x, y, -d / 2 - 0.0]);
    for (let z = -d / 2 + spacing / 2; z < d / 2; z += spacing) if (r() > 0.15) run([-w / 2 + 0.02, y + 0.012, z], [w / 2, y + 0.012, z]);
  }
}

function concreteSlab(id: string, w: number, d: number, t: number, seed: number, opts: { rebar?: boolean; hole?: V2[]; notch?: boolean } = {}): Asset {
  const a = new Asset(id);
  const base: V2[] = opts.notch
    ? [[-w / 2, -d / 2], [w / 2, -d / 2], [w / 2, d * 0.1], [w * 0.15, d / 2], [-w / 2, d / 2]]
    : [[-w / 2, -d / 2], [w / 2, -d / 2], [w / 2, d / 2], [-w / 2, d / 2]];
  const outline = brokenOutline(base, seed, Math.min(w, d) * 0.06, 11);
  const mb = a.mb('concrete', concreteColour(seed));
  prism(mb, outline, -t / 2, t / 2, LIE, opts.hole ? [brokenOutline(opts.hole, seed + 7, 0.05, 5)] : []);
  // Spalled layer: a thinner, smaller stepped plate on top where the surface broke away.
  const inner = brokenOutline(base.map(([x, y]) => [x * 0.72, y * 0.66]), seed + 3, Math.min(w, d) * 0.05, 9);
  prism(mb, inner, t / 2 - 0.0005, t / 2 + t * 0.12, LIE, opts.hole ? [brokenOutline(opts.hole.map(([x, y]) => [x * 1.15, y * 1.15] as V2), seed + 9, 0.05, 5)] : []);
  if (opts.rebar) rebarGrid(a, w, d, 0.3, [-t * 0.25, t * 0.25], seed + 11, Math.min(w, d) * 0.22);
  return a;
}

function concreteChunk(id: string, size: number, seed: number): Asset {
  const a = new Asset(id), r = rng(seed);
  const mb = a.mb('concrete', concreteColour(seed));
  // Stepped irregular blocks: 2–3 broken prisms stacked with offsets.
  const layers = 2 + Math.floor(r() * 2);
  let z = -size * 0.22;
  for (let i = 0; i < layers; i += 1) {
    const n = 5 + Math.floor(r() * 3), s = size * (0.5 - i * 0.1) * (0.85 + r() * 0.3);
    const poly: V2[] = Array.from({ length: n }, (_, k) => { const ang = (k / n) * Math.PI * 2 + r() * 0.5; const rr = s * (0.7 + r() * 0.35); return [Math.cos(ang) * rr * 1.25, Math.sin(ang) * rr] as V2; });
    const h = size * (0.16 + r() * 0.12);
    prism(mb, brokenOutline(poly, seed + i, s * 0.12, 4), z, z + h, compose(LIE, at([(r() - 0.5) * s * 0.3, 0, (r() - 0.5) * s * 0.3], rotation([0, 0, 1], r() * 0.6))));
    z += h - 0.002;
  }
  if (r() > 0.3) rebarGrid(a, size * 0.6, size * 0.5, size * 0.25, [0], seed + 5, size * 0.3);
  return a;
}

function rubble(id: string, count: number, spread: number, seed: number): Asset {
  const a = new Asset(id), r = rng(seed);
  const mb = a.mb('concrete', concreteColour(seed));
  for (let i = 0; i < count; i += 1) {
    const s = 0.08 + r() ** 1.5 * 0.32, n = 5 + Math.floor(r() * 3);
    const poly: V2[] = Array.from({ length: n }, (_, k) => { const ang = (k / n) * Math.PI * 2 + r() * 0.6; const rr = s * (0.6 + r() * 0.5); return [Math.cos(ang) * rr, Math.sin(ang) * rr * (0.7 + r() * 0.5)] as V2; });
    const f = compose(at([(r() - 0.5) * spread, (r() - 0.5) * spread * 0.4, (r() - 0.5) * spread]), rotation(norm([r() - 0.5, r() - 0.5, r() - 0.5]), r() * Math.PI));
    prism(mb, poly, -s * 0.35, s * 0.35, f);
  }
  return a;
}

// --------------------------------------------------------------- steel
const iProfile = (h: number, b: number, tw: number, tf: number): V2[] => [
  [-b / 2, -h / 2], [b / 2, -h / 2], [b / 2, -h / 2 + tf], [tw / 2, -h / 2 + tf], [tw / 2, h / 2 - tf], [b / 2, h / 2 - tf],
  [b / 2, h / 2], [-b / 2, h / 2], [-b / 2, h / 2 - tf], [-tw / 2, h / 2 - tf], [-tw / 2, -h / 2 + tf], [-b / 2, -h / 2 + tf],
];

function beamPath(length: number, bendAt: number, bendAngle: number, bendAxis: V3, segments: number): V3[] {
  const pts: V3[] = [];
  for (let i = 0; i <= segments; i += 1) {
    const s = (i / segments) * length;
    if (s <= bendAt * length) pts.push([s, 0, 0]);
    else {
      // Smooth plastic bend: rotate progressively past the bend point.
      const k = Math.min(1, (s - bendAt * length) / (length * 0.25));
      const f = rotation(bendAxis, bendAngle * k);
      pts.push(add([bendAt * length, 0, 0], apply(f, [s - bendAt * length, 0, 0])));
    }
  }
  return pts;
}

function iBeam(id: string, length: number, seed: number, opts: { bend: number; twist: number; endPlate?: boolean }): Asset {
  const a = new Asset(id), r = rng(seed);
  const prof = iProfile(0.36, 0.17, 0.012, 0.02);
  const path = beamPath(length, 0.45 + r() * 0.2, opts.bend, norm([0, 0.3, 1]), 28).map((p) => add(p, [-length / 2, 0, 0]));
  sweep(a.mb('steelPaint', wearColour(seed, 0.35)), prof, path, { twist: opts.twist, flat: true });
  if (opts.endPlate) {
    // Bolted end connection: plate + bolt heads (torn from its column).
    const start = path[0]!;
    box(a.mb('steelPaint'), [0.012, 0.22, 0.12], at(add(start, [-0.012, 0, 0])));
    for (const y of [-0.15, -0.05, 0.05, 0.15]) for (const z of [-0.07, 0.07]) {
      sweep(a.mb('steelRaw'), circle(0.012, 6), [add(start, [-0.045, y, z]), add(start, [-0.024, y, z])], { flat: true });
    }
  }
  return a;
}

function column(id: string, height: number, seed: number): Asset {
  const a = new Asset(id), r = rng(seed);
  const prof = iProfile(0.3, 0.3, 0.012, 0.018);
  const path = beamPath(height, 0.55 + r() * 0.15, -0.45, [0, 0, 1], 24).map(([x, y, z]) => [y, x - height / 2, z] as V3);
  sweep(a.mb('steelPaint', wearColour(seed, 0.3)), prof, path, { twist: 0.25, flat: true });
  const base = path[0]!;
  box(a.mb('steelPaint'), [0.3, 0.015, 0.3], at(add(base, [0, -0.015, 0])));
  for (const [x, z] of [[-0.22, -0.22], [0.22, -0.22], [0.22, 0.22], [-0.22, 0.22]] as const) {
    sweep(a.mb('steelRaw'), circle(0.014, 8), [add(base, [x, -0.25, z]), add(base, [x, 0.04, z])], { flat: false });
  }
  return a;
}

// --------------------------------------------------------------- scaffolding
function scaffold(id: string, seed: number): Asset {
  const a = new Asset(id), r = rng(seed);
  const tube = circle(0.024, 10), tubes = a.mb('steelRaw', wearColour(seed, 0.2)), couplers = a.mb('steelPaint');
  const W = 2.0, D = 1.0, H = 3.6;
  const kink = (p0: V3, p1: V3, amount: number): V3[] => {
    const mid = lerp3(p0, p1, 0.45 + r() * 0.2);
    return [p0, lerp3(p0, mid, 0.5), add(mid, [(r() - 0.5) * amount, 0, (r() - 0.5) * amount]), lerp3(mid, p1, 0.5), p1];
  };
  const corners: V2[] = [[-W / 2, -D / 2], [W / 2, -D / 2], [W / 2, D / 2], [-W / 2, D / 2]];
  corners.forEach(([x, z], i) => {
    const top = i === 2 ? H * 0.62 : H; // one standard snapped short
    sweep(tubes, tube, kink([x, -H / 2, z], [x, -H / 2 + top, z], i === 1 ? 0.35 : 0.06), { flat: false });
  });
  for (const y of [-H / 2 + 0.2, -H / 2 + 1.9]) {
    sweep(tubes, tube, [[-W / 2, y, -D / 2], [W / 2, y, -D / 2]], { flat: false });
    sweep(tubes, tube, [[-W / 2, y, D / 2], [0.4, y + 0.05, D / 2]], { flat: false }); // broken ledger
    for (const x of [-W / 2, W / 2]) {
      sweep(tubes, tube, [[x, y, -D / 2], [x, y, D / 2]], { flat: false });
      for (const z of [-D / 2, D / 2]) box(couplers, [0.04, 0.035, 0.04], at([x, y, z]));
    }
  }
  sweep(tubes, tube, kink([-W / 2, -H / 2 + 0.2, -D / 2], [W / 2, -H / 2 + 1.9, -D / 2], 0.12), { flat: false }); // diagonal brace
  return a;
}

function scaffoldPole(id: string, seed: number): Asset {
  const a = new Asset(id), r = rng(seed);
  const pts: V3[] = [];
  // One smooth plastic bend (no kinks), slightly out of plane.
  const sag = 0.25 + r() * 0.15;
  for (let i = 0; i <= 24; i += 1) { const s = i / 24; pts.push([s * 3 - 1.5, Math.sin(s * Math.PI) ** 1.5 * sag, Math.sin(s * Math.PI) * 0.08]); }
  sweep(a.mb('steelRaw', wearColour(seed, 0.2)), circle(0.024, 10), pts, { flat: false });
  box(a.mb('steelPaint'), [0.045, 0.04, 0.045], at(pts[3]!));
  return a;
}

// --------------------------------------------------------------- walkway
function walkway(id: string, length: number, seed: number, torn: boolean): Asset {
  const a = new Asset(id), r = rng(seed);
  const W = 1.0, frame = a.mb('steelPaint', wearColour(seed, 0.3)), grate = a.mb('grating'), rail = a.mb('safety', wearColour(seed + 1, 0.2));
  // C-channel stringers on both sides.
  for (const z of [-W / 2, W / 2]) box(frame, [length / 2, 0.075, 0.025], at([0, -0.06, z]));
  // Grating: bearing bars along the length, cross bars across; torn end shortens bars.
  for (let z = -W / 2 + 0.04; z < W / 2 - 0.02; z += 0.04) {
    const end = torn ? length / 2 - (0.05 + r() ** 2 * 0.6) : length / 2;
    box(grate, [(end + length / 2) / 2, 0.016, 0.0025], at([(end - length / 2) / 2, 0, z]));
  }
  for (let x = -length / 2 + 0.05; x < length / 2 - (torn ? 0.6 : 0.02); x += 0.1) box(grate, [0.0025, 0.008, W / 2 - 0.03], at([x, 0.008, 0]));
  // Handrail: posts + bent top rail + knee rail on one side.
  const posts = Math.max(2, Math.round(length / 1.2));
  for (let i = 0; i <= posts; i += 1) {
    const x = -length / 2 + 0.1 + (i / posts) * (length - 0.2);
    const lean = i === posts && torn ? 0.5 : 0;
    sweep(rail, circle(0.021, 8), [[x, -0.02, W / 2], [x + lean * 0.3, 1.05, W / 2 + lean * 0.4]], { flat: false });
  }
  const top: V3[] = [];
  for (let i = 0; i <= 16; i += 1) {
    const s = i / 16, x = -length / 2 + 0.1 + s * (length - 0.2);
    const sag = torn && s > 0.7 ? (s - 0.7) * 1.6 : 0;
    top.push([x, 1.05 - sag * 0.6, W / 2 + sag * 0.5]);
  }
  sweep(rail, circle(0.021, 8), top, { flat: false });
  sweep(rail, circle(0.017, 8), top.slice(0, 11).map(([x, y, z]) => [x, y - 0.5, z] as V3), { flat: false });
  box(frame, [length / 2 - 0.1, 0.05, 0.004], at([0, 0.06, W / 2 - 0.01])); // toe plate
  return a;
}

// --------------------------------------------------------------- pipes & cables
function pipeLarge(id: string, seed: number): Asset {
  const a = new Asset(id), noise = createNoise3(seed);
  const L = 3.0, R = 0.3, path: V3[] = Array.from({ length: 9 }, (_, i) => [-L / 2 + (i / 8) * L, 0, 0]);
  hollowTube(a.mb('pipe', wearColour(seed, 0.25)), path, R, R - 0.02, 40, (end, ang) => (end === 1 ? -Math.abs(fbm(noise, Math.cos(ang) * 2, Math.sin(ang) * 2, 0, 3)) * 0.5 - 0.02 : 0));
  // Flange (annulus with bolt holes) at the intact end.
  const bolts = Array.from({ length: 12 }, (_, i) => { const ang = (i / 12) * Math.PI * 2; return circle(0.018, 8).map(([x, y]) => [x + Math.cos(ang) * 0.38, y + Math.sin(ang) * 0.38] as V2); });
  prism(a.mb('pipe'), circle(0.44, 48), -0.03, 0.03, { x: [0, 0, 1], y: [0, 1, 0], z: [-1, 0, 0], o: [-L / 2 - 0.0, 0, 0] }, [circle(R - 0.02, 40), ...bolts]);
  hollowTube(a.mb('kreiRed'), [[-0.6, 0, 0], [-0.3, 0, 0]], R + 0.004, R - 0.005, 40);
  return a;
}

function pipeElbow(id: string, seed: number): Asset {
  const a = new Asset(id), noise = createNoise3(seed);
  const R = 0.15, bend = 0.55, path: V3[] = [];
  for (let i = 0; i <= 6; i += 1) path.push([-1.0 + i * 0.12, 0, 0]);
  for (let i = 1; i <= 12; i += 1) { const ang = (i / 12) * (Math.PI / 2); path.push([-0.28 + Math.sin(ang) * bend, (1 - Math.cos(ang)) * bend, 0]); }
  for (let i = 1; i <= 6; i += 1) path.push([-0.28 + bend, bend + i * 0.13, 0]);
  hollowTube(a.mb('pipe', wearColour(seed, 0.3)), path, R, R - 0.012, 28, (end, ang) => (end === 1 ? -Math.abs(fbm(noise, Math.cos(ang) * 2, Math.sin(ang) * 2, 1, 3)) * 0.25 - 0.01 : 0));
  prism(a.mb('pipe'), circle(0.24, 32), -0.02, 0.02, { x: [0, 0, 1], y: [0, 1, 0], z: [-1, 0, 0], o: path[0]! }, [circle(R - 0.012, 28)]);
  return a;
}

function cables(id: string, count: number, length: number, seed: number, colours: RGB[]): Asset {
  const a = new Asset(id), r = rng(seed), noise = createNoise3(seed);
  for (let c = 0; c < count; c += 1) {
    const off: V3 = [0, (c % 3 - 1) * 0.04 + (r() - 0.5) * 0.01, (Math.floor(c / 3) - 1) * 0.04 + (r() - 0.5) * 0.01];
    const end = length * (0.75 + r() * 0.25), splay = c * 0.7;
    const pts: V3[] = [];
    for (let i = 0; i <= 24; i += 1) {
      const s = i / 24, x = -length / 2 + s * end;
      const fray = s > 0.75 ? (s - 0.75) * 4 : 0; // strands splay apart near the torn end
      pts.push(add([x, Math.sin(s * 3.1 + c) * 0.08 + fbm(noise, s * 3, c, 0, 2) * 0.12, Math.cos(s * 2.3 + c * 0.7) * 0.06], add(off, [0, Math.sin(splay) * fray * 0.12, Math.cos(splay) * fray * 0.12])));
    }
    const colour = colours[c % colours.length]!;
    sweep(a.mb('rubber', () => colour), circle(0.0135, 8), pts, { flat: false });
    // Exposed copper core and strands at the torn end.
    const tip = pts[pts.length - 1]!, dir = norm(add(tip, mul(pts[pts.length - 2]!, -1)));
    for (let k = 0; k < 3; k += 1) {
      const spread: V3 = [0, (r() - 0.5) * 0.05, (r() - 0.5) * 0.05];
      sweep(a.mb('copper'), circle(0.0035, 5), [tip, add(add(tip, mul(dir, 0.05 + r() * 0.05)), spread)], { flat: true });
    }
  }
  // Cable cleat clamping the bundle.
  box(a.mb('steelPaint'), [0.03, 0.09, 0.09], at([-length / 2 + 0.25, 0, 0]));
  return a;
}

function junctionBox(id: string, seed: number): Asset {
  const a = new Asset(id), r = rng(seed);
  const body = a.mb('panel', wearColour(seed, 0.3));
  // Open-front enclosure: back + four walls.
  box(body, [0.25, 0.3, 0.01], at([0, 0, -0.12]));
  for (const x of [-0.245, 0.245]) box(body, [0.005, 0.3, 0.12], at([x, 0, 0]));
  for (const y of [-0.295, 0.295]) box(body, [0.238, 0.005, 0.118], at([0, y, 0]));
  // Door hanging open on its hinge.
  box(body, [0.25, 0.3, 0.008], compose(at([-0.262, 0, 0.135]), compose(rotation([0, 1, 0], -1.1 - r() * 0.3), at([0.25, 0, 0]))));
  box(a.mb('innerMech'), [0.2, 0.012, 0.04], at([0, 0.12, -0.07])); // DIN rail
  for (let i = 0; i < 4; i += 1) box(a.mb('innerMech'), [0.022, 0.045, 0.035], at([-0.12 + i * 0.07, 0.12, -0.03]));
  for (const x of [-0.12, 0, 0.12]) sweep(a.mb('steelRaw'), circle(0.016, 10), [[x, -0.3, 0], [x, -0.34, 0]], { flat: false });
  return a;
}

// --------------------------------------------------------------- facility panel
function wallPanel(id: string, seed: number): Asset {
  const a = new Asset(id);
  const W = 2.4, H = 1.2, T = 0.05;
  const half1 = brokenOutline([[-W / 2, -H / 2], [0, -H / 2], [0, H / 2], [-W / 2, H / 2]], seed, 0.012, 4);
  const half2 = brokenOutline([[0, -H / 2], [W / 2, -H / 2], [W / 2, H * 0.1], [W * 0.3, H / 2], [0, H / 2]], seed + 1, 0.04, 7);
  const fold = rotation([0, 1, 0], 0.22); // bent along the vertical seam
  const skin = a.mb('panel', wearColour(seed, 0.22));
  prism(skin, half1, -T / 2, T / 2);
  prism(skin, half2, -T / 2, T / 2, fold);
  // Back stiffeners.
  for (const y of [-0.4, 0, 0.4]) { box(a.mb('steelPaint'), [W / 4 - 0.05, 0.03, 0.03], at([-W / 4, y, -T / 2 - 0.03])); box(a.mb('steelPaint'), [W / 4 - 0.15, 0.03, 0.03], compose(fold, at([W / 4 - 0.1, y, -T / 2 - 0.03]))); }
  // Restrained Krei-red identification stripe (no text, no logo).
  const stripe: V2[] = [[-W / 2 + 0.06, 0.24], [-0.02, 0.24], [-0.02, 0.36], [-W / 2 + 0.06, 0.36]];
  prism(a.mb('kreiRed'), stripe, T / 2 - 0.001, T / 2 + 0.002);
  prism(a.mb('kreiRed'), [[0.02, 0.24], [W * 0.27, 0.24], [W * 0.23, 0.36], [0.02, 0.36]], T / 2 - 0.001, T / 2 + 0.002, fold);
  return a;
}

// --------------------------------------------------------------- capsule remnant
/** Separation collar and a torn shell segment from the pod's aft section. The
 * crew compartment is intentionally NOT modelled: in the film Abigail's pod is
 * recovered intact, so only hardware shed on entry can remain here. */
function capsuleRemnant(id: string, seed: number): Asset {
  const a = new Asset(id), r = rng(seed), noise = createNoise3(seed);
  const R = 0.95;
  // Collar: a machined ring with a stepped profile, swept over a 290° arc (broken gap).
  const ringPath: V3[] = [];
  const arc = Math.PI * 2 * 0.8;
  for (let i = 0; i <= 64; i += 1) { const ang = 0.4 + (i / 64) * arc; ringPath.push([Math.cos(ang) * R, 0, Math.sin(ang) * R]); }
  const ringProfile: V2[] = [[-0.07, -0.05], [0.06, -0.05], [0.06, 0.0], [0.03, 0.02], [0.03, 0.06], [-0.07, 0.06]];
  sweep(a.mb('alloy', wearColour(seed, 0.18)), ringProfile, ringPath, { flat: true });
  // Latch lugs around the collar.
  for (let i = 0; i < 10; i += 1) {
    const ang = 0.5 + (i / 10) * arc;
    const f = compose(at([Math.cos(ang) * (R + 0.08), 0.0, Math.sin(ang) * (R + 0.08)]), rotation([0, 1, 0], -ang));
    box(a.mb('innerMech'), [0.035, 0.045, 0.03], f);
  }
  // Shell segment: part of an oblate dome above the collar, torn along a noisy edge.
  const S = (u: number, v: number): V3 => {
    const th = 0.15 + u * 1.25, ph = 0.6 + v * 1.9; // polar (from top) and azimuth range
    return [Math.sin(th) * Math.cos(ph) * 1.05, 0.15 + Math.cos(th) * 0.7, Math.sin(th) * Math.sin(ph) * 1.05];
  };
  const mask = (u: number, v: number) => 0.62 - Math.hypot((u - 0.55) * 1.2, (v - 0.5) * 1.1) + fbm(noise, u * 4, v * 4, 0.3, 4) * 0.22;
  const shellOuter = a.mb('capsuleShell', (p) => { const w = clamp01(0.9 + fbm(noise, p[0] * 3, p[1] * 3, p[2] * 3, 3) * 0.2); const scorch = clamp01((0.35 - p[1]) * 1.6); return [w * (1 - scorch * 0.55), w * (1 - scorch * 0.6), w * (1 - scorch * 0.62)]; });
  shell(shellOuter, S, mask, 0.035, 44, a.mb('innerMech'));
  // Heat-shield band: lower ring segment in dark ablative material.
  const band = (u: number, v: number): V3 => { const ph = 0.9 + v * 1.4, y = -0.12 + u * 0.18; const rr = 1.03 - u * 0.02; return [Math.cos(ph) * rr, y, Math.sin(ph) * rr]; };
  shell(a.mb('heatShield'), band, (u, v) => 0.5 - Math.abs(v - 0.5) + fbm(noise, u * 3 + 5, v * 5, 1, 3) * 0.15, 0.04, 28, a.mb('innerMech'));
  // Structural ribs (meridians + one latitude) and RCS port housings on the shell,
  // clipped to the surviving fragment by the same fracture mask.
  const rib: V2[] = [[-0.012, 0], [0.012, 0], [0.008, 0.014], [-0.008, 0.014]];
  const onShell = (u: number, v: number, lift: number): V3 => { const p = S(u, v); const n = norm(p); return add(p, mul(n, lift)); };
  const ribRun = (pts: Array<[number, number]>) => {
    let run: V3[] = [];
    const flush = () => { if (run.length > 2) sweep(a.mb('alloy'), rib, run, { flat: true }); run = []; };
    for (const [u, v] of pts) { if (mask(u, v) > 0.04) run.push(onShell(u, v, 0.001)); else flush(); }
    flush();
  };
  for (const v of [0.22, 0.47, 0.72]) ribRun(Array.from({ length: 40 }, (_, i) => [0.05 + (i / 39) * 0.9, v] as [number, number]));
  ribRun(Array.from({ length: 60 }, (_, i) => [0.62, 0.02 + (i / 59) * 0.96] as [number, number]));
  for (const [u, v] of [[0.35, 0.35], [0.4, 0.6]] as const) {
    if (mask(u, v) <= 0.1) continue;
    const p = onShell(u, v, 0), n = norm(p), side = norm(cross(n, [0, 1, 0])), up = cross(side, n);
    box(a.mb('innerMech'), [0.06, 0.04, 0.03], { x: side, y: up, z: n, o: add(p, mul(n, 0.02)) });
    sweep(a.mb('heatShield'), circle(0.014, 10), [add(p, mul(n, 0.045)), add(p, mul(n, 0.075))], { flat: false });
  }
  // Torn harness from the separation plane.
  const t0: V3 = [Math.cos(0.4) * R, 0.02, Math.sin(0.4) * R];
  for (let k = 0; k < 4; k += 1) {
    const pts: V3[] = Array.from({ length: 10 }, (_, i) => add(t0, [-(i / 9) * 0.5 * (0.6 + r() * 0.4), Math.sin(i * 0.6 + k) * 0.05 - (i / 9) * 0.15, (k - 1.5) * 0.03 + (i / 9) * (r() - 0.5) * 0.2]));
    sweep(a.mb('rubber', () => [0.08, 0.08, 0.09]), circle(0.011, 6), pts, { flat: false });
  }
  return a;
}

// --------------------------------------------------------------- Baymax remnants
function baymaxShoulder(id: string, seed: number): Asset {
  const a = new Asset(id), noise = createNoise3(seed);
  // Shoulder dome of the red armour: broad sphere patch with a cracked lower edge.
  const S = (u: number, v: number): V3 => { const th = 0.1 + u * 1.45, ph = v * Math.PI * 1.15 - 0.2; return [Math.sin(th) * Math.cos(ph) * 0.42, Math.cos(th) * 0.4, Math.sin(th) * Math.sin(ph) * 0.44]; };
  const mask = (u: number, v: number) => 0.92 - u * 0.95 - Math.abs(v - 0.5) * 0.35 + fbm(noise, u * 5, v * 6, 0, 4) * 0.18;
  shell(a.mb('baymaxRed', wearColour(seed, 0.08)), S, mask, 0.022, 40, a.mb('innerMech'));
  // Purple accent plate (Baymax armour 2.0 accent panels) set into the dome.
  const P = (u: number, v: number): V3 => { const th = 0.25 + u * 0.55, ph = 0.6 + v * 1.0; return [Math.sin(th) * Math.cos(ph) * 0.425, Math.cos(th) * 0.405, Math.sin(th) * Math.sin(ph) * 0.445]; };
  shell(a.mb('baymaxPurple'), P, (u, v) => 0.48 - Math.hypot(u - 0.5, v - 0.5), 0.006, 24, a.mb('innerMech'));
  // Internal joint ring exposed under the shell.
  const ring: V3[] = Array.from({ length: 33 }, (_, i) => { const ang = (i / 32) * Math.PI * 1.6; return [Math.cos(ang) * 0.2, 0.02, Math.sin(ang) * 0.2]; });
  sweep(a.mb('innerMech'), [[-0.02, -0.03], [0.02, -0.03], [0.02, 0.03], [-0.02, 0.03]], ring, { flat: true });
  return a;
}

function baymaxForearm(id: string, seed: number): Asset {
  const a = new Asset(id), noise = createNoise3(seed);
  // Tapered forearm shell (ellipsoidal cylinder segment), broken along one side.
  const S = (u: number, v: number): V3 => { const y = -0.35 + u * 0.7, ph = -0.3 + v * Math.PI * 1.35; const rr = 0.2 - u * 0.04 + Math.sin(u * Math.PI) * 0.015; return [Math.cos(ph) * rr * 1.15, y, Math.sin(ph) * rr]; };
  const mask = (u: number, v: number) => 0.5 - Math.max(Math.abs(u - 0.5) * 0.9, Math.abs(v - 0.55) * 1.05) + fbm(noise, u * 6, v * 5, 2, 4) * 0.12;
  shell(a.mb('baymaxRed', wearColour(seed, 0.08)), S, mask, 0.018, 40, a.mb('innerMech'));
  // Internal frame ribs.
  for (const y of [-0.2, 0, 0.2]) {
    const arcPts: V3[] = Array.from({ length: 17 }, (_, i) => { const ph = 0.2 + (i / 16) * 2.4; return [Math.cos(ph) * 0.16, y, Math.sin(ph) * 0.14]; });
    sweep(a.mb('innerMech'), [[-0.008, -0.012], [0.008, -0.012], [0.008, 0.012], [-0.008, 0.012]], arcPts, { flat: true });
  }
  return a;
}

// --------------------------------------------------------------- registry of builds
export const MICROBOT_LODS: Record<'microbot_lod1' | 'microbot_lod2', MicrobotLod> = {
  microbot_lod1: { stations: [[0.09, 0], [0.09, 0.072], [0.135, 0.0915], [0.172, 0.0905], [0.3, 0.0745], [0.43, 0.0525], [0.485, 0.0265], [0.485, 0]], bevel: 0, jointSegments: 16, jointRings: 10, necks: true },
  microbot_lod2: { stations: [[0.09, 0], [0.09, 0.08], [0.15, 0.0915], [0.43, 0.0525], [0.485, 0.0265], [0.485, 0]], bevel: 0, jointSegments: 8, jointRings: 4, necks: false },
};

const BUILDS: Array<() => Asset> = [
  () => concreteSlab('concrete_slab_rebar', 3.2, 2.1, 0.25, 101, { rebar: true }),
  () => concreteSlab('concrete_wall_breach', 4.4, 2.8, 0.3, 102, { rebar: true, notch: true, hole: [[-0.9, -0.5], [0.3, -0.6], [0.4, 0.4], [-0.8, 0.5]] }),
  () => concreteSlab('concrete_slab_plain', 2.4, 1.6, 0.2, 103),
  () => concreteChunk('concrete_chunk_a', 1.3, 201),
  () => concreteChunk('concrete_chunk_b', 0.9, 202),
  () => concreteChunk('concrete_chunk_c', 0.6, 203),
  () => rubble('rubble_cluster_a', 14, 1.6, 301),
  () => rubble('rubble_cluster_b', 9, 1.1, 302),
  () => iBeam('steel_ibeam_twisted', 5.5, 401, { bend: 0.5, twist: 0.9 }),
  () => iBeam('steel_ibeam_bolted', 4.2, 402, { bend: 0.22, twist: 0.15, endPlate: true }),
  () => column('steel_column_bent', 3.8, 403),
  () => scaffold('scaffold_section', 501),
  () => scaffoldPole('scaffold_pole_bent', 502),
  () => walkway('walkway_section', 3.0, 601, false),
  () => walkway('walkway_torn', 2.4, 602, true),
  () => pipeLarge('pipe_large_fractured', 701),
  () => pipeElbow('pipe_elbow_torn', 702),
  () => cables('cable_bundle', 7, 1.8, 801, [[0.05, 0.05, 0.06], [0.55, 0.1, 0.08], [0.1, 0.18, 0.5], [0.6, 0.5, 0.1]]),
  () => junctionBox('junction_box_broken', 802),
  () => wallPanel('facility_panel_krei', 901),
  () => capsuleRemnant('capsule_collar_remnant', 1001),
  () => baymaxShoulder('baymax_shoulder_fragment', 1101),
  () => baymaxForearm('baymax_forearm_fragment', 1102),
];

const isMain = process.argv[1]?.replace(/\\/g, '/').endsWith('assets-src/library/buildLibrary.ts');
if (isMain) {
  mkdirSync('public/assets/models', { recursive: true });
  const manifest: Record<string, unknown> = {};
  const record = (id: string, glb: Uint8Array, triangles: number, vertices: number, min: V3, max: V3, materials: string[]) => {
    writeFileSync(`public/assets/models/${id}.glb`, glb);
    manifest[id] = { file: `/assets/models/${id}.glb`, bytes: glb.byteLength, triangles, vertices, materials, min, max, size: [max[0] - min[0], max[1] - min[1], max[2] - min[2]] };
  };
  // Approved microbot is NOT rebuilt here; its measured bounds come from its inspection report.
  const approved = JSON.parse(readFileSync('public/assets/models/microbot.inspection.json', 'utf8')) as { bytes: number; triangles: number; vertices: number; materials: string[]; boundsMin: V3; boundsMax: V3 };
  manifest.microbot = { file: '/assets/models/microbot.glb', bytes: approved.bytes, triangles: approved.triangles, vertices: approved.vertices, materials: approved.materials, min: approved.boundsMin, max: approved.boundsMax, size: approved.boundsMax.map((v, i) => v - approved.boundsMin[i]!) };
  for (const [id, lod] of Object.entries(MICROBOT_LODS)) {
    const { primitives, materials } = buildMicrobot(lod);
    const glb = writeGlb({ name: id, primitives, materials });
    const min: V3 = [Infinity, Infinity, Infinity], max: V3 = [-Infinity, -Infinity, -Infinity];
    let t = 0, v = 0;
    for (const p of primitives) { t += p.geometry.indices.length / 3; v += p.geometry.positions.length / 3; for (let i = 0; i < p.geometry.positions.length; i += 3) for (let k = 0; k < 3; k += 1) { min[k] = Math.min(min[k]!, p.geometry.positions[i + k]!); max[k] = Math.max(max[k]!, p.geometry.positions[i + k]!); } }
    record(id, glb, t, v, min, max, materials.map((m) => m.name));
  }
  for (const build of BUILDS) {
    const asset = build();
    const out = asset.export();
    record(asset.id, out.glb, out.triangles, out.vertices, out.min, out.max, out.materials);
    console.log(`${asset.id.padEnd(28)} tris ${String(out.triangles).padStart(6)}  size ${out.min.map((m, i) => (out.max[i]! - m).toFixed(2)).join(' × ')} m  ${(out.glb.byteLength / 1024).toFixed(0)} KB`);
  }
  writeFileSync('public/assets/models/manifest.json', JSON.stringify(manifest, null, 2) + '\n');
  writeAssetSizes();
}
