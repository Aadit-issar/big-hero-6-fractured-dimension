import { describe, expect, it } from 'vitest';
import { Quaternion, Vector3 } from 'three';
import { SimulationEngine } from '../src/simulation/simulationEngine';
import { ASSET_SIZES } from '../src/scene/assets/assetSizes';
import { assetSpec } from '../src/scene/assets/assetRegistry';
import { bridgeLike, layoutDimension, placementInputs } from '../src/scene/assets/placement';

// Spread and composition of the decorative layout over the explorable space.
// Metrics are deterministic and defined exactly as in scripts/placement-plot.py:
// the island chamber is the box of island centres ± (22, 14, 22) m, sampled by a
// fixed Halton set outside island clearance.
const SIZES = Object.fromEntries(Object.entries(ASSET_SIZES).map(([id, a]) => [id, a.size]));
const engine = new SimulationEngine();
const inputs = placementInputs(engine);
const layout = layoutDimension(engine.seed, inputs, SIZES);
const P = layout.debris.map((d) => new Vector3(...d.position));
const centres = Object.values(inputs.islandCentres).map((c) => new Vector3(...c));
const lo = new Vector3(Math.min(...centres.map((c) => c.x)) - 22, Math.min(...centres.map((c) => c.y)) - 14, Math.min(...centres.map((c) => c.z)) - 22);
const hi = new Vector3(Math.max(...centres.map((c) => c.x)) + 22, Math.max(...centres.map((c) => c.y)) + 14, Math.max(...centres.map((c) => c.z)) + 22);
const halton = (i: number, b: number) => { let f = 1, r = 0; while (i > 0) { f /= b; r += f * (i % b); i = Math.floor(i / b); } return r; };
const samples = Array.from({ length: 3000 }, (_, i) => new Vector3(halton(i + 1, 2), halton(i + 1, 3), halton(i + 1, 5)).multiply(hi.clone().sub(lo)).add(lo))
  .filter((p) => engine.world.islands.every((island, k) => p.distanceTo(centres[k]!) > island.radius + island.height + 1));
const nearest = samples.map((s) => Math.min(...P.map((p) => p.distanceTo(s)))).sort((a, b) => a - b);

describe('decorative coverage', () => {
  it('leaves no large dead region in the island chamber', () => {
    // Median / 90th-percentile distance from a sampled point to the nearest piece.
    expect(nearest[Math.floor(nearest.length / 2)]!).toBeLessThan(16);
    expect(nearest[Math.floor(nearest.length * 0.9)]!).toBeLessThan(30);
  });

  it('is not bunched: no 20 m sphere holds more than 12 % of all pieces', () => {
    const densest = Math.max(...P.map((p) => P.filter((q) => q.distanceTo(p) < 20).length));
    expect(densest / P.length).toBeLessThan(0.12);
  });

  it('varies density meaningfully (dense, medium and quiet 15 m cells)', () => {
    const cell = 15, nx = Math.ceil((hi.x - lo.x) / cell), nz = Math.ceil((hi.z - lo.z) / cell);
    const grid = new Array(nx * nz).fill(0) as number[];
    for (const p of P) if (p.x >= lo.x && p.x <= hi.x && p.y >= lo.y && p.y <= hi.y && p.z >= lo.z && p.z <= hi.z) grid[Math.min(nz - 1, Math.floor((p.z - lo.z) / cell)) * nx + Math.min(nx - 1, Math.floor((p.x - lo.x) / cell))]! += 1;
    const occupied = grid.filter((n) => n > 0).length / grid.length;
    expect(occupied).toBeGreaterThan(0.5);
    // Quiet cells remain (intentional emptiness) and some cells are dense.
    expect(grid.filter((n) => n === 0).length).toBeGreaterThan(grid.length * 0.15);
    expect(Math.max(...grid)).toBeGreaterThanOrEqual(10);
  });

  it('gives every island its own debris ecosystem and spans many regions', () => {
    for (const island of engine.world.islands) expect(layout.debris.filter((d) => d.cluster === island.id).length, island.id).toBeGreaterThanOrEqual(1);
    const regions = new Set(layout.debris.map((d) => d.region));
    for (const r of ['capsule-site', 'breach-site', 'industrial-site', 'funnel-site', 'baymax-site', 'hazard', 'island', 'fold-seam', 'low-sediment', 'high-drift', 'vortex-inflow', 'ambient', 'entrance', 'funnel']) expect(regions.has(r), r).toBe(true);
  });

  it('never lines elongated wreckage up between nearby islands (no fake connections)', () => {
    for (const d of layout.debris) {
      if (!['steel', 'walkway', 'pipe', 'scaffold'].includes(assetSpec(d.asset).category)) continue;
      const s = ASSET_SIZES[d.asset]!.size, k = s[0] >= s[1] && s[0] >= s[2] ? 0 : s[1] >= s[2] ? 1 : 2;
      const axis = new Vector3(k === 0 ? 1 : 0, k === 1 ? 1 : 0, k === 2 ? 1 : 0).applyQuaternion(new Quaternion(...d.quaternion));
      expect(bridgeLike(inputs, d.position, axis), `${d.asset} in ${d.cluster}`).toBe(false);
    }
  });

  it('builds the capsule crash site from every capsule component, with Baymax remnants nearby', () => {
    const shell = layout.debris.find((d) => d.cluster === 'landmark')!;
    const site = layout.debris.filter((d) => d.region === 'capsule-site');
    for (const id of ['capsule_collar_ring', 'capsule_heatshield_panel', 'capsule_upper_shell_fragment', 'capsule_impact_fragment', 'capsule_rcs_thruster', 'capsule_antenna_broken', 'capsule_instrument_unit']) {
      expect(site.some((d) => d.asset === id), id).toBe(true);
    }
    const far = Math.max(...site.map((d) => new Vector3(...d.position).distanceTo(new Vector3(...shell.position))));
    expect(far).toBeGreaterThan(15); // a trail, not a pile
    expect(far).toBeLessThan(70);
    expect(site.some((d) => assetSpec(d.asset).family === 'baymax')).toBe(true);
  });

  it('keeps a bounded instance budget', () => {
    expect(layout.debris.length).toBeGreaterThan(250);
    expect(layout.debris.length).toBeLessThan(560);
  });
});
