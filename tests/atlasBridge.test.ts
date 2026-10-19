import { describe, expect, it } from 'vitest';
import { SimulationEngine } from '../src/simulation/simulationEngine';
import { ASSET_SIZES } from '../src/scene/assets/assetSizes';
import { layoutDimension, placementInputs } from '../src/scene/assets/placement';
import { SCENE_SCAN_RANGE, isAllowedOrigin, scanSceneObjects } from '../src/bridge/bridgeCore';
import { observe } from '../src/sensors/atlasSensor';

const SIZES = Object.fromEntries(Object.entries(ASSET_SIZES).map(([id, a]) => [id, a.size]));
const engine = new SimulationEngine();
const layout = layoutDimension(engine.seed, placementInputs(engine), SIZES);

describe('ATLAS bridge scene-object scan', () => {
  it('reports only objects within range, nearest first', () => {
    const observer = engine.explorer.worldPosition;
    const { objects } = scanSceneObjects(layout, [observer[0], observer[1], observer[2]], SCENE_SCAN_RANGE, 1000);
    expect(objects.length).toBeGreaterThan(0);
    expect(objects.length).toBeLessThan(layout.debris.length + layout.formations.length);
    for (const o of objects) expect(o.range).toBeLessThanOrEqual(SCENE_SCAN_RANGE);
    expect([...objects].sort((a, b) => a.range - b.range).map(o => o.id)).toEqual(objects.map(o => o.id));
  });

  it('acquires nothing far outside the layout and never serialises the registry', () => {
    expect(scanSceneObjects(layout, [9000, 9000, 9000], SCENE_SCAN_RANGE).objects).toHaveLength(0);
    const near = scanSceneObjects(layout, [engine.explorer.worldPosition[0], engine.explorer.worldPosition[1], engine.explorer.worldPosition[2]], SCENE_SCAN_RANGE);
    expect(JSON.stringify(near).length).toBeLessThan(JSON.stringify(layout).length / 3);
    expect(near.objects.every(o => !('region' in o) && !('cluster' in o) && !('drift' in o))).toBe(true);
  });

  it('caps the report and counts what it omits', () => {
    const p = layout.debris[0]!.position;
    const full = scanSceneObjects(layout, [p[0], p[1], p[2]], 200, 10_000);
    const capped = scanSceneObjects(layout, [p[0], p[1], p[2]], 200, 5);
    expect(capped.objects).toHaveLength(5);
    expect(capped.omitted).toBe(full.objects.length - 5);
  });

  it('is read-only: scanning and observing leave the engine untouched', () => {
    const before = JSON.stringify({ t: engine.clock.time, p: engine.explorer.worldPosition, r: engine.explorer.referencePosition });
    const o = observe(engine);
    scanSceneObjects(layout, o.observerWorldPosition, SCENE_SCAN_RANGE);
    expect(JSON.stringify({ t: engine.clock.time, p: engine.explorer.worldPosition, r: engine.explorer.referencePosition })).toBe(before);
  });
});

describe('ATLAS bridge origin policy', () => {
  it('allows loopback origins and an explicit origin only', () => {
    expect(isAllowedOrigin('http://127.0.0.1:5180', null)).toBe(true);
    expect(isAllowedOrigin('http://localhost:5173', null)).toBe(true);
    expect(isAllowedOrigin('https://evil.example', null)).toBe(false);
    expect(isAllowedOrigin('http://127.0.0.1.evil.example', null)).toBe(false);
    expect(isAllowedOrigin('https://atlas.example', 'https://atlas.example')).toBe(true);
    expect(isAllowedOrigin('null', null)).toBe(false);
  });
});
