import { describe, expect, it } from 'vitest';
import { MISS_GRACE_SECONDS, RouteManager, plannedTargetAt } from '../src/bridge/navCore';
import type { GoalResolver } from '../src/bridge/navCore';
import type { RouteCommand, Vec3Tuple } from '../src/shared/liveLink';

const CAPTURE = 6.4;
/** A goal drifting along +x at 2 m/s from x = 20, z = -60. */
const truthAt = (t: number): Vec3Tuple => [20 + 2 * (t - 10), 5, -60];
const resolve: GoalResolver = (_id, t) => ({ position: truthAt(t), captureRadius: CAPTURE });

const route = (over: Partial<RouteCommand> = {}): RouteCommand => ({
  routeId: 'r1', revision: 1, atlasSession: 'A', goal: { id: 'capsule', label: 'Capsule', category: 'landmark', motion: 'moving', assetId: 'capsule' },
  mode: 'intercept', issuedSimTime: 10, speed: 12,
  waypoints: [
    { id: 'w1', position: [0, 0, -30], kind: 'path', arrivalRadius: 6, etaSimTime: 12 },
    { id: 'w2', position: [30, 5, -60], kind: 'intercept', arrivalRadius: 5, etaSimTime: 16 },
  ],
  interception: {
    position: [32, 5, -60], simTime: 16, targetNow: [20, 5, -60], targetObservedAt: 10, uncertainty: 1.4,
    targetPath: [{ simTime: 10, position: [20, 5, -60] }, { simTime: 16, position: [32, 5, -60] }],
  },
  reason: 'test', assumptions: [], supersedes: null, ...over,
});

describe('plannedTargetAt', () => {
  const i = route().interception!;
  it('interpolates the forecast path and clamps outside it', () => {
    expect(plannedTargetAt(i, 13)).toEqual([26, 5, -60]);
    expect(plannedTargetAt(i, 0)).toEqual([20, 5, -60]);
    expect(plannedTargetAt(i, 99)).toEqual([32, 5, -60]);
  });
  it('falls back to the meeting position without a path', () => {
    expect(plannedTargetAt({ position: i.position, simTime: i.simTime, targetNow: i.targetNow, targetObservedAt: i.targetObservedAt, uncertainty: i.uncertainty }, 12)).toEqual(i.position);
  });
});

