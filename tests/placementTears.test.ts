import { describe, expect, it } from 'vitest';
import { Vector3 } from 'three';
import { SimulationEngine } from '../src/simulation/simulationEngine';
import { bridgeLike, clearanceViolation, placementInputs } from '../src/scene/assets/placement';
import { FOLD_GAP } from '../src/scene/dimension/fractureLayout';
import { layoutTears } from '../src/scene/dimension/tearLayout';
import { MIRROR_Y } from '../src/scene/dimension/layout';

const engine = new SimulationEngine();
const inputs = placementInputs(engine);
const tears = layoutTears(engine.seed, inputs);

describe('cosmetic spatial tears (rifts and shears)', () => {
  it('are deterministic, of both classes, in several regions', () => {
    expect(layoutTears(engine.seed, placementInputs(new SimulationEngine()))).toEqual(tears);
    expect(tears.filter((t) => t.kind === 'rift').length).toBeGreaterThanOrEqual(5);
    expect(tears.filter((t) => t.kind === 'shear').length).toBeGreaterThanOrEqual(4);
    expect(new Set(tears.map((t) => t.region)).size).toBeGreaterThanOrEqual(4);
  });

  it('stay clear of islands, apertures, exits, the opening view and real folds', () => {
    for (const t of tears) for (let k = -4; k <= 4; k += 1) {
      const p = new Vector3(...t.centre).addScaledVector(new Vector3(...t.axis), (k / 4) * t.halfLength);
      expect(clearanceViolation(inputs, [p.x, p.y, p.z], t.halfWidth), t.id).toBeNull();
      for (const fold of inputs.foldPoints) expect(p.distanceTo(new Vector3(...fold)), t.id).toBeGreaterThan(FOLD_GAP);
      expect(p.y, t.id).toBeGreaterThan(MIRROR_Y);
    }
  });

  it('never read as real folds or as bridges between islands', () => {
    for (const t of tears) {
      // A real fold aperture is 3.1 m; tears are an order of magnitude larger.
      expect(t.halfLength * 2, t.id).toBeGreaterThan(12);
      if (t.kind === 'shear') expect(bridgeLike(inputs, t.centre, new Vector3(...t.axis)), t.id).toBe(false);
    }
  });
});
