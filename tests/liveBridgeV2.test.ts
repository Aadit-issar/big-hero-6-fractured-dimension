import { describe, expect, it } from 'vitest';
import { SimulationEngine } from '../src/simulation/simulationEngine';
import { ASSET_SIZES } from '../src/scene/assets/assetSizes';
import { layoutDimension, placementInputs } from '../src/scene/assets/placement';
import { MOVER_DETECTION_RANGE, SCENE_SCAN_RANGE, isSuppressedStatic, scanDisturbances, scanSceneObjects } from '../src/bridge/bridgeCore';
import { createGoalResolver } from '../src/bridge/truth';
import { MOVER_DEFS, moversFor } from '../src/world/movers';
import { parseClock, parseIslandForm, parseNavReport, parsePose, parseRouteAck, parseRouteCommand } from '../src/shared/liveLink';
import { SHARED_ASSETS } from '../src/shared/assetManifest';
import { assetSpec } from '../src/scene/assets/assetRegistry';

const SIZES = Object.fromEntries(Object.entries(ASSET_SIZES).map(([id, a]) => [id, a.size]));
const engine = new SimulationEngine();
const layout = layoutDimension(engine.seed, placementInputs(engine), SIZES);

describe('scan of moving objects (protocol v2)', () => {
  it('reports movers by stable id with attitude and no velocity, only within detection range', () => {
    const movers = moversFor(engine);
    const states = movers.states();
    const capsule = states.find(s => s.id === 'capsule-abigail')!;
    const near: [number, number, number] = [capsule.position[0] + 10, capsule.position[1], capsule.position[2] + 10];
    const { objects } = scanSceneObjects(layout, near, SCENE_SCAN_RANGE, 1000, { states, defs: MOVER_DEFS });
    const found = objects.find(o => o.id === 'capsule-abigail')!;
    expect(found).toBeDefined();
    expect(found.label).toBe("Abigail's Capsule");
    expect(found.kind).toBe('capsule_shell_remnant');
    expect(found.orientation).toHaveLength(4);
    expect(Object.keys(found).some(k => /vel|speed|accel|future|forecast|trajectory/i.test(k))).toBe(false);
    const beacon = MOVER_DEFS.find(m => m.id === 'capsule-abigail')!.beaconRange!;
    expect(beacon).toBeGreaterThan(MOVER_DETECTION_RANGE);
    const far: [number, number, number] = [capsule.position[0] + beacon + 5, capsule.position[1], capsule.position[2]];
    expect(scanSceneObjects(layout, far, SCENE_SCAN_RANGE, 1000, { states, defs: MOVER_DEFS }).objects.some(o => o.id === 'capsule-abigail')).toBe(false);
  });

  it('the scattered layout copy of the capsule shell is suppressed: Abigail has exactly one shell', () => {
    const shells = layout.debris.filter(isSuppressedStatic);
    expect(shells.length).toBeGreaterThan(0);
    const p = shells[0]!.position;
    const { objects } = scanSceneObjects(layout, [p[0], p[1], p[2]], 30, 1000);
    expect(objects.some(o => o.kind === 'capsule_shell_remnant')).toBe(false);
  });

  it('reports disturbance regions only when in range', () => {
    const states = moversFor(engine).disturbanceStates();
    const p = states[0]!.position;
    expect(scanDisturbances([p[0], p[1], p[2]], states).map(d => d.id)).toContain(states[0]!.id);
    expect(scanDisturbances([p[0] + 9000, p[1], p[2]], states)).toHaveLength(0);
  });
});

describe('goal truth inside the Dimension', () => {
  const resolve = createGoalResolver(engine, () => layout);
  it('resolves movers, folds and scene objects; islands are decided by their approach waypoint', () => {
    const t = moversFor(engine).states().find(s => s.id === 'capsule-abigail')!;
    expect(resolve('capsule-abigail', 0)?.position).toEqual(t.position);
    expect(resolve('capsule-abigail', 0)?.captureRadius).toBeCloseTo(MOVER_DEFS[0]!.radius + 4, 9);
    const fold = engine.network.getConnections(0).find(c => c.valid)!;
    expect(resolve(fold.id, 0)?.position).toEqual(fold.entryWorldPosition);
    expect(resolve('obj-000', 0)?.position).toEqual(layout.debris[0]!.position);
    expect(resolve('island-01', 0)).toBeNull();
    expect(resolve('nonsense', 0)).toBeNull();
  });
});

