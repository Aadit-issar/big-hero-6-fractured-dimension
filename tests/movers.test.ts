import { describe, expect, it } from 'vitest';
import { DEFAULT_SEED } from '../src/simulation/constants';
import { SimulationEngine } from '../src/simulation/simulationEngine';
import { DISTURBANCES, MOVER_DEFS, MOVER_STEP, MoverSystem, moverQuaternion, moversFor } from '../src/world/movers';

const engine = new SimulationEngine(DEFAULT_SEED);
const dist = (a: readonly number[], b: readonly number[]) => Math.hypot(a[0]! - b[0]!, a[1]! - b[1]!, a[2]! - b[2]!);
const fresh = () => new MoverSystem(engine.field, engine.mapping);
const positions = (s: MoverSystem) => s.states().map(m => m.position);

describe('movers: deterministic dynamical extension', () => {
  it('is a pure function of the tick count (two systems agree exactly)', () => {
    const a = fresh(), b = fresh();
    a.syncTo(37.25); b.syncTo(12); b.syncTo(37.25);
    expect(positions(a)).toEqual(positions(b));
    expect(a.tick).toBe(Math.floor(37.25 / MOVER_STEP));
  });

  it('replays exactly after a rewind (reset behaviour)', () => {
    const s = fresh();
    s.syncTo(20);
    const at20 = positions(s);
    s.syncTo(45);
    s.syncTo(20);
    expect(positions(s)).toEqual(at20);
    s.reset();
    expect(s.tick).toBe(0);
    s.syncTo(20);
    expect(positions(s)).toEqual(at20);
  });

  it('keeps every mover finite, moving, and inside the explorable cavern for three minutes', () => {
    const s = fresh();
    for (let t = 0; t <= 180; t += 1) {
      s.syncTo(t);
      for (const m of s.states()) {
        expect(m.position.every(Number.isFinite)).toBe(true);
        expect(Math.abs(m.position[0])).toBeLessThan(70);
        expect(m.position[1]).toBeGreaterThan(-20);
        expect(m.position[1]).toBeLessThan(45);
        expect(m.position[2]).toBeLessThan(15);
        expect(m.position[2]).toBeGreaterThan(-90);
      }
    }
  });

  it("Abigail's capsule travels at a speed Baymax can match, and never crosses an island's rock", () => {
    const s = fresh();
    const capsule = MOVER_DEFS.find(m => m.id === 'capsule-abigail')!;
    let prev: readonly number[] | null = null;
    let maxSpeed = 0, minClear = Infinity, path = 0;
    for (let t = 0; t <= 240; t += 0.5) {
      s.syncTo(t);
      const p = s.states().find(m => m.id === capsule.id)!.position;
      if (prev) { const v = dist(p, prev) / 0.5; maxSpeed = Math.max(maxSpeed, v); path += dist(p, prev); }
      prev = p;
      for (const i of engine.world.islands) minClear = Math.min(minClear, dist(p, engine.evaluateIsland(i, t)) - i.radius - i.height - capsule.radius);
    }
    expect(maxSpeed).toBeGreaterThan(2);
    expect(maxSpeed).toBeLessThan(8);
    expect(path).toBeGreaterThan(300);
    // The capsule's own bound may graze an island's bound, but its centre never enters the rock.
    expect(minClear + capsule.radius).toBeGreaterThan(0);
  });

  it('the field force is real: removing the coupling changes the path', () => {
    const defs = MOVER_DEFS.map(m => ({ ...m, fieldCoupling: 0 }));
    const coupled = fresh(), free = new MoverSystem(engine.field, engine.mapping, defs);
    let largest = 0;
    for (let t = 0; t <= 120; t += 2) { coupled.syncTo(t); free.syncTo(t); largest = Math.max(largest, dist(positions(coupled)[0]!, positions(free)[0]!)); }
    expect(largest).toBeGreaterThan(0.5);
  });

  it('the disturbance deflects a mover that crosses it and does nothing far away', () => {
    const none = new MoverSystem(engine.field, engine.mapping, MOVER_DEFS, []);
    const withZone = fresh();
    let largest = 0;
    for (let t = 0; t <= 150; t += 1) { none.syncTo(t); withZone.syncTo(t); largest = Math.max(largest, dist(positions(none)[0]!, positions(withZone)[0]!)); }
    expect(DISTURBANCES.length).toBeGreaterThan(0);
    expect(largest).toBeGreaterThan(1.5);
    const early = fresh(), noneEarly = new MoverSystem(engine.field, engine.mapping, MOVER_DEFS, []);
    early.syncTo(0.5); noneEarly.syncTo(0.5);
    expect(dist(positions(early)[3]!, positions(noneEarly)[3]!)).toBeLessThan(0.05);
  });

  it('orientation is analytic, unit length and time dependent', () => {
    const q0 = moverQuaternion(MOVER_DEFS[0]!, 0), q1 = moverQuaternion(MOVER_DEFS[0]!, 30);
    expect(Math.hypot(...q1)).toBeCloseTo(1, 12);
    expect(q0).not.toEqual(q1);
    expect(moverQuaternion(MOVER_DEFS[0]!, 30)).toEqual(q1);
  });

  it('does not alter the engine: islands and folds are untouched by attaching movers', () => {
    const e = new SimulationEngine(DEFAULT_SEED);
    const before = e.world.islands.map(i => e.evaluateIsland(i, 12));
    const folds = e.network.getConnections(3).map(c => `${c.id}:${c.state}`);
    e.advance(0.1);
    moversFor(e);
    expect(e.world.islands.map(i => e.evaluateIsland(i, 12))).toEqual(before);
    expect(e.network.getConnections(3).map(c => `${c.id}:${c.state}`)).toEqual(folds);
  });

  it('moversFor follows the engine clock and reset', () => {
    const e = new SimulationEngine(DEFAULT_SEED);
    for (let i = 0; i < 30; i += 1) e.advance(0.1);
    const a = moversFor(e);
    expect(a.tick).toBe(Math.floor((e.clock.time + 1e-9) / MOVER_STEP));
    e.reset();
    const b = moversFor(e);
    expect(b).toBe(a);
    expect(b.tick).toBe(0);
  });
});
