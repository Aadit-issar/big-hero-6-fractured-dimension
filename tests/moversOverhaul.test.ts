import { describe, expect, it } from 'vitest';
import { DEFAULT_SEED } from '../src/simulation/constants';
import { SimulationEngine } from '../src/simulation/simulationEngine';
import {
  CORE_MOVER_DEFS, DISTURBANCES, FOLD_RANGE, MOVER_DEFS, MOVER_STEP, OVERHAUL_MOVER_DEFS, MoverSystem,
  disturbanceAcceleration, disturbanceFrame, foldSourceFor, frameAcceleration, moverQuaternion, moversFor,
} from '../src/world/movers';
import type { DisturbanceDef, FoldSource, MoverDef } from '../src/world/movers';
import { TRAIL_CAPACITY, TRAIL_STRIDE, TrailBuffer } from '../src/world/trail';
import { FLOW_LINES_PER_DISTURBANCE, FLOW_POINTS, flowScale, flowSeeds, traceFlowLine } from '../src/world/flowLines';
import { MoverSystem as BaselineSystem, MOVER_DEFS as BASELINE_DEFS, DISTURBANCES as BASELINE_DISTURBANCES, moverQuaternion as baselineQuaternion } from './fixtures/moversBaseline';

const engine = new SimulationEngine(DEFAULT_SEED);
const folds = foldSourceFor(engine);
const full = () => new MoverSystem(engine.field, engine.mapping, MOVER_DEFS, DISTURBANCES, folds);
const dist = (a: readonly number[], b: readonly number[]) => Math.hypot(a[0]! - b[0]!, a[1]! - b[1]!, a[2]! - b[2]!);
const idx = (id: string) => MOVER_DEFS.findIndex(m => m.id === id);
const dump = (t: TrailBuffer): number[] => { const o = new Float64Array(3), r: number[] = []; for (let a = 0; a < t.length; a += 1) { t.read(a, o); r.push(o[0]!, o[1]!, o[2]!); } return r; };
const NEW_IDS = OVERHAUL_MOVER_DEFS.map(m => m.id);

describe('overhaul: the original movers are untouched', () => {
  it('keeps the first four definitions identical to the frozen baseline and in order', () => {
    expect(CORE_MOVER_DEFS).toEqual(BASELINE_DEFS);
    expect(MOVER_DEFS.slice(0, 4)).toEqual(BASELINE_DEFS);
    expect(DISTURBANCES[0]).toEqual(BASELINE_DISTURBANCES[0]);
    expect(MOVER_DEFS.length).toBe(11);
  });

  it("Abigail's capsule (and the other three) follow a bit-identical path for t = 0 to 300 s", () => {
    const baseline = new BaselineSystem(engine.field, engine.mapping);
    const now = full();
    let compared = 0;
    for (let t = 0; t <= 300; t += 1) {
      baseline.syncTo(t); now.syncTo(t);
      const a = baseline.states(), b = now.states();
      for (let i = 0; i < 4; i += 1) {
        expect(b[i]!.id).toBe(a[i]!.id);
        expect(b[i]!.position).toEqual(a[i]!.position);
        expect(b[i]!.referencePosition).toEqual(a[i]!.referencePosition);
        expect(b[i]!.quaternion).toEqual(a[i]!.quaternion);
        compared += 1;
      }
    }
    expect(compared).toBe(4 * 301);
    expect(baselineQuaternion(BASELINE_DEFS[0]!, 12)).toEqual(moverQuaternion(MOVER_DEFS[0]!, 12));
  });

  it('the existing disturbance is still "all movers" by default, and no new disturbance lists the capsule', () => {
    expect(DISTURBANCES[0]!.affects).toBeUndefined();
    for (const d of DISTURBANCES.slice(1)) {
      expect(d.affects).toBeDefined();
      expect(d.affects).not.toContain('capsule-abigail');
      for (const id of CORE_MOVER_DEFS.map(m => m.id)) expect(d.affects).not.toContain(id);
    }
  });
});

