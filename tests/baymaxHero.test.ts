import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { Quaternion, Vector3 } from 'three';
import { FlightDynamics, POSE_TUNING, PoseDynamics, HERO_NODES, HERO_SOCKET_NODES, wingTarget, defaultHeroBase, BAYMAX_HERO_FILES } from '../src/baymax/index';
import type { FlightState } from '../src/baymax/index';

interface GltfNode { name?: string; children?: number[]; translation?: number[]; rotation?: number[]; mesh?: number }
interface Gltf {
  nodes: GltfNode[];
  meshes: { primitives: { attributes: { POSITION: number }; indices: number; material: number }[] }[];
  accessors: { count: number; min?: number[]; max?: number[] }[];
  materials: { name: string; extensions?: Record<string, unknown> }[];
  images?: { bufferView: number; mimeType: string }[];
  bufferViews: { byteOffset?: number; byteLength: number }[];
  scenes: { nodes: number[] }[];
}

function readGlb(file: string): { json: Gltf; bin: Buffer } {
  const b = readFileSync(`public/assets/models/baymax_hero/${file}`);
  expect(b.readUInt32LE(0)).toBe(0x46546c67);
  const jl = b.readUInt32LE(12);
  const json = JSON.parse(b.subarray(20, 20 + jl).toString('utf8')) as Gltf;
  const bin = b.subarray(20 + jl + 8);
  return { json, bin };
}

const triangles = (g: Gltf): number => g.nodes.reduce((t, n) => t + (n.mesh === undefined ? 0 : g.meshes[n.mesh]!.primitives.reduce((a, p) => a + g.accessors[p.indices]!.count / 3, 0)), 0);
const byName = (g: Gltf, name: string): GltfNode | undefined => g.nodes.find((n) => n.name === name);
const parentOf = (g: Gltf, i: number): number => g.nodes.findIndex((n) => n.children?.includes(i));
const pathTo = (g: Gltf, name: string): string[] => {
  let i = g.nodes.findIndex((n) => n.name === name);
  const out: string[] = [];
  while (i >= 0) { out.unshift(g.nodes[i]!.name ?? '?'); i = parentOf(g, i); }
  return out;
};

describe('armoured Baymax GLB (static checks on the shipped files)', () => {
  const hero = readGlb(BAYMAX_HERO_FILES.high);
  const lod = readGlb(BAYMAX_HERO_FILES.low);

  it('keeps the triangle, material and texture budgets', () => {
    expect(triangles(hero.json)).toBeGreaterThan(55_000);
    expect(triangles(hero.json)).toBeLessThanOrEqual(100_000);
    expect(triangles(lod.json)).toBeLessThanOrEqual(20_000);
    expect(hero.json.materials.length).toBeLessThanOrEqual(10);
    expect(lod.json.materials.length).toBe(hero.json.materials.length);
    expect(hero.json.materials.some((m) => m.extensions && 'KHR_materials_clearcoat' in m.extensions)).toBe(true);
    for (const [g, bin, max] of [[hero.json, hero.bin, 2048], [lod.json, lod.bin, 1024]] as const) {
      for (const im of g.images ?? []) {
        const bv = g.bufferViews[im.bufferView]!;
        const o = bv.byteOffset ?? 0;
        expect(bin.subarray(o + 1, o + 4).toString('latin1')).toBe('PNG');
        expect(bin.readUInt32BE(o + 16)).toBeLessThanOrEqual(max);
        expect(bin.readUInt32BE(o + 20)).toBeLessThanOrEqual(max);
      }
    }
  });

  it('has the required articulation hierarchy, identical in both LODs', () => {
    for (const g of [hero.json, lod.json]) {
      for (const n of HERO_NODES) expect(byName(g, n), n).toBeDefined();
      expect(pathTo(g, 'head').slice(-4)).toEqual(['baymax_root', 'pelvis', 'torso', 'head']);
      for (const s of ['L', 'R']) {
        expect(pathTo(g, `hand_${s}`).slice(-5)).toEqual(['torso', `shoulder_${s}`, `upperarm_${s}`, `forearm_${s}`, `hand_${s}`]);
        expect(pathTo(g, `wing_${s}`).slice(-2)).toEqual(['torso', `wing_${s}`]);
        expect(pathTo(g, `foot_${s}`).slice(-4)).toEqual(['pelvis', `thigh_${s}`, `shin_${s}`, `foot_${s}`]);
      }
    }
    const names = (g: Gltf) => g.nodes.map((n) => n.name).filter((n) => !n?.endsWith('_mesh')).sort();
    expect(names(lod.json)).toEqual(names(hero.json));
    for (const n of HERO_NODES) expect(byName(lod.json, n)!.translation ?? [0, 0, 0]).toEqual(byName(hero.json, n)!.translation ?? [0, 0, 0]);
  });

  it('places mirrored limbs symmetrically (his left is -X) and sockets on the right nozzles', () => {
    const t = (n: string) => byName(hero.json, n)!.translation ?? [0, 0, 0];
    expect(t('shoulder_R')[0]).toBeGreaterThan(0.5);
    expect(t('shoulder_L')[0]).toBeCloseTo(-t('shoulder_R')[0]!, 5);
    expect(t('wing_R')[0]).toBeGreaterThan(0.2);
    expect(t('wing_L')[0]).toBeCloseTo(-t('wing_R')[0]!, 5);
    const dir = new Vector3(), q = new Quaternion();
    for (const [id, node] of Object.entries(HERO_SOCKET_NODES)) {
      const n = byName(hero.json, node)!;
      const r = n.rotation ?? [0, 0, 0, 1];
      dir.set(0, 0, 1).applyQuaternion(q.set(r[0]!, r[1]!, r[2]!, r[3]!));
      if (id.startsWith('pack')) { expect(dir.y).toBeLessThan(-0.4); expect(dir.z).toBeGreaterThan(0.6); } // aft and down, on the back
      else { expect(dir.y).toBeLessThan(-0.99); }
      expect(dir.length()).toBeCloseTo(1, 5);
    }
  });

  it('is about 2.2 m tall (soles to crown) with a ~3.4 m deployed span, origin mid torso', () => {
    const g = hero.json;
    const lo = [Infinity, Infinity, Infinity], hi = [-Infinity, -Infinity, -Infinity];
    const walk = (i: number, off: number[]): void => {
      const n = g.nodes[i]!;
      const o = [off[0]! + (n.translation?.[0] ?? 0), off[1]! + (n.translation?.[1] ?? 0), off[2]! + (n.translation?.[2] ?? 0)];
      if (n.mesh !== undefined) {
        for (const p of g.meshes[n.mesh]!.primitives) {
          const a = g.accessors[p.attributes.POSITION]!;
          for (let k = 0; k < 3; k++) { lo[k] = Math.min(lo[k]!, a.min![k]! + o[k]!); hi[k] = Math.max(hi[k]!, a.max![k]! + o[k]!); }
        }
      }
      for (const c of n.children ?? []) walk(c, o);
    };
    for (const r of g.scenes[0]!.nodes) walk(r, [0, 0, 0]);
    expect(hi[1]! - lo[1]!).toBeGreaterThan(2.15);
    expect(hi[1]! - lo[1]!).toBeLessThan(2.4);
    expect(lo[1]!).toBeGreaterThan(-1.2);
    expect(lo[1]!).toBeLessThan(-1.05); // soles sit about 1.1 m below the mid-torso origin
    expect(hi[0]! - lo[0]!).toBeGreaterThan(3.2);
    expect(hi[0]! - lo[0]!).toBeLessThan(3.7);
    expect(lo[2]!).toBeLessThan(-0.3); // front (-Z) is occupied by the chest and face, the pack and wings lie at +Z
    expect(hi[2]!).toBeGreaterThan(0.5);
  });

  it('serves from the app-relative default base', () => {
    expect(defaultHeroBase()).toMatch(/assets\/models\/baymax_hero\/$/);
  });
});

