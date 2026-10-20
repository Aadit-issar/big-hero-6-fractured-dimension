import { SimulationEngine } from '../src/simulation/simulationEngine';
import { createSeededRandom } from '../src/simulation/seededRandom';
import { MOVER_DEFS, MoverSystem, foldSourceFor } from '../src/world/movers';
import type { DisturbanceDef, MoverDef } from '../src/world/movers';
import type { Vec3 } from '../src/simulation/types';

/** Offline design aid for the overhaul movers (not shipped): random-search each archetype's lane for visible interaction with its home
 * disturbance while staying inside the cavern, clear of islands and the capsule, with bounded speed. Prints the best lanes as TypeScript. */
const e = new SimulationEngine();
const folds = foldSourceFor(e);
export const NEW_DISTURBANCES: DisturbanceDef[] = [
  { id: 'fracture-sheet', label: 'Fracture slip sheet', centre: [4.3, 2.6, -4.2], sigma: 1.3, axis: [1, 0.2, 0.3], strength: 4.2, omega: 0.17, phase: 1.1, kind: 'sheet', direction: [0, 0.3, -1], thickness: 0.18, affects: ['shard-glider', 'heatshield-skimmer', 'slab-drifter'] },
  { id: 'breathing-well', label: 'Breathing well', centre: [-3.2, -0.8, -4.5], sigma: 0.85, axis: [0, 1, 0], strength: 5.5, omega: 0.35, phase: 0.4, kind: 'well', affects: ['forearm-tumbler', 'pipe-long'] },
  { id: 'precessing-vortex', label: 'Precessing shear vortex', centre: [-0.5, 2.5, -3.0], sigma: 0.8, axis: [0.2, 1, 0.1], strength: 4.0, omega: 0.13, phase: 2.0, kind: 'swirl', precession: { rate: 0.45, tilt: 0.7 }, affects: ['collar-ring', 'joint-orbiter', 'shard-glider'] },
];
const DISTS = [{ ...({} as DisturbanceDef) }];
void DISTS;
import { DISTURBANCES } from '../src/world/movers';
const ALL_D = [...DISTURBANCES.slice(0, 1), ...NEW_DISTURBANCES];

interface Arch {
  id: string; assetId: string; label: string; radius: number; category: MoverDef['category']; family: MoverDef['family']; role: MoverDef['role'];
  mass: number; drag?: number; stiffness: number; damping: number; fieldCoupling: [number, number]; foldCoupling?: number; spinCoupling?: number; lane: MoverDef['lane'];
  home: number; centre: [[number, number], [number, number], [number, number]]; semi: [[number, number], [number, number], [number, number]]; omega: [number, number];
  speed: [number, number]; spinRate: number;
}
const ARCH: Arch[] = [
  { id: 'shard-glider', assetId: 'baymax_plating_shard', label: 'Baymax plating shard', radius: 0.6, category: 'baymax', family: 'baymax', role: 'debris', mass: 0.55, drag: 0.16, stiffness: 1.8, damping: 1.8, fieldCoupling: [0.8, 1.6], spinCoupling: 1.2, lane: 'trefoil', home: 1, centre: [[3.0, 4.8], [1.8, 3.2], [-5.2, -3.0]], semi: [[1.4, 2.2], [0.8, 1.4], [0.3, 0.6]], omega: [0.06, 0.1], speed: [1.5, 12], spinRate: 0.9 },
  { id: 'heatshield-skimmer', assetId: 'capsule_heatshield_panel', label: 'Capsule heat-shield panel', radius: 0.9, category: 'landmark', family: 'capsule', role: 'debris', mass: 0.6, drag: 0.08, stiffness: 2.0, damping: 2.2, fieldCoupling: [0.8, 1.6], foldCoupling: 2.0, spinCoupling: 0.8, lane: 'figure8', home: 1, centre: [[2.6, 4.6], [1.6, 3.2], [-5.4, -3.0]], semi: [[2.0, 3.4], [0.8, 1.6], [0.3, 0.7]], omega: [0.09, 0.18], speed: [1.5, 8], spinRate: 0.6 },
  { id: 'joint-orbiter', assetId: 'baymax_joint_shell', label: 'Baymax joint shell', radius: 0.55, category: 'baymax', family: 'baymax', role: 'equipment', mass: 0.8, drag: 0.02, stiffness: 2.2, damping: 2.4, fieldCoupling: [0.8, 1.4], foldCoupling: 3.2, spinCoupling: 1.0, lane: 'ellipse', home: 3, centre: [[-0.5, 2.0], [1.0, 3.0], [-4.5, -2.5]], semi: [[1.6, 2.8], [0.8, 1.4], [0.3, 0.6]], omega: [0.09, 0.2], speed: [1.0, 7], spinRate: 0.7 },
  { id: 'collar-ring', assetId: 'capsule_collar_ring', label: 'Capsule collar ring', radius: 1.0, category: 'landmark', family: 'capsule', role: 'debris', mass: 1.0, stiffness: 2.4, damping: 2.6, fieldCoupling: [0.8, 1.4], spinCoupling: 2.2, lane: 'ellipse', home: 3, centre: [[-1.5, 0.5], [1.8, 3.2], [-4.0, -2.0]], semi: [[1.4, 2.4], [0.7, 1.2], [0.2, 0.5]], omega: [0.08, 0.16], speed: [0.8, 6], spinRate: 0.5 },
  { id: 'forearm-tumbler', assetId: 'baymax_forearm_shell', label: 'Baymax forearm shell', radius: 0.7, category: 'baymax', family: 'baymax', role: 'equipment', mass: 1.6, stiffness: 2.6, damping: 2.8, fieldCoupling: [0.7, 1.2], spinCoupling: 1.6, lane: 'ellipse', home: 2, centre: [[-4.0, -2.4], [-1.0, 0.2], [-5.5, -3.5]], semi: [[1.2, 2.2], [0.7, 1.3], [0.3, 0.6]], omega: [0.07, 0.14], speed: [0.5, 5], spinRate: 0.3 },
  { id: 'pipe-long', assetId: 'industrial_pipe_large_fractured', label: 'Fractured steel pipe', radius: 2.0, category: 'pipe', family: 'industrial', role: 'debris', mass: 3.0, stiffness: 2.6, damping: 3.0, fieldCoupling: [0.5, 1.0], spinCoupling: 0.5, lane: 'ellipse', home: 2, centre: [[-4.2, -2.6], [-1.0, 0.3], [-6.0, -4.0]], semi: [[1.2, 2.2], [0.7, 1.2], [0.3, 0.6]], omega: [0.05, 0.1], speed: [0.3, 4], spinRate: 0.14 },
  { id: 'slab-drifter', assetId: 'concrete_slab_rebar', label: 'Concrete slab', radius: 1.8, category: 'concrete', family: 'concrete', role: 'debris', mass: 6.0, drag: 0.1, stiffness: 2.6, damping: 3.0, fieldCoupling: [0.4, 0.9], spinCoupling: 0.25, lane: 'ellipse', home: 1, centre: [[3.2, 5.0], [1.5, 3.0], [-5.5, -3.2]], semi: [[1.0, 2.0], [0.6, 1.0], [0.2, 0.5]], omega: [0.05, 0.1], speed: [0.3, 3.5], spinRate: 0.1 },
];

