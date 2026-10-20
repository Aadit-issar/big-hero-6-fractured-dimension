import { SimulationEngine } from '../src/simulation/simulationEngine';
import { MOVER_DEFS, MoverSystem } from '../src/world/movers';
import type { MoverDef } from '../src/world/movers';
import { createSeededRandom } from '../src/simulation/seededRandom';
import type { Vec3 } from '../src/simulation/types';

/** Offline design aid: pick the capsule lane whose world path is gentle enough for local motion models (low turn rate), clear of islands and
 * near the opening. Prints the best candidates; the chosen constants are then written into src/world/movers.ts by hand. */
const e = new SimulationEngine();
const base = MOVER_DEFS[0]!;
const rnd = createSeededRandom(4242);
const start: Vec3 = [-3.8, 10.3, 23.6];
const frameFrom = (yaw: number, tilt: number): readonly [Vec3, Vec3, Vec3] => {
  const cy = Math.cos(yaw), sy = Math.sin(yaw), ct = Math.cos(tilt), st = Math.sin(tilt);
  const e1: Vec3 = [cy, 0, -sy]; const e2: Vec3 = [sy * ct, st, cy * ct];
  const e3: Vec3 = [e1[1] * e2[2] - e1[2] * e2[1], e1[2] * e2[0] - e1[0] * e2[2], e1[0] * e2[1] - e1[1] * e2[0]];
  return [e1, e2, e3];
};
const results: { score: number; def: Partial<MoverDef>; stats: string }[] = [];
for (let n = 0; n < 900; n += 1) {
  const def: MoverDef = {
    ...base,
    centre: [(rnd() - 0.5) * 3, 1.2 + rnd() * 1.6, -0.5 - rnd() * 3.5],
    semiAxes: [4.4 + rnd() * 1.8, 2.4 + rnd() * 1.2, 0.3 + rnd() * 0.5],
    frame: frameFrom((rnd() - 0.5) * 3, (rnd() - 0.5) * 0.8),
    omega: 0.085 + rnd() * 0.04, phase: [rnd() * 6.28, rnd() * 6.28], fieldCoupling: 0.6 + rnd() * 1.2,
  };
  const ms = new MoverSystem(e.field, e.mapping, [def], []);
  const pts: Vec3[] = [];
  let minClear = Infinity;
  for (let t = 0; t <= 150; t += 0.5) {
    ms.syncTo(t);
    const p = ms.states()[0]!.position as Vec3;
    pts.push(p);
    if (t % 3 === 0) for (const i of e.world.islands) minClear = Math.min(minClear, Math.hypot(p[0] - e.evaluateIsland(i, t)[0], p[1] - e.evaluateIsland(i, t)[1], p[2] - e.evaluateIsland(i, t)[2]) - i.radius - i.height);
  }
  const turn: number[] = [], speed: number[] = [];
  for (let i = 1; i < pts.length - 1; i += 1) {
    const v1 = pts[i]!.map((x, k) => (x - pts[i - 1]![k]!) / 0.5), v2 = pts[i + 1]!.map((x, k) => (x - pts[i]![k]!) / 0.5);
    const s = Math.hypot(...v1); speed.push(s);
    const dot = v1[0]! * v2[0]! + v1[1]! * v2[1]! + v1[2]! * v2[2]!;
    turn.push(Math.acos(Math.max(-1, Math.min(1, dot / (s * Math.hypot(...v2) + 1e-9)))) / 0.5);
  }
  turn.sort((a, b) => a - b);
  const p95 = turn[Math.floor(turn.length * 0.95)]!, mean = speed.reduce((a, b) => a + b, 0) / speed.length;
  const d0 = Math.hypot(pts[0]![0] - start[0], pts[0]![1] - start[1], pts[0]![2] - start[2]);
  const yMin = Math.min(...pts.map(p => p[1])), yMax = Math.max(...pts.map(p => p[1])), zMax = Math.max(...pts.map(p => p[2])), zMin = Math.min(...pts.map(p => p[2]));
  const xs = pts.map(p => Math.abs(p[0]));
  const ok = minClear > 1.5 && mean > 2.9 && mean < 5 && d0 < 42 && yMin > -4 && yMax < 38 && zMax < 25 && zMin > -100 && Math.max(...xs) < 62 && Math.min(...speed) > 0.4;
  if (!ok) continue;
  results.push({ score: p95 + 0.02 * Math.max(0, d0 - 30), def: { centre: def.centre, semiAxes: def.semiAxes, omega: def.omega, phase: def.phase, fieldCoupling: def.fieldCoupling }, stats: `p95 turn ${p95.toFixed(3)} rad/s, mean speed ${mean.toFixed(2)}, d0 ${d0.toFixed(0)}, clearance ${minClear.toFixed(1)}, y ${yMin.toFixed(0)}..${yMax.toFixed(0)}, yaw/tilt frame ${JSON.stringify(def.frame.map(v => v.map(x => +x.toFixed(3))))}` });
}
results.sort((a, b) => a.score - b.score);
for (const r of results.slice(0, 5)) console.log(r.stats, JSON.stringify(r.def));
console.log('candidates', results.length);