describe('overhaul: determinism, replay and bounds of every mover', () => {
  it('two systems agree exactly, including trails, and a rewind replays exactly', () => {
    const a = full(), b = full();
    a.syncTo(41.5); b.syncTo(10); b.syncTo(41.5);
    expect(a.states()).toEqual(b.states());
    for (const m of OVERHAUL_MOVER_DEFS) expect(dump(a.trailOf(m.id)!)).toEqual(dump(b.trailOf(m.id)!));
    const at20 = (() => { const s = full(); s.syncTo(20); return s.states(); })();
    a.syncTo(60); a.syncTo(20);
    expect(a.states()).toEqual(at20);
    a.reset(); a.syncTo(20);
    expect(a.states()).toEqual(at20);
  });

  it('a long jump and a frame-by-frame advance give identical states and trails (trail window is a pure function of the tick)', () => {
    const jump = full(), stepped = full();
    jump.syncTo(30);
    for (let k = 1; k <= 30 * 60; k += 1) stepped.syncTo(k * MOVER_STEP);
    expect(jump.states()).toEqual(stepped.states());
    for (const m of OVERHAUL_MOVER_DEFS) {
      const x = jump.trailOf(m.id)!, y = stepped.trailOf(m.id)!;
      expect(x.length).toBe(y.length);
      expect(dump(x)).toEqual(dump(y));
    }
  });

  it('is finite, inside the cavern, clear of island rock and of the capsule, with bounded speed, for 300 s', () => {
    const s = full();
    const speedMax = new Map<string, number>(), clearMin = new Map<string, number>(), capMin = new Map<string, number>();
    let prev = s.states().map(m => m.position);
    const dt = 0.5;
    for (let t = dt; t <= 300; t += dt) {
      s.syncTo(t);
      const states = s.states();
      states.forEach((m, i) => {
        const def = MOVER_DEFS[i]!;
        expect(m.position.every(Number.isFinite)).toBe(true);
        expect(m.quaternion.every(Number.isFinite)).toBe(true);
        expect(Math.hypot(...m.quaternion)).toBeCloseTo(1, 9);
        expect(Math.abs(m.position[0])).toBeLessThan(70);
        expect(m.position[1]).toBeGreaterThan(-20);
        expect(m.position[1]).toBeLessThan(45);
        expect(m.position[2]).toBeLessThan(15);
        expect(m.position[2]).toBeGreaterThan(-90);
        speedMax.set(def.id, Math.max(speedMax.get(def.id) ?? 0, dist(m.position, prev[i]!) / dt));
        if (t % 1 === 0) for (const isl of engine.world.islands) clearMin.set(def.id, Math.min(clearMin.get(def.id) ?? 1e9, dist(m.position, engine.evaluateIsland(isl, t)) - isl.radius - isl.height - def.radius));
        if (i > 0) capMin.set(def.id, Math.min(capMin.get(def.id) ?? 1e9, dist(m.position, states[0]!.position)));
      });
      prev = states.map(m => m.position);
    }
    for (const m of OVERHAUL_MOVER_DEFS) {
      expect(speedMax.get(m.id)!, `${m.id} speed`).toBeLessThan(35);
      expect(clearMin.get(m.id)!, `${m.id} island clearance`).toBeGreaterThan(0);
      expect(capMin.get(m.id)!, `${m.id} capsule distance`).toBeGreaterThan(8);
    }
  });

  it('keeps reference velocity (the integrator\'s kinetic state) bounded', () => {
    const s = full();
    let peak = 0;
    for (let t = 0; t <= 200; t += 0.25) { s.syncTo(t); for (const m of MOVER_DEFS) { const v = s.referenceVelocity(m.id)!; peak = Math.max(peak, Math.hypot(...v)); } }
    expect(peak).toBeLessThan(10);
  });

  it('every new mover is visibly non-trivial: it moves, and the fast curve-benders turn hard', () => {
    const s = full();
    const pts = new Map<string, number[][]>();
    for (let t = 0; t <= 150; t += 0.25) { s.syncTo(t); s.states().forEach((m, i) => { const id = MOVER_DEFS[i]!.id; (pts.get(id) ?? pts.set(id, []).get(id)!).push([...m.position]); }); }
    const turn = (id: string) => {
      const p = pts.get(id)!, rates: number[] = [];
      for (let i = 1; i < p.length - 1; i += 1) {
        const v1 = p[i]!.map((x, k) => x - p[i - 1]![k]!), v2 = p[i + 1]!.map((x, k) => x - p[i]![k]!);
        const c = (v1[0]! * v2[0]! + v1[1]! * v2[1]! + v1[2]! * v2[2]!) / (Math.hypot(...v1) * Math.hypot(...v2) + 1e-12);
        rates.push(Math.acos(Math.max(-1, Math.min(1, c))) / 0.25);
      }
      return rates.sort((a, b) => a - b)[Math.floor(rates.length * 0.95)]!;
    };
    for (const id of NEW_IDS) { const p = pts.get(id)!; expect(Math.max(...p.map(q => dist(q, p[0]!)))).toBeGreaterThan(3); }
    for (const id of ['shard-glider', 'heatshield-skimmer', 'joint-orbiter', 'collar-ring']) expect(turn(id), id).toBeGreaterThan(0.5);
    // The capsule's own lane is the gentle one (p95 turn 0.15 rad/s): the new curve-benders are far more curved.
    expect(turn('capsule-abigail')).toBeLessThan(0.3);
  });
});

