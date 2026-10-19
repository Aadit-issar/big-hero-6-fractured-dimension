import { describe, expect, it } from 'vitest';
import { Quaternion, Vector3 } from 'three';
import { SimulationEngine } from '../src/simulation/simulationEngine';
import { ASSET_SIZES } from '../src/scene/assets/assetSizes';
import { assetSpec } from '../src/scene/assets/assetRegistry';
import { clearanceViolation, layoutDimension, placementInputs } from '../src/scene/assets/placement';
import type { DimensionLayout, Quat } from '../src/scene/assets/placement';

const SIZES = Object.fromEntries(Object.entries(ASSET_SIZES).map(([id, a]) => [id, a.size]));
const engine = new SimulationEngine();
const inputs = placementInputs(engine);
const layout = layoutDimension(engine.seed, inputs, SIZES);
const axisX = (q: Quat) => new Vector3(1, 0, 0).applyQuaternion(new Quaternion(...q));

describe('deterministic dimension layout', () => {
  it('is a pure function of the seed and world', () => {
    const again: DimensionLayout = layoutDimension(engine.seed, placementInputs(new SimulationEngine()), SIZES);
    expect(again).toEqual(layout);
    expect(layoutDimension(engine.seed + 1, inputs, SIZES)).not.toEqual(layout);
  });

  it('populates every authored zone, with exactly one capsule landmark', () => {
    const clusters = new Set(layout.debris.map((d) => d.cluster));
    for (const zone of ['landmark', 'capsule-trail', 'capsule-baymax', 'breach-wall', 'breach-slabs', 'industrial-structure', 'industrial-services', 'funnel-breach', 'baymax-remnants', 'low-sediment', 'hazard-0', 'fold-seam', 'high-drift']) expect(clusters.has(zone), zone).toBe(true);
    expect(layout.debris.filter((d) => d.asset === 'capsule_shell_remnant')).toHaveLength(1);
    expect(layout.debris.filter((d) => d.cluster === 'landmark')).toHaveLength(1);
    // The 107k-triangle wall breach is a sparing landmark.
    expect(layout.debris.filter((d) => d.asset === 'concrete_wall_breach').length).toBeLessThanOrEqual(2);
    const kinds = new Set(layout.formations.map((f) => f.kind));
    for (const kind of ['swarm', 'cluster', 'chain', 'inactive']) expect(kinds.has(kind as never), kind).toBe(true);
    expect(layout.formations.find((f) => f.id === 'opening-swarm')).toBeDefined();
    expect(layout.formations.reduce((n, f) => n + f.units.length, 0)).toBeGreaterThan(2500);
  });

  it('keeps debris clear of swept islands, folds, apertures, traversal exits and the opening view', () => {
    for (const d of layout.debris) expect(clearanceViolation(inputs, d.position, d.radius), `${d.asset} in ${d.cluster}`).toBeNull();
    for (const f of layout.formations) expect(clearanceViolation(inputs, f.centre, f.radius), f.id).toBeNull();
  });

  it('holds the island clearance on a finer time grid than the one used to place', () => {
    const fine = placementInputs(engine, 240, 1);
    for (const d of layout.debris) {
      const drift = Math.hypot(...d.drift.amplitude);
      for (const path of fine.islandPaths) for (const s of path.samples) {
        expect(Math.hypot(d.position[0] - s[0], d.position[1] - s[1], d.position[2] - s[2]) - drift).toBeGreaterThan(path.clearance + d.radius);
      }
    }
  }, 120_000);

  it('uses registry scales only, and microbot units are never scaled', () => {
    for (const d of layout.debris) {
      const [lo, hi] = assetSpec(d.asset).scaleVariation;
      expect(d.scale).toBeGreaterThanOrEqual(lo); expect(d.scale).toBeLessThanOrEqual(hi);
    }
    // Formation units carry position + rotation only: there is no scale to change.
    for (const f of layout.formations) for (const u of f.units) expect(Object.keys(u).sort()).toEqual(['phase', 'position', 'quaternion']);
  });

  it('keeps decorative motion slow and small (low-frequency drift, bounded spin)', () => {
    for (const d of layout.debris) {
      expect(Math.hypot(...d.drift.amplitude)).toBeLessThan(0.6);
      expect(d.drift.period).toBeGreaterThanOrEqual(30);
      expect(Math.abs(d.drift.spinRate)).toBeLessThanOrEqual(0.022);
    }
  });

  it('orients tumbled debris in full 3D and keeps structural pieces coherent', () => {
    const tumbled = layout.debris.filter((d) => d.region === 'hazard' || d.cluster.startsWith('ambient-')).map((d) => axisX(d.quaternion));
    // Covariance of the rotated axes spans all three dimensions (not a single spin axis).
    const cov = [0, 1, 2].map((i) => [0, 1, 2].map((j) => tumbled.reduce((s, a) => s + a.getComponent(i) * a.getComponent(j), 0) / tumbled.length));
    for (let i = 0; i < 3; i += 1) expect(cov[i]![i]!).toBeGreaterThan(0.08);
    const structure = layout.debris.filter((d) => d.cluster === 'industrial-structure').map((d) => new Quaternion(...d.quaternion));
    expect(structure.length).toBeGreaterThan(4);
    for (let i = 1; i < structure.length; i += 1) expect(structure[i]!.angleTo(structure[0]!)).toBeLessThanOrEqual(2 * 0.35 + 1e-6);
  });

  it('builds chains with continuous frames at the true microbot spacing', () => {
    const chains = layout.formations.filter((f) => f.kind === 'chain');
    expect(chains.length).toBeGreaterThan(0);
    for (const chain of chains) {
      for (let i = 1; i < chain.units.length; i += 1) {
        const a = chain.units[i - 1]!, b = chain.units[i]!;
        const gap = Math.hypot(b.position[0] - a.position[0], b.position[1] - a.position[1], b.position[2] - a.position[2]);
        expect(gap, `${chain.id} spacing`).toBeGreaterThan(0.036);
        expect(gap, `${chain.id} spacing`).toBeLessThan(0.0425);
        expect(axisX(a.quaternion).angleTo(axisX(b.quaternion)), `${chain.id} bend`).toBeLessThan(0.2);
      }
    }
  });
});