const frameFrom = (yaw: number, tilt: number): readonly [Vec3, Vec3, Vec3] => {
  const cy = Math.cos(yaw), sy = Math.sin(yaw), ct = Math.cos(tilt), st = Math.sin(tilt);
  const e1: Vec3 = [cy, 0, -sy];
  const e2: Vec3 = [sy * ct, st, cy * ct];
  const e3: Vec3 = [e1[1] * e2[2] - e1[2] * e2[1], e1[2] * e2[0] - e1[0] * e2[2], e1[0] * e2[1] - e1[1] * e2[0]];
  return [e1, e2, e3];
};
const r2 = (x: number) => Math.round(x * 10000) / 10000;
const capsule = new MoverSystem(e.field, e.mapping, [MOVER_DEFS[0]!], []);
const HORIZON = Number(process.argv[3] ?? 150);
const capPath: number[][] = [];
for (let t = 0; t <= 300; t += 0.5) { capsule.syncTo(t); capPath.push([...capsule.states()[0]!.position]); }

const only = process.argv[2];
const N = Number(process.argv[4] ?? 120);
for (const a of ARCH) {
  if (only && only !== a.id) continue;
  const rnd = createSeededRandom(9100 + a.id.length * 17 + a.id.charCodeAt(0));
  const pick = (r: [number, number]) => r[0] + rnd() * (r[1] - r[0]);
  let best: { score: number; def: MoverDef; stats: string } | null = null;
  const rej = { bounds: 0, clear: 0, cap: 0, speed: 0 };
  for (let n = 0; n < N; n += 1) {
    const def: MoverDef = {
      id: a.id, label: a.label, assetId: a.assetId, role: a.role, category: a.category, family: a.family, radius: a.radius,
      centre: [pick(a.centre[0]), pick(a.centre[1]), pick(a.centre[2])], semiAxes: [pick(a.semi[0]), pick(a.semi[1]), pick(a.semi[2])],
      frame: frameFrom((rnd() - 0.5) * 3, (rnd() - 0.5) * 0.8), omega: pick(a.omega), secondaryRatio: 1.4 + rnd() * 1.0, phase: [rnd() * 6.28, rnd() * 6.28],
      stiffness: a.stiffness, damping: a.damping, fieldCoupling: pick(a.fieldCoupling), mass: a.mass, drag: a.drag, foldCoupling: a.foldCoupling, spinCoupling: a.spinCoupling, lane: a.lane, trail: true,
      spin: { axis: [rnd() - 0.5, 1, rnd() - 0.5], rate: a.spinRate, q0: [rnd() * 0.4 - 0.2, rnd() * 0.4 - 0.2, rnd() * 0.4 - 0.2, 0.9] },
    };
    const ms = new MoverSystem(e.field, e.mapping, [def], ALL_D, folds);
    const pts: number[][] = [];
    let minClear = Infinity, minCap = Infinity, inHome = 0, foldT = 0, ok = true;
    const dt = 0.25;
    for (let t = 0; t <= HORIZON; t += dt) {
      try { ms.syncTo(t); } catch { ok = false; break; }
      const p = ms.states()[0]!.position as Vec3;
      pts.push([...p]);
      if (Math.abs(p[0]) > 58 || p[1] < -14 || p[1] > 38 || p[2] > 12 || p[2] < -85) { ok = false; if (process.env.DBG) console.log('bounds', t, p.map(v => v.toFixed(0)).join(','), 'centre', def.centre.map(v => v.toFixed(1)).join(','), 'semi', def.semiAxes.map(v => v.toFixed(1)).join(',')); break; }
      const cp = capPath[Math.round(t / 0.5)]!;
      if (Math.round(t / 0.5) * 0.5 === t) minCap = Math.min(minCap, Math.hypot(p[0] - cp[0]!, p[1] - cp[1]!, p[2] - cp[2]!));
      if (Math.round(t) === t) for (const i of e.world.islands) { const w = e.evaluateIsland(i, t); minClear = Math.min(minClear, Math.hypot(p[0] - w[0], p[1] - w[1], p[2] - w[2]) - i.radius - i.height - a.radius); }
      if (ms.influence[a.home]! > 0.15) inHome += dt;
      if (ms.foldActivity[0]! > 0.1) foldT += dt;
    }
    if (!ok) { rej.bounds += 1; continue; }
    if (minClear < Number(process.env.MINCLEAR ?? 0.6)) { rej.clear += 1; continue; }
    if (minCap < Number(process.env.MINCAP ?? 8)) { rej.cap += 1; continue; }
    const speed: number[] = [], turn: number[] = [], curv: number[] = [];
    for (let i = 1; i < pts.length - 1; i += 1) {
      const v1 = pts[i]!.map((x, k) => (x - pts[i - 1]![k]!) / dt), v2 = pts[i + 1]!.map((x, k) => (x - pts[i]![k]!) / dt);
      const s = Math.hypot(...v1); speed.push(s);
      const dot = v1[0]! * v2[0]! + v1[1]! * v2[1]! + v1[2]! * v2[2]!;
      const ang = Math.acos(Math.max(-1, Math.min(1, dot / (s * Math.hypot(...v2) + 1e-9))));
      turn.push(ang / dt); curv.push(ang / (s * dt + 1e-6));
    }
    const mean = speed.reduce((x, y) => x + y, 0) / speed.length, mx = Math.max(...speed);
    turn.sort((x, y) => x - y);
    const p95 = turn[Math.floor(turn.length * 0.95)]!;
    if (process.env.DBG2) console.log('speed', mean.toFixed(2), mx.toFixed(2));
    if (mx > a.speed[1] || mean < a.speed[0]) { rej.speed += 1; continue; }
    // Reward interaction with the home disturbance and visible bending; penalise nothing else.
    const score = inHome + 0.4 * foldT * (a.foldCoupling ? 1 : 0) + 6 * p95 + 0.3 * mean;
    if (!best || score > best.score) best = { score, def, stats: `home ${inHome.toFixed(0)}s fold ${foldT.toFixed(0)}s mean ${mean.toFixed(2)} max ${mx.toFixed(2)} p95turn ${p95.toFixed(3)} maxcurv ${Math.max(...curv).toFixed(3)} clear ${minClear.toFixed(1)} capDist ${minCap.toFixed(1)}` };
  }
  if (!best) { console.log(a.id, 'NO CANDIDATE', JSON.stringify(rej)); continue; }
  const d = best.def;
  console.log(`// ${a.id}: ${best.stats}`);
  console.log(`centre: [${d.centre.map(r2)}], semiAxes: [${d.semiAxes.map(r2)}], frame: ${JSON.stringify(d.frame.map(v => v.map(r2)))}, omega: ${r2(d.omega)}, secondaryRatio: ${r2(d.secondaryRatio)}, phase: [${d.phase.map(r2)}], fieldCoupling: ${r2(d.fieldCoupling)},`);
  console.log(`spin: { axis: [${d.spin.axis.map(r2)}], rate: ${d.spin.rate}, q0: [${d.spin.q0.map(r2)}] },`);
}