describe('overhaul: each new law acts on its movers and on nothing else', () => {
  const without = (id: string) => new MoverSystem(engine.field, engine.mapping, MOVER_DEFS, DISTURBANCES.filter(d => d.id !== id), folds);
  const intended: Record<string, string[]> = {};
  for (const d of DISTURBANCES.slice(1)) intended[d.id] = [...d.affects!];

  for (const d of DISTURBANCES.slice(1)) {
    it(`${d.id} (${d.kind}) deflects ${d.affects!.join(', ')} and leaves every other mover bit-identical`, () => {
      const a = full(), b = without(d.id);
      const largest = new Map<string, number>();
      for (let t = 0; t <= 150; t += 1) {
        a.syncTo(t); b.syncTo(t);
        a.states().forEach((m, i) => { const id = MOVER_DEFS[i]!.id; largest.set(id, Math.max(largest.get(id) ?? 0, dist(m.position, b.states()[i]!.position))); });
      }
      // At least one intended mover is strongly deflected and none of the others moves at all.
      expect(Math.max(...intended[d.id]!.map(id => largest.get(id)!))).toBeGreaterThan(1.0);
      for (const m of MOVER_DEFS) if (!intended[d.id]!.includes(m.id)) expect(largest.get(m.id), m.id).toBe(0);
    });
  }

  it('the capsule path is independent of every new disturbance and of the fold source', () => {
    const a = full(), b = new MoverSystem(engine.field, engine.mapping, MOVER_DEFS, DISTURBANCES.slice(0, 1), null);
    for (let t = 0; t <= 120; t += 1) { a.syncTo(t); b.syncTo(t); expect(a.states()[0]!.position).toEqual(b.states()[0]!.position); }
  });

  it('disturbance-1 still acts on every mover, new ones included', () => {
    const none = new MoverSystem(engine.field, engine.mapping, MOVER_DEFS, DISTURBANCES.slice(1), folds), a = full();
    let seen = 0;
    for (let t = 0; t <= 150; t += 1) { none.syncTo(t); a.syncTo(t); }
    a.states().forEach((m, i) => { if (dist(m.position, none.states()[i]!.position) > 0.01) seen += 1; });
    expect(seen).toBeGreaterThanOrEqual(4);
  });

  it('the pure force function agrees with the force the integrator applies (swirl, sheet, well)', () => {
    for (const d of DISTURBANCES) {
      const id = 'probe';
      const def: MoverDef = { ...MOVER_DEFS[1]!, id, centre: [d.centre[0] + 0.25, d.centre[1] + 0.1, d.centre[2] - 0.2], semiAxes: [1e-9, 1e-9, 1e-9], stiffness: 0, damping: 0, fieldCoupling: 0 };
      delete (def as { mass?: number }).mass;
      const dd: DisturbanceDef = { ...d, affects: [id] };
      const s = new MoverSystem(engine.field, engine.mapping, [def], [dd]);
      s.syncTo(0);
      const q = s.states()[0]!.referencePosition, v0 = [...s.referenceVelocity(id)!];
      s.syncTo(MOVER_STEP);
      const v1 = s.referenceVelocity(id)!;
      const a = disturbanceAcceleration(dd, q, 0);
      for (let k = 0; k < 3; k += 1) expect((v1[k]! - v0[k]!) / MOVER_STEP).toBeCloseTo(a[k]!, 8);
      expect(Math.hypot(...a)).toBeGreaterThan(1e-3);
    }
  });

  it('the fracture sheet\'s force flips sign across its surface and the well alternates attraction and repulsion', () => {
    const sheet = DISTURBANCES.find(d => d.kind === 'sheet')!, f = disturbanceFrame(sheet, 9), out = new Float64Array(3), out2 = new Float64Array(3);
    const side = (h: number, o: Float64Array) => frameAcceleration(f, sheet.centre[0] + h * f.nx, sheet.centre[1] + h * f.ny, sheet.centre[2] + h * f.nz, o);
    side(0.3, out); side(-0.3, out2);
    expect(out[0]! * out2[0]! + out[1]! * out2[1]! + out[2]! * out2[2]!).toBeLessThan(0);
    expect(Math.hypot(...out)).toBeGreaterThan(0.5);
    side(0, out);
    expect(Math.hypot(out[0]!, out[1]!, out[2]!)).toBeLessThan(1e-9);
    const well = DISTURBANCES.find(d => d.kind === 'well')!, radial = (t: number) => { const a = disturbanceAcceleration(well, [well.centre[0] + 0.5, well.centre[1], well.centre[2]], t); return a[0]; };
    const signs = new Set<number>();
    for (let t = 0; t < 40; t += 0.5) signs.add(Math.sign(radial(t)));
    expect(signs.has(1) && signs.has(-1)).toBe(true);
  });

  it('a precessing swirl really changes its axis over time', () => {
    const v = DISTURBANCES.find(d => d.precession)!;
    const f0 = disturbanceFrame(v, 0), f1 = disturbanceFrame(v, 3);
    expect(Math.hypot(f0.nx - f1.nx, f0.ny - f1.ny, f0.nz - f1.nz)).toBeGreaterThan(0.1);
    expect(Math.hypot(f1.nx, f1.ny, f1.nz)).toBeCloseTo(1, 12);
  });
});