describe('wire validators reject malformed input', () => {
  it('pose, clock, nav, ack and island form', () => {
    expect(parsePose({ position: [1, 2, 3], quaternion: [0, 0, 0, 1], forward: [0, 0, -1], velocity: [0, 0, 0] })).not.toBeNull();
    expect(parsePose({ position: [1, 2], quaternion: [0, 0, 0, 1], forward: [0, 0, -1], velocity: [0, 0, 0] })).toBeNull();
    expect(parsePose({ position: [1e9, 2, 3], quaternion: [0, 0, 0, 1], forward: [0, 0, -1], velocity: [0, 0, 0] })).toBeNull();
    expect(parseClock({ time: 3, running: true, timeScale: 1, visible: true })).not.toBeNull();
    expect(parseClock({ time: -1, running: true, timeScale: 1, visible: true })).toBeNull();
    expect(parseNavReport({ routeId: 'r', revision: 1, status: 'active', activeIndex: 0, waypointCount: 2, distanceToWaypoint: 3, distanceToGoal: 9, arrivedAtSimTime: null })).not.toBeNull();
    expect(parseNavReport({ routeId: 'r', revision: 1, status: 'bogus', activeIndex: 0, waypointCount: 2, distanceToWaypoint: 3, distanceToGoal: 9, arrivedAtSimTime: null })).toBeNull();
    expect(parseRouteAck({ session: 's', seq: 3, routeId: 'r', revision: 2, status: 'accepted', code: 'ok', detail: 'x', simTime: 1 })).not.toBeNull();
    expect(parseRouteAck({ session: 's', seq: 3, routeId: 'r', revision: 2, status: 'maybe', code: 'ok', detail: 'x', simTime: 1 })).toBeNull();
    expect(parseIslandForm({ id: 'island-01', index: 0, radius: 4, height: 2, facetSeed: 5, color: '#fff' })).not.toBeNull();
    expect(parseIslandForm({ id: 'island-01', index: 0, radius: -4, height: 2, facetSeed: 5, color: '#fff' })).toBeNull();
  });

  it('route commands: strict fields, bounded size, no extra fields survive', () => {
    const base = {
      routeId: 'r1', revision: 1, atlasSession: 'a', goal: { id: 'g', label: 'G', category: 'capsule', motion: 'moving' }, mode: 'intercept', issuedSimTime: 1, speed: 14,
      waypoints: [{ id: 'w', position: [1, 2, 3], kind: 'intercept', arrivalRadius: 5, etaSimTime: 3 }], interception: null, reason: 'why', assumptions: [], supersedes: null,
    };
    const parsed = parseRouteCommand({ ...base, evil: 'payload', engine: {} });
    expect(parsed).not.toBeNull();
    expect((parsed as unknown as Record<string, unknown>).evil).toBeUndefined();
    expect(parseRouteCommand({ ...base, speed: 0 })).toBeNull();
    expect(parseRouteCommand({ ...base, speed: 500 })).toBeNull();
    expect(parseRouteCommand({ ...base, waypoints: [] })).toBeNull();
    expect(parseRouteCommand({ ...base, goal: { ...base.goal, id: '' } })).toBeNull();
    expect(parseRouteCommand({ ...base, assumptions: Array.from({ length: 20 }, () => 'x') })).toBeNull();
    expect(parseRouteCommand({ ...base, reason: 'x'.repeat(5000) })!.reason.length).toBeLessThanOrEqual(280);
  });
});

describe('shared asset manifest', () => {
  it('names every registry asset with measured size, a level ATLAS draws, and hashes', () => {
    for (const [id, a] of Object.entries(SHARED_ASSETS)) {
      if (id === 'baymax_hero') { expect(a.levels).toHaveLength(2); expect(a.atlasLevel).toBe(1); continue; }
      expect(a.levels.length, id).toBeGreaterThan(0);
      expect(a.atlasLevel, id).toBeLessThan(a.levels.length);
      expect(a.levels.every(l => /^[0-9a-f]{64}$/.test(l.sha256)), id).toBe(true);
      expect(assetSpec(id).family, id).toBe(a.family);
      expect(a.size, id).toEqual(ASSET_SIZES[id]!.size.map(v => +v.toFixed(5)));
    }
    for (const m of MOVER_DEFS) expect(SHARED_ASSETS[m.assetId], m.id).toBeDefined();
  });
});
