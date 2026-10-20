import { SimulationEngine } from '../src/simulation/simulationEngine';
import { DEFAULT_SEED } from '../src/simulation/constants';
import { MOVER_DEFS, MoverSystem, foldSourceFor } from '../src/world/movers';

/** Survey of every mover (original + overhaul): speed range, 95th-percentile and maximum turn rate / curvature, island clearance beyond rock + radius,
 * nearest approach to the capsule, and seconds of influence by each disturbance. Usage: tsx scripts/mover-survey.ts [seconds=300] */
const seconds = Number(process.argv[2] ?? 300);
const e = new SimulationEngine(DEFAULT_SEED);
const ms = new MoverSystem(e.field, e.mapping, MOVER_DEFS, undefined, foldSourceFor(e));
const dt = 0.25, D = ms.disturbances.length;
const track = MOVER_DEFS.map(() => ({ pts: [] as number[][], clear: Infinity, cap: Infinity, infl: new Array<number>(D).fill(0), fold: 0 }));
for (let t = 0; t <= seconds; t += dt) {
  ms.syncTo(t);
  const states = ms.states();
  states.forEach((s, i) => {
    const tr = track[i]!;
    tr.pts.push([...s.position]);
    if (t % 1 === 0) for (const isl of e.world.islands) { const w = e.evaluateIsland(isl, t); tr.clear = Math.min(tr.clear, Math.hypot(s.position[0] - w[0], s.position[1] - w[1], s.position[2] - w[2]) - isl.radius - isl.height - MOVER_DEFS[i]!.radius); }
    if (i > 0) tr.cap = Math.min(tr.cap, Math.hypot(s.position[0] - states[0]!.position[0], s.position[1] - states[0]!.position[1], s.position[2] - states[0]!.position[2]));
    for (let d = 0; d < D; d += 1) if (ms.influence[i * D + d]! > 0.15) tr.infl[d]! += dt;
    if (ms.foldActivity[i]! > 0.1) tr.fold += dt;
  });
}
console.log(`survey over ${seconds} s (${(seconds / dt).toFixed(0)} samples at ${dt} s); disturbances: ${ms.disturbances.map(d => d.id).join(', ')}`);
console.log('id'.padEnd(20), 'speed min/mean/max'.padEnd(22), 'p95turn  maxturn  maxcurv(1/m)  clear  capDist  influence s (per disturbance)   fold s');
MOVER_DEFS.forEach((m, i) => {
  const { pts, clear, cap, infl, fold } = track[i]!;
  const speed: number[] = [], turn: number[] = [], curv: number[] = [];
  for (let k = 1; k < pts.length - 1; k += 1) {
    const v1 = pts[k]!.map((x, j) => (x - pts[k - 1]![j]!) / dt), v2 = pts[k + 1]!.map((x, j) => (x - pts[k]![j]!) / dt);
    const s1 = Math.hypot(...v1), s2 = Math.hypot(...v2); speed.push(s1);
    const ang = Math.acos(Math.max(-1, Math.min(1, (v1[0]! * v2[0]! + v1[1]! * v2[1]! + v1[2]! * v2[2]!) / (s1 * s2 + 1e-12))));
    turn.push(ang / dt); if (s1 > 0.3) curv.push(ang / (s1 * dt));
  }
  const sorted = [...turn].sort((a, b) => a - b);
  const mean = speed.reduce((a, b) => a + b, 0) / speed.length;
  console.log(m.id.padEnd(20), `${Math.min(...speed).toFixed(2)}/${mean.toFixed(2)}/${Math.max(...speed).toFixed(2)}`.padEnd(22), sorted[Math.floor(sorted.length * 0.95)]!.toFixed(3).padStart(7), Math.max(...turn).toFixed(2).padStart(8), Math.max(...curv).toFixed(2).padStart(11), clear.toFixed(1).padStart(7), (i === 0 ? '   -' : cap.toFixed(1)).padStart(8), infl.map(x => x.toFixed(0).padStart(4)).join(' '), fold.toFixed(0).padStart(8));
});
