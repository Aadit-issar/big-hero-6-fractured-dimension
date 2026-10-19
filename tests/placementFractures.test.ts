import { describe, expect, it } from 'vitest';
import { Vector3 } from 'three';
import { SimulationEngine } from '../src/simulation/simulationEngine';
import { bridgeLike, clearanceViolation, placementInputs } from '../src/scene/assets/placement';
import { FOLD_GAP, layoutFractures } from '../src/scene/dimension/fractureLayout';
import { MIRROR_Y } from '../src/scene/dimension/layout';

const engine = new SimulationEngine();
const inputs = placementInputs(engine);
const fractures = layoutFractures(engine.seed, inputs);

describe('cosmetic spatial fractures', () => {
  it('are deterministic and spread over many regions', () => {
    expect(layoutFractures(engine.seed, placementInputs(new SimulationEngine()))).toEqual(fractures);
    const regions = new Set(fractures.map((f) => f.region));
    for (const r of ['chamber', 'ceiling', 'floor', 'entrance', 'funnel', 'distant']) expect(regions.has(r), r).toBe(true);
    expect(fractures.length).toBeGreaterThanOrEqual(7);
  });

  it('never touch islands, apertures, exits or the opening view, and stay away from real folds', () => {
    for (const f of fractures) for (const s of f.segments) for (let t = 0; t <= 1; t += 0.25) {
      const p = new Vector3(...s.a).lerp(new Vector3(...s.b), t);
      expect(clearanceViolation(inputs, [p.x, p.y, p.z], 1), f.id).toBeNull();
      for (const fold of inputs.foldPoints) expect(p.distanceTo(new Vector3(...fold)), f.id).toBeGreaterThan(FOLD_GAP);
      expect(p.y, `${f.id} above the mirror floor`).toBeGreaterThan(MIRROR_Y);
    }
  });

  it('are hairline networks, not apertures: long, thin, and never aligned between islands', () => {
    for (const f of fractures) {
      const main = f.segments.filter((s) => !s.echo);
      const length = main.reduce((n, s) => n + new Vector3(...s.a).distanceTo(new Vector3(...s.b)), 0);
      // Much longer than a 3.1 m fold tear, and thin relative to their length.
      expect(length, f.id).toBeGreaterThan(8);
      for (const s of f.segments) expect(s.core).toBeLessThan(0.1 * Math.max(1, new Vector3(...s.a).distanceTo(new Vector3(...s.b))));
      const first = main[0]!;
      const dir = new Vector3(...first.b).sub(new Vector3(...first.a)).normalize();
      expect(bridgeLike(inputs, first.a, dir), f.id).toBe(false);
    }
  });
});