describe('overhaul: per-mover parameters produce different paths under the same law', () => {
  const run = (def: MoverDef, ds: readonly DisturbanceDef[] = DISTURBANCES, seconds = 90) => {
    const s = new MoverSystem(engine.field, engine.mapping, [def], ds.map(d => (d.affects ? { ...d, affects: [def.id] } : d)), folds);
    const out: number[][] = [];
    for (let t = 0; t <= seconds; t += 1) { s.syncTo(t); out.push([...s.states()[0]!.position]); }
    return out;
  };
  const maxDiff = (a: number[][], b: number[][]) => Math.max(...a.map((p, i) => dist(p, b[i]!)));
  const collar = MOVER_DEFS[idx('collar-ring')]!;

  it('mass changes the response to a disturbance (heavier is deflected less)', () => {
    const light = run({ ...collar, mass: 0.5 }), heavy = run({ ...collar, mass: 6 }), none = run({ ...collar, mass: 1 }, DISTURBANCES.slice(0, 1));
    expect(maxDiff(light, heavy)).toBeGreaterThan(1);
    expect(maxDiff(heavy, none)).toBeLessThan(maxDiff(light, none));
  });

  it('quadratic drag changes the path', () => {
    expect(maxDiff(run({ ...collar, drag: 0 }), run({ ...collar, drag: 2.5 }))).toBeGreaterThan(0.5);
  });

  it('stiffness/damping, field coupling and lane shape change the path', () => {
    const base = run(collar, DISTURBANCES.slice(0, 1));
    expect(maxDiff(base, run({ ...collar, stiffness: 5, damping: 4 }, DISTURBANCES.slice(0, 1)))).toBeGreaterThan(0.3);
    expect(maxDiff(base, run({ ...collar, fieldCoupling: 0 }, DISTURBANCES.slice(0, 1)))).toBeGreaterThan(0.5);
    expect(maxDiff(base, run({ ...collar, lane: 'trefoil' }, DISTURBANCES.slice(0, 1)))).toBeGreaterThan(1);
    expect(maxDiff(run({ ...collar, lane: 'figure8' }, []), run({ ...collar, lane: 'trefoil' }, []))).toBeGreaterThan(1);
  });

  it('absent optional parameters reproduce the original law exactly (mass 1, drag 0 equal undefined)', () => {
    const plain = { ...MOVER_DEFS[1]!, id: 'plain' } as MoverDef;
    expect(run({ ...plain, mass: 1, drag: 0 }, DISTURBANCES.slice(0, 1))).toEqual(run(plain, DISTURBANCES.slice(0, 1)));
  });

  it('all seven new movers follow pairwise different trajectories', () => {
    const s = full(); s.syncTo(60);
    const p = s.states().slice(4).map(m => m.position);
    for (let i = 0; i < p.length; i += 1) for (let j = i + 1; j < p.length; j += 1) expect(dist(p[i]!, p[j]!)).toBeGreaterThan(1);
  });
});

