import { describe, expect, it } from 'vitest';
import { Box3, Quaternion, Vector3 } from 'three';
import { BAYMAX_ASSET, FlightDynamics, SOCKET_IDS, buildBaymax, computeThrust, flicker, plumeDimensions, worldToLocal } from '../src/baymax/index';
import { createBaymaxFx, updateBaymaxFx } from '../src/baymax/fx';
import type { FlightState, SocketId } from '../src/baymax/index';

const hover: FlightState = { velocity: [0, 0, 0], acceleration: [0, 0, 0], yawRate: 0, boost: false };
const T = (s: Partial<FlightState>, q: readonly [number, number, number, number] = [0, 0, 0, 1]) => computeThrust({ ...hover, ...s }, q, 0);
const pack = (o: ReturnType<typeof T>) => (o.sockets['pack-left'] + o.sockets['pack-right']) / 2;
const foot = (o: ReturnType<typeof T>) => (o.sockets['foot-left'] + o.sockets['foot-right']) / 2;

describe('computeThrust', () => {
  it('idles with low stabilising thrust and no lean', () => {
    const o = T({});
    for (const id of SOCKET_IDS) { expect(o.sockets[id]).toBeGreaterThan(0.1); expect(o.sockets[id]).toBeLessThan(0.4); }
    expect(o.lean.pitch).toBeCloseTo(0, 9);
    expect(o.lean.roll).toBeCloseTo(0, 9);
  });
  it('forward acceleration brightens the pack and leans forward', () => {
    const o = T({ acceleration: [0, 0, -6], velocity: [0, 0, -5] });
    expect(pack(o)).toBeGreaterThan(pack(T({})) + 0.3);
    expect(o.lean.pitch).toBeGreaterThan(0.2);
  });
  it('braking leans back and flares the feet', () => {
    const o = T({ acceleration: [0, 0, 6], velocity: [0, 0, -5] });
    expect(o.lean.pitch).toBeLessThan(-0.1);
    expect(foot(o)).toBeGreaterThan(foot(T({})) + 0.4);
  });
  it('turning is differential and banks into the turn', () => {
    const left = T({ yawRate: 1.2 }); // counter-clockwise from above: turning left
    expect(left.sockets['pack-right']).toBeGreaterThan(left.sockets['pack-left'] + 0.2);
    expect(left.lean.roll).toBeLessThan(0); // banks left
    const right = T({ yawRate: -1.2 });
    expect(right.sockets['pack-left']).toBeGreaterThan(right.sockets['pack-right'] + 0.2);
    expect(right.lean.roll).toBeGreaterThan(0);
  });
  it('climbing fires the feet; descending reduces them', () => {
    expect(foot(T({ acceleration: [0, 3, 0], velocity: [0, 3, 0] }))).toBeGreaterThan(foot(T({})) + 0.3);
    expect(foot(T({ acceleration: [0, -2, 0], velocity: [0, -3, 0] }))).toBeLessThan(foot(T({})));
  });
  it('boost is a strong state', () => {
    expect(pack(T({ boost: true }))).toBeGreaterThan(pack(T({})) + 0.4);
  });
  it('uses the body frame: yawed Baymax accelerating along his own forward matches the identity case', () => {
    const q = new Quaternion().setFromAxisAngle(new Vector3(0, 1, 0), Math.PI / 2); // -Z forward becomes -X
    const o = T({ acceleration: [-6, 0, 0], velocity: [-5, 0, 0] }, [q.x, q.y, q.z, q.w]);
    const ref = T({ acceleration: [0, 0, -6], velocity: [0, 0, -5] });
    for (const id of SOCKET_IDS) expect(o.sockets[id]).toBeCloseTo(ref.sockets[id], 9);
    expect(o.lean.pitch).toBeCloseTo(ref.lean.pitch, 9);
    const l = worldToLocal([-1, 0, 0], [q.x, q.y, q.z, q.w]);
    expect(l[2]).toBeCloseTo(-1, 9);
  });
  it('bounds outputs to 0..1 and is deterministic', () => {
    const s: FlightState = { velocity: [30, 30, 30], acceleration: [50, 50, -50], yawRate: 9, boost: true };
    const a = computeThrust(s, [0, 0, 0, 1], 1.3);
    const b = computeThrust(s, [0, 0, 0, 1], 1.3);
    expect(a).toEqual(b);
    for (const id of SOCKET_IDS) { expect(a.sockets[id]).toBeGreaterThanOrEqual(0); expect(a.sockets[id]).toBeLessThanOrEqual(1); }
    expect(flicker(0.7, 2)).toBe(flicker(0.7, 2));
  });
  it('hover bob is gentle and fades at speed', () => {
    const slow = Math.max(...Array.from({ length: 200 }, (_, i) => Math.abs(computeThrust(hover, [0, 0, 0, 1], i * 0.05).hoverBob)));
    expect(slow).toBeGreaterThan(0.01);
    expect(slow).toBeLessThan(0.05);
    expect(Math.abs(computeThrust({ ...hover, velocity: [0, 0, -10] }, [0, 0, 0, 1], 0.5).hoverBob)).toBe(0);
  });
});

