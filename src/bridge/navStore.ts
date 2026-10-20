import { RouteManager } from './navCore';
import type { ActiveRoute, GoalResolver } from './navCore';
import type { NavReport, Vec3Tuple } from '../shared/liveLink';

/** External store for the navigation HUD. The bridge writes routes into the manager; the per-frame guide updates progress. */
const manager = new RouteManager();
const listeners = new Set<() => void>();
let version = 0;
let resolver: GoalResolver | undefined;

const bump = () => { version += 1; listeners.forEach(l => l()); };
export const navManager = (): RouteManager => manager;
export const subscribeNav = (l: () => void): (() => void) => { listeners.add(l); return () => { listeners.delete(l); }; };
export const getNavVersion = (): number => version;
export const getActiveRoute = (): ActiveRoute | null => manager.current();
export const notifyNavChanged = bump;
export const setGoalResolver = (r: GoalResolver | undefined): void => { resolver = r; };
export const getGoalResolver = (): GoalResolver | undefined => resolver;

/** Called every frame with the true position; notifies subscribers only when progress changed. */
export function advanceNav(position: Vec3Tuple, simTime: number): NavReport | null {
  if (manager.update(position, simTime, resolver)) bump();
  return manager.report(position, simTime, resolver);
}
export function dismissNav(): void { manager.dismiss(); bump(); }
