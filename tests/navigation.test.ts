import { describe, expect, it } from 'vitest';
import { RouteManager } from '../src/bridge/navCore';
import type { GoalResolver } from '../src/bridge/navCore';
import { clampToEdge, describeElevation, describeOffsets, guidanceMode, projectSegment, projectToScreen, toCameraSpace } from '../src/bridge/hudProjection';
import { parseRouteCommand } from '../src/shared/liveLink';
import type { QuatTuple, RouteCommand, Vec3Tuple } from '../src/shared/liveLink';

const IDENTITY: QuatTuple = [0, 0, 0, 1];
const yaw = (a: number): QuatTuple => [0, Math.sin(a / 2), 0, Math.cos(a / 2)];
const pitch = (a: number): QuatTuple => [Math.sin(a / 2), 0, 0, Math.cos(a / 2)];
const W = 1600, H = 900, FOV = 56;

const route = (over: Partial<RouteCommand> = {}): RouteCommand => ({
  routeId: 'r1', revision: 1, atlasSession: 'atlas-A', goal: { id: 'capsule-abigail', label: "Abigail's Capsule", category: 'landmark', motion: 'moving' },
  mode: 'intercept', issuedSimTime: 10, speed: 12,
  waypoints: [
    { id: 'w1', position: [0, 0, -30], kind: 'path', arrivalRadius: 6, etaSimTime: 12 },
    { id: 'w2', position: [20, 5, -60], kind: 'intercept', arrivalRadius: 5, etaSimTime: 16 },
  ],
  interception: { position: [20, 5, -60], simTime: 16, targetNow: [10, 5, -40], targetObservedAt: 10, uncertainty: 1.4 },
  reason: 'test', assumptions: [], supersedes: null, ...over,
});

describe('route intake', () => {
  it('accepts a well-formed route and acknowledges it', () => {
    const m = new RouteManager();
    const offer = m.offer(route(), 10);
    expect(offer.accepted).toBe(true);
    expect(offer.ack).toMatchObject({ status: 'accepted', code: 'ok', routeId: 'r1', revision: 1 });
    expect(m.current()?.phase).toBe('active');
  });

  it('ignores obsolete and duplicate revisions from the same ATLAS page, and accepts a new page', () => {
    const m = new RouteManager();
    m.offer(route({ revision: 5 }), 10);
    expect(m.offer(route({ revision: 5 }), 11).ack.code).toBe('stale-revision');
    expect(m.offer(route({ revision: 4 }), 11).ack.code).toBe('stale-revision');
    expect(m.current()?.route.revision).toBe(5);
    expect(m.offer(route({ revision: 6 }), 12).accepted).toBe(true);
    expect(m.current()?.replacedRevision).toBe(5);
    // A reloaded ATLAS has a new page session and starts counting again.
    expect(m.offer(route({ revision: 1, atlasSession: 'atlas-B' }), 13).accepted).toBe(true);
  });

  it('rejects malformed routes without throwing', () => {
    const m = new RouteManager();
    for (const bad of [null, 5, {}, { ...route(), waypoints: [] }, { ...route(), speed: -1 }, { ...route(), waypoints: [{ ...route().waypoints[0], position: [1, 2] }] }, { ...route(), mode: 'teleport' }, { ...route(), waypoints: [{ ...route().waypoints[0], position: [NaN, 0, 0] }] }]) {
      const offer = m.offer(bad, 1);
      expect(offer.accepted).toBe(false);
      expect(offer.ack.code).toBe('invalid');
    }
    expect(m.current()).toBeNull();
    expect(parseRouteCommand({ ...route(), waypoints: Array.from({ length: 40 }, (_, i) => ({ id: `w${i}`, position: [0, 0, i], kind: 'path', arrivalRadius: 3, etaSimTime: null })) })).toBeNull();
  });

  it('cancels only the matching route and drops everything on clear (stale session)', () => {
    const m = new RouteManager();
    m.offer(route(), 1);
    expect(m.cancel('other', 9, 2).ack.code).toBe('unknown-route');
    expect(m.cancel('r1', 1, 2).ack.status).toBe('cancelled');
    expect(m.current()?.phase).toBe('cancelled');
    m.clear();
    expect(m.current()).toBeNull();
  });
});

