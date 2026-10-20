import { SimulationEngine } from '../src/simulation/simulationEngine';
import { DEFAULT_SEED } from '../src/simulation/constants';

const e = new SimulationEngine(DEFAULT_SEED);
const fmt = (v: readonly number[]) => v.map(x => x.toFixed(1)).join(', ');
console.log('opening pose', fmt(e.explorer.pose(0).position), '->', fmt(e.explorer.pose(0).target));
for (const t of [0, 30, 60, 120]) {
  console.log(`--- t=${t}`);
  for (const i of e.world.islands) console.log(i.id, 'ref', fmt(i.referencePosition), 'world', fmt(e.evaluateIsland(i, t)), 'r', i.radius.toFixed(1), 'h', i.height.toFixed(1));
}
for (const t of [0, 30, 60]) {
  const cs = e.network.getConnections(t).filter(c => c.valid);
  console.log(`--- folds t=${t}`, cs.length);
  for (const c of cs.slice(0, 12)) console.log(c.id, c.state, 'entry', fmt(c.entryWorldPosition), 'exit', fmt(c.exitWorldPosition));
}