describe('overhaul: fold-influenced motion (real engine.network state)', () => {
  it('the fold source is the engine\'s public connection state: valid and weighted by state', () => {
    const open = folds(0), later = folds(30);
    expect(open.length).toBeGreaterThan(3);
    expect(open.every(f => f.weight > 0 && f.weight <= 1)).toBe(true);
    expect(later.length).toBeLessThan(open.length);
    expect(folds(0)).toEqual(open);
  });

  it('fold-coupled movers change when folds are removed; others do not', () => {
    const a = full(), b = new MoverSystem(engine.field, engine.mapping, MOVER_DEFS, DISTURBANCES, null);
    let joint = 0;
    for (let t = 0; t <= 60; t += 1) {
      a.syncTo(t); b.syncTo(t);
      joint = Math.max(joint, dist(a.states()[idx('joint-orbiter')]!.position, b.states()[idx('joint-orbiter')]!.position));
      for (const m of MOVER_DEFS) if (!m.foldCoupling) expect(a.states()[idx(m.id)]!.position, m.id).toEqual(b.states()[idx(m.id)]!.position);
    }
    expect(joint).toBeGreaterThan(0.2);
    expect(MOVER_DEFS.filter(m => m.foldCoupling).map(m => m.id).sort()).toEqual(['heatshield-skimmer', 'joint-orbiter']);
  });

  it('the funnel draws an object towards a fold entry, and its pull follows the fold\'s state weight', () => {
    const entry: [number, number, number] = [1.0, 1.0, -3.0], exit: [number, number, number] = [2.6, 1.0, -3.0];
    const make = (weight: number): FoldSource => () => [{ id: 'F', entry, exit, weight }];
    const { spinCoupling: _unused, ...jointBase } = MOVER_DEFS[idx('joint-orbiter')]!; void _unused;
    const probe: MoverDef = { ...jointBase, id: 'probe', stiffness: 0, damping: 0, fieldCoupling: 0, mass: 1, foldCoupling: 3, centre: [entry[0] - 0.5, entry[1], entry[2]], semiAxes: [1e-9, 1e-9, 1e-9], omega: 0 };
    const pull = (w: number) => { const s = new MoverSystem(engine.field, engine.mapping, [probe], [], make(w)); s.syncTo(0); const q0 = s.states()[0]!.referencePosition; const v0 = [...s.referenceVelocity('probe')!]; s.syncTo(MOVER_STEP); const v1 = s.referenceVelocity('probe')!; return { q0, dv: [(v1[0]! - v0[0]!) / MOVER_STEP, (v1[1]! - v0[1]!) / MOVER_STEP, (v1[2]! - v0[2]!) / MOVER_STEP] }; };
    const full1 = pull(1), half = pull(0.5), off = pull(0);
    expect(full1.dv[0]!).toBeGreaterThan(0.5); // entry lies at +x of the probe, so the funnel accelerates it in +x
    expect(half.dv[0]!).toBeCloseTo(0.5 * full1.dv[0]!, 6);
    expect(Math.hypot(...off.dv)).toBeLessThan(1e-12);
    expect(FOLD_RANGE).toBeGreaterThan(0.3);
  });
});