describe('moving-target outcome', () => {
  it('succeeds on the TRUE position and reports every outcome field', () => {
    const m = new RouteManager();
    m.offer(route(), 10);
    m.update([0, 0, -29], 11, resolve);
    // True goal at t = 17 is x = 34; planned (clamped) was 32 -> plannedError 2.
    expect(m.update([30, 5, -58], 17, resolve)).toBe(true);
    const a = m.current()!;
    expect(a.phase).toBe('arrived');
    const r = m.report([30, 5, -58], 17, resolve)!;
    expect(r.status).toBe('arrived');
    expect(r.outcome).toMatchObject({ success: true, simTime: 17, captureRadius: CAPTURE, plannedSimTime: 16, plannedPosition: [32, 5, -60] });
    expect(r.outcome!.goalPosition).toEqual([34, 5, -60]);
    expect(r.outcome!.plannedError).toBeCloseTo(2, 9);
    expect(r.outcome!.closestApproach).toBeCloseTo(Math.hypot(4, 0, 2), 9);
    expect(r.closestApproach).toBeCloseTo(r.outcome!.closestApproach, 9);
  });

  it('succeeds even when Baymax meets the object off the planned waypoint order', () => {
    const m = new RouteManager();
    m.offer(route(), 10);
    m.update([0, 0, -40], 10.5, resolve);
    expect(m.update([21, 5, -58], 10.6, resolve)).toBe(true);
    expect(m.current()?.phase).toBe('arrived');
    expect(m.current()?.outcome?.success).toBe(true);
  });

  it('tracks the closest approach every update, without notifying', () => {
    const m = new RouteManager();
    m.offer(route(), 10);
    m.update([0, 0, 0], 10, resolve);
    expect(m.report([0, 0, 0], 10, resolve)!.closestApproach).toBeCloseTo(Math.hypot(20, 5, 60), 9);
    m.update([10, 5, -40], 11, resolve);
    const d1 = Math.hypot(22 - 10, 0, -60 + 40);
    expect(m.report([10, 5, -40], 11, resolve)!.closestApproach).toBeCloseTo(d1, 9);
    m.update([0, 0, 0], 12, resolve); // moving away does not raise the closest value
    expect(m.report([0, 0, 0], 12, resolve)!.closestApproach).toBeCloseTo(d1, 9);
    expect(m.report([0, 0, 0], 12, resolve)!.outcome).toBeUndefined();
  });

  it('misses by time once the planned time plus the grace has passed', () => {
    const m = new RouteManager();
    m.offer(route(), 10);
    // Baymax shadows the object at a constant 30 m: the range never opens, so only the clock can end the route.
    const shadow = (t: number): Vec3Tuple => [truthAt(t)[0] - 30, 5, -60];
    m.update(shadow(11), 11, resolve);
    expect(m.update(shadow(16 + MISS_GRACE_SECONDS - 0.1), 16 + MISS_GRACE_SECONDS - 0.1, resolve)).toBe(false);
    expect(m.current()?.phase).toBe('active');
    expect(m.update(shadow(22.1), 16 + MISS_GRACE_SECONDS + 0.1, resolve)).toBe(true);
    const r = m.report(shadow(22.1), 22.1, resolve)!;
    expect(r.status).toBe('missed');
    expect(r.outcome!.success).toBe(false);
    expect(r.outcome!.closestApproach).toBeGreaterThan(CAPTURE);
    expect(r.outcome!.plannedError).not.toBeNull();
  });

  it('misses by distance when the range opens after the planned time', () => {
    const m = new RouteManager();
    m.offer(route(), 10);
    m.update([0, 0, -29], 11, resolve);
    // Before the planned time a rising distance is not a miss.
    m.update([25, 5, -50], 14, resolve);
    m.update([25, 5, -30], 15, resolve);
    expect(m.current()?.phase).toBe('active');
    m.update([30, 5, -48], 16.5, resolve); // closest so far ~ 13 m, outside capture
    expect(m.current()?.phase).toBe('active');
    expect(m.update([30, 5, -20], 17, resolve)).toBe(true);
    expect(m.current()?.phase).toBe('missed');
    expect(m.current()?.outcome?.success).toBe(false);
  });

  it('does not miss a route without an interception time, and never succeeds from a timer', () => {
    const m = new RouteManager();
    m.offer(route({ interception: null }), 10);
    m.update([0, 0, -29], 11, resolve);
    m.update([0, 0, -29], 500, resolve);
    expect(m.current()?.phase).toBe('active');
  });

  it('a replacing revision resets the closest approach and keeps the cue', () => {
    const m = new RouteManager();
    m.offer(route(), 10);
    m.update([20, 5, -50], 10, resolve);
    expect(m.current()?.closest?.distance).toBeCloseTo(10, 9);
    m.offer(route({ revision: 2 }), 11);
    expect(m.current()?.closest).toBeNull();
    expect(m.current()?.replacedRevision).toBe(1);
    expect(m.report([0, 0, 0], 11, resolve)!.outcome).toBeUndefined();
  });

  it('dismiss ends tracking without an outcome', () => {
    const m = new RouteManager();
    m.offer(route(), 10);
    m.update([0, 0, -29], 11, resolve);
    m.dismiss();
    expect(m.update([21, 5, -58], 11.5, resolve)).toBe(false);
    const r = m.report([0, 0, 0], 12, resolve)!;
    expect(r.status).toBe('cancelled');
    expect(r.outcome).toBeUndefined();
  });
});

describe('static goals keep their arrival semantics', () => {
  const approach = (over: Partial<RouteCommand> = {}) => route({
    goal: { id: 'isl-3', label: 'Island 3', category: 'island', motion: 'static' }, mode: 'approach', interception: null,
    waypoints: [{ id: 'w1', position: [0, 0, -30], kind: 'path', arrivalRadius: 6, etaSimTime: null }, { id: 'w2', position: [0, 40, -80], kind: 'approach', arrivalRadius: 8, etaSimTime: null }], ...over,
  });
  it('island: arrives at the approach waypoint, in order, with a reported outcome', () => {
    const m = new RouteManager();
    m.offer(approach(), 0);
    expect(m.update([0, 40, -78], 1)).toBe(false); // second waypoint is not skipped to
    expect(m.current()?.phase).toBe('active');
    m.update([0, 0, -30], 2);
    m.update([0, 38, -78], 3);
    const r = m.report([0, 38, -78], 3)!;
    expect(r.status).toBe('arrived');
    expect(r.outcome).toMatchObject({ success: true, plannedSimTime: null, plannedPosition: null, plannedError: null, captureRadius: 8 });
    expect(r.closestApproach).toBeUndefined();
  });
  it('fold entrance: the entrance radius decides, with true-position distance', () => {
    const fold: GoalResolver = () => ({ position: [0, 40, -80], captureRadius: 5 });
    const m = new RouteManager();
    m.offer(approach({ goal: { id: 'conn', label: 'Fold', category: 'fold', motion: 'static' }, mode: 'entrance' }), 0);
    m.update([0, 0, -30], 1, fold);
    m.update([0, 40, -70], 2, fold); // 10 m from entrance: not within 5 m
    expect(m.current()?.phase).toBe('active');
    m.update([0, 40, -77], 3, fold);
    expect(m.current()?.phase).toBe('arrived');
    expect(m.current()?.outcome?.closestApproach).toBeCloseTo(3, 9);
  });
  it('a static goal is never "missed"', () => {
    const m = new RouteManager();
    m.offer(approach(), 0);
    m.update([0, 0, 0], 9999);
    expect(m.current()?.phase).toBe('active');
  });
});
