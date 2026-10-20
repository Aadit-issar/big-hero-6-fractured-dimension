import { describe, expect, it } from 'vitest';
import { DASH, DASH_PERIOD, allocRibbon, arcFromEnd, countdown, dashOn, fillRibbon, remainingTargetPath, ribbonVertexPosition, routePoints } from '../src/scene/nav/routeGeometry';
import { plannedTargetAt } from '../src/bridge/navCore';
import type { RouteCommand, Vec3Tuple } from '../src/shared/liveLink';

const wp = (id: string, position: Vec3Tuple, kind: 'path' | 'intercept' = 'path') => ({ id, position, kind, arrivalRadius: 5, etaSimTime: null });
const route = { waypoints: [wp('a', [0, 0, -10]), wp('b', [0, 0, -30]), wp('c', [20, 0, -30], 'intercept')] } as unknown as RouteCommand;

describe('route polyline', () => {
  it('starts at Baymax and passes only the remaining waypoints, in order', () => {
    expect(routePoints([1, 2, 3], route, 0)).toEqual([[1, 2, 3], [0, 0, -10], [0, 0, -30], [20, 0, -30]]);
    expect(routePoints([1, 2, 3], route, 2)).toEqual([[1, 2, 3], [20, 0, -30]]);
    expect(routePoints([1, 2, 3], route, 9)).toEqual([[1, 2, 3], [20, 0, -30]]);
  });
  it('measures arc length in metres from the end, so dash phase does not move with Baymax', () => {
    const a = arcFromEnd([[5, 0, 0], [0, 0, -10], [0, 0, -30], [20, 0, -30]]);
    expect(a[3]).toBe(0); expect(a[2]).toBeCloseTo(20, 9); expect(a[1]).toBeCloseTo(40, 9);
    // The same waypoints from a different Baymax position leave the arc length of every waypoint unchanged.
    const b = arcFromEnd([[0, 9, 9], [0, 0, -10], [0, 0, -30], [20, 0, -30]]);
    expect(b.slice(1)).toEqual(a.slice(1));
  });
});

describe('dash pattern in world metres', () => {
  it('repeats exactly every DASH_PERIOD metres, with the stated on/off lengths', () => {
    for (const u of [0.2, 1.0, 1.6, 1.8, 2.9]) expect(dashOn(u)).toBe(dashOn(u + DASH_PERIOD * 7));
    expect(dashOn(DASH.on - 0.01)).toBe(true);
    expect(dashOn(DASH.on + 0.01)).toBe(false);
    let on = 0; const n = 30000;
    for (let i = 0; i < n; i += 1) if (dashOn((i / n) * DASH_PERIOD * 100)) on += 1;
    expect(on / n).toBeCloseTo(DASH.on / DASH_PERIOD, 2);
  });
});

describe('ribbon arrays', () => {
  const pts: Vec3Tuple[] = [[3, 1, 0], [0, 0, -10], [0, 0, -30], [20, 0, -30]];
  it('draws exactly the transmitted legs: the last vertex is the last waypoint', () => {
    const arrays = allocRibbon(26);
    const n = fillRibbon(arrays, pts);
    expect(n).toBe(3);
    // Vertices with t = 1 sit at the segment end; the last segment's end is the final waypoint.
    const end = ribbonVertexPosition(arrays, (n - 1) * 4 + 3);
    expect(end).toEqual([20, 0, -30]);
    expect(ribbonVertexPosition(arrays, 0)).toEqual([3, 1, 0]);
    // Consecutive legs share their joint exactly, with continuous arc length.
    expect(arrays.u[1]).toBeCloseTo(arrays.u[2 * 4]!, 5);
  });
  it('skips zero-length legs', () => {
    expect(fillRibbon(allocRibbon(4), [[0, 0, 0], [0, 0, 0], [1, 0, 0]])).toBe(1);
  });
});

describe('projected target', () => {
  const i = { position: [10, 0, 0] as Vec3Tuple, simTime: 20, targetNow: [0, 0, 0] as Vec3Tuple, targetObservedAt: 10, uncertainty: 1, targetPath: [{ simTime: 10, position: [0, 0, 0] as Vec3Tuple }, { simTime: 20, position: [10, 0, 0] as Vec3Tuple }, { simTime: 30, position: [10, 10, 0] as Vec3Tuple }] };
  it('evaluates the forecast at the planned time exactly', () => {
    expect(plannedTargetAt(i, 20)).toEqual([10, 0, 0]);
    expect(plannedTargetAt(i, 25)).toEqual([10, 5, 0]);
  });
  it('keeps only the part of the forecast path that lies ahead', () => {
    const rest = remainingTargetPath(i.targetPath, 15, t => plannedTargetAt(i, t));
    expect(rest).toEqual([[5, 0, 0], [10, 0, 0], [10, 10, 0]]);
    expect(remainingTargetPath(i.targetPath, 35, t => plannedTargetAt(i, t))).toEqual([]);
  });
  it('counts real simulation time down to the rendezvous and stops at zero', () => {
    expect(countdown(20, 14.5)).toBeCloseTo(5.5, 9);
    expect(countdown(20, 25)).toBe(0);
  });
});
