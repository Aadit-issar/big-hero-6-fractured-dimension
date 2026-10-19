import { readFileSync } from 'node:fs';
import { SimulationEngine } from '../src/simulation/simulationEngine';
import { layoutDimension, placementInputs, type AssetSizes } from '../src/scene/assets/placement';

// Prints the deterministic decorative layout: counts per cluster, microbots per
// formation and clearance rejections. Rendering-only data; the engine is read only.
const manifest = JSON.parse(readFileSync('public/assets/models/manifest.json', 'utf8')) as Record<string, { size: [number, number, number] }>;
const sizes: AssetSizes = Object.fromEntries(Object.entries(manifest).map(([k, m]) => [k, m.size]));
const engine = new SimulationEngine();
const t0 = performance.now();
const inputs = placementInputs(engine);
const t1 = performance.now();
const layout = layoutDimension(engine.seed, inputs, sizes);
const t2 = performance.now();
const byCluster: Record<string, number> = {};
for (const d of layout.debris) byCluster[d.cluster] = (byCluster[d.cluster] ?? 0) + 1;
console.log(JSON.stringify({ inputsMs: +(t1 - t0).toFixed(1), layoutMs: +(t2 - t1).toFixed(1), opening: inputs.opening, target: inputs.openingTarget, debris: layout.debris.length, byCluster, formations: layout.formations.map((f) => [f.id, f.kind, f.units.length, f.centre.map((x) => +x.toFixed(1))]), rejected: layout.rejected }, null, 1));