describe('pose dynamics', () => {
  const idle: FlightState = { velocity: [0, 0, 0], acceleration: [0, 0, 0], yawRate: 0, boost: false };
  const settle = (s: FlightState, steps = 360) => {
    const f = new FlightDynamics(), p = new PoseDynamics();
    const speed = Math.hypot(...s.velocity);
    let o = f.step(1 / 60, s), po = p.step(1 / 60, speed, o);
    for (let i = 1; i < steps; i++) { o = f.step(1 / 60, s); po = p.step(1 / 60, speed, o); }
    return { o, po: { ...po } };
  };

  it('keeps the wings folded at rest and deploys them in flight and boost', () => {
    expect(wingTarget(0, 0)).toBe(0);
    expect(wingTarget(POSE_TUNING.deployHi + 1, 0)).toBe(1);
    expect(wingTarget(0, 1)).toBe(1);
    expect(settle(idle).po.wing).toBeLessThan(0.01);
    expect(settle({ ...idle, velocity: [0, 0, -14] }).po.wing).toBeGreaterThan(0.99);
    expect(settle({ ...idle, boost: true }).po.wing).toBeGreaterThan(0.99);
  });

  it('is critically damped: wing deployment never overshoots and is smooth', () => {
    const f = new FlightDynamics(), p = new PoseDynamics();
    const s: FlightState = { ...idle, velocity: [0, 0, -14] };
    let prev = 0, max = 0, maxStep = 0;
    for (let i = 0; i < 300; i++) {
      const w = p.step(1 / 60, 14, f.step(1 / 60, s)).wing;
      max = Math.max(max, w); maxStep = Math.max(maxStep, Math.abs(w - prev)); prev = w;
    }
    expect(max).toBeLessThanOrEqual(1 + 1e-9);
    expect(maxStep).toBeLessThan(0.05);
  });

  it('swings arms and legs back only with speed (no free-running motion)', () => {
    const rest = settle(idle).po;
    expect(rest.arm).toBeLessThan(0.01);
    expect(rest.leg).toBeLessThan(0.01);
    const fast = settle({ ...idle, velocity: [0, 0, -16] }).po;
    expect(fast.arm).toBeGreaterThan(0.5);
    expect(settle({ ...idle, velocity: [0, 0, -16] }).po).toEqual(fast); // deterministic
  });

  it('drops the toes under foot thrust (climb)', () => {
    expect(settle({ ...idle, velocity: [0, 4, 0], acceleration: [0, 3, 0] }).po.toe).toBeGreaterThan(0.3);
    expect(settle(idle).po.toe).toBeLessThan(0.05);
  });
});
