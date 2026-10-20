import { SimulationEngine } from '../src/simulation/simulationEngine';
const e = new SimulationEngine();
const f = (v: readonly number[]) => v.map(x => x.toFixed(1).padStart(6)).join(' ');
console.log('start', f(e.explorer.pose(0).position));
for (const t of [0, 30, 60, 120]) {
  console.log('t', t);
  for (const c of e.network.getConnections(t)) console.log(' ', c.id.padEnd(10), c.state.padEnd(9), c.valid ? 'valid' : 'inval', 'entryRef', f(c.entryReferencePosition), 'exitRef', f(c.exitReferencePosition), 'entryW', f(c.entryWorldPosition), 'exitW', f(c.exitWorldPosition));
}
e.world.islands.forEach((i, k) => console.log(k, i.id, 'ref', f(i.referencePosition), 'r', i.radius.toFixed(1), 'h', i.height.toFixed(1), 'world0', f(e.evaluateIsland(i, 0)), 'world60', f(e.evaluateIsland(i, 60))));