describe('overhaul: attitude responds to the disturbance spin coupling', () => {
  it('movers with spinCoupling spin up where they are influenced; others keep the analytic attitude', () => {
    const s = full(); s.syncTo(80);
    const states = s.states();
    const coupled = MOVER_DEFS.filter(m => m.spinCoupling);
    expect(coupled.length).toBe(7);
    let differs = 0;
    for (const m of coupled) if (dist(states[idx(m.id)]!.quaternion, moverQuaternion(m, s.time)) > 1e-3) differs += 1;
    expect(differs).toBeGreaterThanOrEqual(4);
    for (const m of CORE_MOVER_DEFS) expect(states[idx(m.id)]!.quaternion).toEqual(moverQuaternion(m, s.time));
  });
});

describe('overhaul: trail buffer', () => {
  it('stores the newest samples first, wraps, and clears', () => {
    const b = new TrailBuffer(4), out = new Float64Array(3);
    expect(b.length).toBe(0); expect(b.read(0, out)).toBe(false);
    for (let i = 1; i <= 6; i += 1) b.push(i, 2 * i, 3 * i);
    expect(b.length).toBe(4);
    expect(b.read(0, out)).toBe(true); expect(Array.from(out)).toEqual([6, 12, 18]);
    b.read(3, out); expect(Array.from(out)).toEqual([3, 6, 9]);
    expect(b.read(4, out)).toBe(false); expect(b.read(-1, out)).toBe(false);
    b.clear(); expect(b.length).toBe(0); expect(b.read(0, out)).toBe(false);
    expect(() => new TrailBuffer(1)).toThrow(RangeError);
  });

  it('path length sums the polyline and does not allocate growth beyond capacity', () => {
    const b = new TrailBuffer(8);
    for (let i = 0; i < 100; i += 1) b.push(i, 0, 0);
    expect(b.length).toBe(8);
    expect(b.pathLength()).toBeCloseTo(7, 12);
    expect(b.data.length).toBe(24);
  });

  it('a mover trail holds its own past mapped positions: no future samples, newest equals the current position at stride ticks', () => {
    const s = full();
    s.syncTo(12 + 0.0001);
    const tick = s.tick - (s.tick % TRAIL_STRIDE);
    s.syncTo(tick * MOVER_STEP + 1e-9);
    expect(s.tick % TRAIL_STRIDE).toBe(0);
    const out = new Float64Array(3);
    for (const m of OVERHAUL_MOVER_DEFS) {
      const trail = s.trailOf(m.id)!;
      expect(trail.length).toBe(TRAIL_CAPACITY);
      trail.read(0, out);
      expect(Array.from(out)).toEqual(s.states()[idx(m.id)]!.position);
    }
    // Movers without `trail` have no buffer.
    expect(s.trailOf('capsule-abigail')).toBeNull();
    // The oldest sample is older than the newest by (capacity - 1) strides.
    const old = full(); old.syncTo((tick - (TRAIL_CAPACITY - 1) * TRAIL_STRIDE) * MOVER_STEP + 1e-9);
    const oldest = new Float64Array(3);
    s.trailOf('shard-glider')!.read(TRAIL_CAPACITY - 1, oldest);
    expect(Array.from(oldest)).toEqual(old.states()[idx('shard-glider')]!.position);
  });

  it('is cleared by a rewind and refilled deterministically', () => {
    const s = full(); s.syncTo(30);
    const filled = dump(s.trailOf('shard-glider')!);
    s.syncTo(1);
    expect(s.trailOf('shard-glider')!.length).toBeLessThan(TRAIL_CAPACITY);
    s.syncTo(30);
    expect(dump(s.trailOf('shard-glider')!)).toEqual(filled);
  });
});