describe('FlightDynamics', () => {
  const run = (steps: number, s: FlightState, d = new FlightDynamics()) => { let o = d.step(1 / 60, s); for (let i = 1; i < steps; i++) o = d.step(1 / 60, s); return { o, d }; };
  it('converges to the target without overshooting (critically damped)', () => {
    const s: FlightState = { ...hover, acceleration: [0, 0, -6], velocity: [0, 0, -5] };
    const target = computeThrust(s, [0, 0, 0, 1], 0).sockets['pack-left'];
    const d = new FlightDynamics();
    let max = 0;
    for (let i = 0; i < 300; i++) max = Math.max(max, d.step(1 / 60, s).sockets['pack-left']);
    expect(max).toBeLessThanOrEqual(target + 1e-3);
    expect(d.step(1 / 60, s).sockets['pack-left']).toBeCloseTo(target, 3);
  });
  it('boost attacks faster than it decays', () => {
    const d = new FlightDynamics();
    const on: FlightState = { ...hover, boost: true };
    for (let i = 0; i < 12; i++) d.step(1 / 60, on); // 0.2 s
    const attack = d.step(1 / 60, on).boost;
    run(120, on, d);
    let o = d.step(1 / 60, hover);
    for (let i = 0; i < 12; i++) o = d.step(1 / 60, hover);
    expect(attack).toBeGreaterThan(0.6);
    expect(o.boost).toBeGreaterThan(0.2); // slower decay
  });
  it('is deterministic', () => {
    const s: FlightState = { ...hover, yawRate: 0.7, acceleration: [1, 2, -3], velocity: [0, 1, -4] };
    expect(run(90, s).o.sockets['pack-left']).toBe(run(90, s).o.sockets['pack-left']);
  });
});

describe('Baymax model and sockets', () => {
  const rig = buildBaymax();
  rig.root.updateMatrixWorld(true);
  it('is about 1.9 m tall, centred, faces -Z', () => {
    const box = new Box3().setFromObject(rig.body);
    // Exclude nothing: sockets are Object3D without geometry so the box covers meshes only.
    expect(box.max.y - box.min.y).toBeGreaterThan(1.85);
    expect(box.max.y - box.min.y).toBeLessThan(1.95);
    expect(box.min.y).toBeCloseTo(-0.8, 1);
    const eye = rig.body.getObjectByName('eye-left')!;
    expect(eye.position.z).toBeLessThan(0);
    expect(rig.body.getObjectByName('pack')!.position.z).toBeGreaterThan(0);
    expect(BAYMAX_ASSET.forward).toEqual([0, 0, -1]);
  });
  it('has four sockets located at the nozzles, exhausting away from the body along +Z of the socket', () => {
    expect(rig.sockets.map((s) => s.id).sort()).toEqual(['foot-left', 'foot-right', 'pack-left', 'pack-right']);
    const dir = new Vector3(), pos = new Vector3();
    for (const s of rig.sockets) {
      s.object.getWorldPosition(pos);
      s.object.getWorldDirection(dir); // +Z of the object
      expect(dir.y).toBeLessThan(-0.5); // exhaust points downward
      if (s.id.startsWith('pack')) { expect(dir.z).toBeGreaterThan(0.3); expect(pos.z).toBeGreaterThan(0.3); } // aft, on the back
      else expect(pos.y).toBeLessThan(-0.75);
      expect(s.maxThrust).toBeGreaterThan(0);
      expect(dir.length()).toBeCloseTo(1, 6);
    }
    const byId = (id: SocketId) => rig.sockets.find((s) => s.id === id)!.object.position.x;
    expect(byId('pack-left')).toBeLessThan(0);
    expect(byId('pack-right')).toBeGreaterThan(0);
  });
  it('keeps the triangle and material budget', () => {
    let tris = 0;
    const mats = new Set<unknown>();
    rig.root.traverse((o) => {
      const m = o as { isMesh?: boolean; geometry?: { index: { count: number } | null; attributes: { position: { count: number } } }; material?: unknown };
      if (!m.isMesh || !m.geometry) return;
      tris += (m.geometry.index ? m.geometry.index.count : m.geometry.attributes.position.count) / 3;
      mats.add(m.material);
    });
    expect(tris).toBeLessThan(40_000);
    expect(mats.size).toBeLessThanOrEqual(6);
  });
  it('plumes follow the sockets and scale with thrust within a fixed mesh budget', () => {
    const fx = createBaymaxFx(rig.sockets);
    expect(fx.meshCount).toBe(12);
    const zero = { sockets: { 'pack-left': 0, 'pack-right': 0, 'foot-left': 0, 'foot-right': 0 }, lean: { pitch: 0, roll: 0 }, hoverBob: 0, boost: 0 };
    updateBaymaxFx(fx, rig.sockets, zero, 0);
    expect(fx.parts['pack-left'].plume.visible).toBe(false);
    updateBaymaxFx(fx, rig.sockets, { ...zero, sockets: { ...zero.sockets, 'pack-left': 1 } }, 0);
    expect(fx.parts['pack-left'].plume.visible).toBe(true);
    expect(fx.parts['pack-left'].plume.parent).toBe(rig.sockets.find((s) => s.id === 'pack-left')!.object);
    expect(plumeDimensions(1, 0, 0.07).length).toBeGreaterThan(plumeDimensions(0.3, 0, 0.07).length * 2);
    fx.dispose();
  });
  it('disposes', () => { rig.dispose(); });
});