describe('waypoint progression and arrival', () => {
  it('advances in order and arrives at the real object, not at the planned meeting point', () => {
    const truth: Vec3Tuple = [26, 8, -58];
    const resolve: GoalResolver = () => ({ position: truth, captureRadius: 6.4 });
    const m = new RouteManager();
    m.offer(route(), 10);
    expect(m.update([0, 0, 0], 11, resolve)).toBe(false);
    expect(m.update([1, 0, -28], 12, resolve)).toBe(true);
    expect(m.current()?.activeIndex).toBe(1);
    // At the planned meeting point but 6.7 m from the true capsule: not arrived.
    expect(m.update([20, 5, -60], 16, resolve)).toBe(false);
    expect(m.current()?.phase).toBe('active');
    expect(m.update([23, 6, -57], 17, resolve)).toBe(true);
    expect(m.current()?.phase).toBe('arrived');
    expect(m.current()?.arrivedAtSimTime).toBe(17);
  });

  it('does not skip waypoints it has not passed, and passes several in one fast step', () => {
    const m = new RouteManager();
    m.offer(route({ waypoints: [
      { id: 'a', position: [0, 0, -10], kind: 'path', arrivalRadius: 4, etaSimTime: null },
      { id: 'b', position: [0, 0, -14], kind: 'path', arrivalRadius: 4, etaSimTime: null },
      { id: 'c', position: [0, 0, -50], kind: 'approach', arrivalRadius: 6, etaSimTime: null },
    ] }), 0);
    m.update([0, 0, -12], 1);
    expect(m.current()?.activeIndex).toBe(2);
    expect(m.current()?.reached.map(r => r.index)).toEqual([0, 1]);
    expect(m.report([0, 0, -12], 1)?.distanceToWaypoint).toBeCloseTo(38, 5);
  });

  it('reports the true goal distance when the goal is a known object', () => {
    const m = new RouteManager();
    m.offer(route(), 0);
    const r = m.report([0, 0, 0], 0, () => ({ position: [30, 0, 40], captureRadius: 5 }));
    expect(r?.distanceToGoal).toBeCloseTo(50, 9);
    expect(r?.status).toBe('active');
  });
});

