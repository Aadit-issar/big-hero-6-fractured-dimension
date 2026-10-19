import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';
import { SimulationEngine } from '../src/simulation/simulationEngine';
import { layoutDimension, placementInputs, type AssetSizes } from '../src/scene/assets/placement';
import { CAVERN_PATH, VORTEX } from '../src/scene/dimension/layout';

// Dumps the explorable space (read-only engine API) and the deterministic
// decorative layout as JSON, for scripts/placement-plot.py and the placement
// diagnosis. Usage: npx tsx scripts/placement-world.ts <out.json>
const out = process.argv[2] ?? 'test-results/placement/world.json';
const manifest = JSON.parse(readFileSync('public/assets/models/manifest.json', 'utf8')) as Record<string, { size: [number, number, number] }>;
const sizes: AssetSizes = Object.fromEntries(Object.entries(manifest).map(([k, m]) => [k, m.size]));
const engine = new SimulationEngine();
const inputs = placementInputs(engine);
const layout = layoutDimension(engine.seed, inputs, sizes);

const islands = engine.world.islands.map((island, i) => {
  const path = inputs.islandPaths[i]!.samples;
  return { id: island.id, reference: island.referencePosition, radius: island.radius, height: island.height, clearance: island.radius + island.height, centre: engine.evaluateIsland(island, 0), path };
});
const seen = new Map<string, { id: string; entry: number[][]; exit: number[][]; open: number; valid: number; samples: number }>();
for (let t = 0; t <= 240; t += 4) for (const c of engine.network.getConnections(t)) {
  const e = seen.get(c.id) ?? { id: c.id, entry: [], exit: [], open: 0, valid: 0, samples: 0 };
  e.samples += 1; if (c.valid) e.valid += 1; if (c.open) e.open += 1;
  if (c.valid) { e.entry.push([...c.entryWorldPosition]); e.exit.push([...c.exitWorldPosition]); }
  seen.set(c.id, e);
}
// Hazard over the reference volume spanned by the islands (t = 0).
const refs = engine.world.islands.map((i) => i.referencePosition);
const lo = [0, 1, 2].map((k) => Math.min(...refs.map((r) => r[k]!)) - 3), hi = [0, 1, 2].map((k) => Math.max(...refs.map((r) => r[k]!)) + 3);
const hazard: Array<{ world: number[]; hazard: number }> = [];
const N = 14;
for (let a = 0; a <= N; a += 1) for (let b = 0; b <= N; b += 1) for (let c = 0; c <= N; c += 1) {
  const q = [lo[0]! + (hi[0]! - lo[0]!) * a / N, lo[1]! + (hi[1]! - lo[1]!) * b / N, lo[2]! + (hi[2]! - lo[2]!) * c / N] as const;
  const s = engine.sampleField(q, 0);
  hazard.push({ world: [...s.worldPosition], hazard: s.hazard });
}
mkdirSync(dirname(out), { recursive: true });
writeFileSync(out, JSON.stringify({
  opening: inputs.opening, openingTarget: inputs.openingTarget, vortex: VORTEX, cavern: CAVERN_PATH,
  islands, connections: [...seen.values()], hazard, foldPoints: inputs.foldPoints,
  debris: layout.debris.map((d) => ({ asset: d.asset, cluster: d.cluster, position: d.position, radius: d.radius, region: (d as { region?: string }).region ?? null })),
  formations: layout.formations.map((f) => ({ id: f.id, kind: f.kind, centre: f.centre, radius: f.radius, units: f.units.length })),
  rejected: layout.rejected,
}));
console.log(`wrote ${out}: ${islands.length} islands, ${seen.size} connections, ${layout.debris.length} debris, ${layout.formations.length} formations`);
