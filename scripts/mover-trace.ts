import { SimulationEngine } from '../src/simulation/simulationEngine';
import { MoverSystem } from '../src/world/movers';
const e = new SimulationEngine();
const ms = new MoverSystem(e.field, e.mapping);
let prev: readonly number[] | null = null;
const rows: string[] = [];
for (let t = 0; t <= 40; t += 0.5) {
  ms.syncTo(t);
  const s = ms.states()[0]!;
  const sp = prev ? Math.hypot(s.position[0]-prev[0], s.position[1]-prev[1], s.position[2]-prev[2]) / 0.5 : 0;
  rows.push(`${t.toFixed(1)} ${s.position.map(v => v.toFixed(1)).join(',')} v=${sp.toFixed(2)}`);
  prev = s.position;
}
console.log(rows.join('\n'));