describe('HUD projection: no marker may point somewhere unrelated', () => {
  const at = (p: Vec3Tuple, q: QuatTuple = IDENTITY, cam: Vec3Tuple = [0, 0, 0]) => projectToScreen(p, cam, q, FOV, W, H);

  it('puts a target dead ahead at the centre of the screen', () => {
    const s = at([0, 0, -40]);
    expect(s.inFront).toBe(true);
    expect(s.x).toBeCloseTo(W / 2, 6);
    expect(s.y).toBeCloseTo(H / 2, 6);
    expect(s.distance).toBeCloseTo(40, 9);
    expect(s.ahead).toBeCloseTo(40, 9);
  });

  it('places right/left/above/below targets on the right side of the screen centre', () => {
    expect(at([10, 0, -40]).x).toBeGreaterThan(W / 2);
    expect(at([-10, 0, -40]).x).toBeLessThan(W / 2);
    expect(at([0, 10, -40]).y).toBeLessThan(H / 2);
    expect(at([0, -10, -40]).y).toBeGreaterThan(H / 2);
  });

  it('matches the field of view: a point at the top edge angle lands on the top edge', () => {
    const half = (FOV / 2) * Math.PI / 180;
    const s = at([0, 40 * Math.tan(half), -40]);
    expect(s.y).toBeCloseTo(0, 5);
  });

  it('flags targets behind the camera and keeps them off screen', () => {
    const s = at([0, 0, 30]);
    expect(s.inFront).toBe(false);
    expect(s.onScreen).toBe(false);
    expect(s.depth).toBeLessThan(0);
  });

  it('follows camera yaw: turning towards the target centres it, turning away pushes it off screen', () => {
    const target: Vec3Tuple = [-40, 0, 0]; // 90 degrees to the left of the default forward (-Z)
    expect(at(target).onScreen).toBe(false);
    const turned = at(target, yaw(Math.PI / 2)); // positive yaw about +Y turns left
    expect(turned.x).toBeCloseTo(W / 2, 5);
    expect(turned.onScreen).toBe(true);
    expect(at(target, yaw(-Math.PI / 2)).inFront).toBe(false);
  });

  it('follows camera pitch and a camera translation', () => {
    const above: Vec3Tuple = [0, 40, -40];
    expect(at(above, pitch(Math.PI / 4)).y).toBeCloseTo(H / 2, 5);
    const moved = at([100, 20, -240], IDENTITY, [100, 20, -200]);
    expect(moved.x).toBeCloseTo(W / 2, 6);
    expect(moved.distance).toBeCloseTo(40, 9);
  });

  it('stays well defined at close range (under ten metres) and reports camera-relative offsets', () => {
    const near = at([1.5, -0.8, -4]);
    expect(near.onScreen).toBe(true);
    expect(near.right).toBeCloseTo(1.5, 9);
    expect(near.up).toBeCloseTo(-0.8, 9);
    expect(near.ahead).toBeCloseTo(4, 9);
    expect(guidanceMode(near.distance, 5)).toBe('precision');
    expect(describeOffsets(near.right, near.up, near.ahead)).toBe('4.0 m ahead · 1.5 m right · 0.8 m down');
    expect(describeOffsets(0.1, 0.1, 0.1)).toBe('on target');
  });

  it('switches guidance density with distance and describes elevation', () => {
    expect(guidanceMode(120, 5)).toBe('far');
    expect(guidanceMode(25, 5)).toBe('near');
    expect(guidanceMode(9, 5)).toBe('precision');
    expect(describeElevation(0.4)).toBe('level');
    expect(describeElevation(12.6)).toBe('13 m above');
    expect(describeElevation(-3.25)).toBe('3.3 m below');
  });

  it('inverse rotation is the exact inverse of the camera quaternion', () => {
    const q = yaw(0.7);
    const forward = toCameraSpace([-Math.sin(0.7), 0, -Math.cos(0.7)], q);
    expect(forward[0]).toBeCloseTo(0, 9);
    expect(forward[2]).toBeCloseTo(-1, 9);
  });

  it('clamps off-screen markers to the edge on the correct side', () => {
    const left = clampToEdge(at([-100, 0, -20]), W, H, 54);
    expect(left.x).toBeCloseTo(54, 3);
    const right = clampToEdge(at([100, 0, -20]), W, H, 54);
    expect(right.x).toBeCloseTo(W - 54, 3);
    const above = clampToEdge(at([0, 100, -20]), W, H, 54);
    expect(above.y).toBeCloseTo(54, 3);
    // Behind and to the right: pinned to the right half of the lower edge, never mirrored to the left.
    const behindRight = clampToEdge(at([10, 0, 40]), W, H, 54);
    expect(behindRight.x).toBeGreaterThan(W / 2);
    expect(behindRight.y).toBeGreaterThan(H / 2);
  });

  it('clips route segments at the near plane', () => {
    expect(projectSegment([0, 0, 10], [0, 0, 20], [0, 0, 0], IDENTITY, FOV, W, H)).toBeNull();
    const crossing = projectSegment([0, 0, 10], [0, 0, -40], [0, 0, 0], IDENTITY, FOV, W, H);
    expect(crossing).not.toBeNull();
    expect(Number.isFinite(crossing!.x1) && Number.isFinite(crossing!.y2)).toBe(true);
    expect(crossing!.x2).toBeCloseTo(W / 2, 5);
  });
});