describe('overhaul: flow lines', () => {
  const trace = (d: DisturbanceDef, t: number) => {
    const seeds = new Float64Array(FLOW_LINES_PER_DISTURBANCE * 3), ref = new Float64Array(FLOW_LINES_PER_DISTURBANCE * FLOW_POINTS * 3), mag = new Float64Array(FLOW_LINES_PER_DISTURBANCE * FLOW_POINTS), scratch = new Float64Array(3);
    flowSeeds(d, t, seeds);
    const f = disturbanceFrame(d, t);
    for (let i = 0; i < FLOW_LINES_PER_DISTURBANCE; i += 1) traceFlowLine(f, flowScale(d), seeds[i * 3]!, seeds[i * 3 + 1]!, seeds[i * 3 + 2]!, ref, mag, i * FLOW_POINTS, scratch);
    return { ref, mag, f };
  };

  it('is finite and deterministic for every disturbance', () => {
    for (const d of DISTURBANCES) {
      const a = trace(d, 11), b = trace(d, 11);
      expect(Array.from(a.ref).every(Number.isFinite)).toBe(true);
      expect(Array.from(a.mag).every(x => Number.isFinite(x) && x >= 0)).toBe(true);
      expect(Array.from(a.ref)).toEqual(Array.from(b.ref));
    }
  });

  it('swirl lines circle the axis; sheet lines on opposite sides run in opposite directions; well lines are radial', () => {
    const swirl = DISTURBANCES[0]!;
    const s = trace(swirl, 5), n = disturbanceFrame(swirl, 5);
    const radius = (p: number, line: number) => { const o = (line * FLOW_POINTS + p) * 3, r = [s.ref[o]! - swirl.centre[0], s.ref[o + 1]! - swirl.centre[1], s.ref[o + 2]! - swirl.centre[2]]; const al = r[0]! * n.nx + r[1]! * n.ny + r[2]! * n.nz; return Math.hypot(r[0]! - al * n.nx, r[1]! - al * n.ny, r[2]! - al * n.nz); };
    for (let line = 0; line < FLOW_LINES_PER_DISTURBANCE; line += 1) expect(Math.abs(radius(0, line) - radius(FLOW_POINTS - 1, line)) / radius(0, line)).toBeLessThan(0.35);

    const sheet = DISTURBANCES.find(d => d.kind === 'sheet')!, sh = trace(sheet, 9), f = sh.f;
    const dir = (line: number) => { const o0 = (line * FLOW_POINTS) * 3, o1 = (line * FLOW_POINTS + FLOW_POINTS - 1) * 3; return [sh.ref[o1]! - sh.ref[o0]!, sh.ref[o1 + 1]! - sh.ref[o0 + 1]!, sh.ref[o1 + 2]! - sh.ref[o0 + 2]!]; };
    // seeds i%4 = 0,1 lie at h < 0 and 2,3 at h > 0 (see flowSeeds): the first and the third have opposite slip.
    const d0 = dir(0), d2 = dir(2);
    expect(d0[0]! * f.sx + d0[1]! * f.sy + d0[2]! * f.sz).toBeLessThan(0);
    expect(d2[0]! * f.sx + d2[1]! * f.sy + d2[2]! * f.sz).toBeGreaterThan(0);
  });
});

describe('overhaul: engine untouched', () => {
  it('attaching the overhaul movers does not alter islands or folds, and moversFor wires the engine fold source', () => {
    const e = new SimulationEngine(DEFAULT_SEED);
    const before = e.world.islands.map(i => e.evaluateIsland(i, 12));
    const states = e.network.getConnections(3).map(c => `${c.id}:${c.state}`);
    e.advance(0.1);
    const system = moversFor(e);
    system.syncTo(20);
    expect(e.world.islands.map(i => e.evaluateIsland(i, 12))).toEqual(before);
    expect(e.network.getConnections(3).map(c => `${c.id}:${c.state}`)).toEqual(states);
    expect(system.defs.length).toBe(11);
    expect(system.disturbances.length).toBe(4);
  });
});
