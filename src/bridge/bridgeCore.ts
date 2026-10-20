import { assetSpec } from '../scene/assets/assetRegistry';
import type { DebrisInstance, DimensionLayout } from '../scene/assets/placement';
import { DEFAULT_SENSOR_RANGE } from '../shared/atlasContract';
import type { ObservedDisturbance } from '../shared/liveLink';
import type { DisturbanceState, MoverDef, MoverState } from '../world/movers';
import type { SceneObjectObservation, Vec3Tuple } from './atlasLinkProtocol';

/** Proximity radius of the scene-object scanner (world units, = metres). */
export const SCENE_SCAN_RANGE = 45;
/** Moving objects carry a transponder and are acquired out to the sensor range of the main observation (Abigail's capsule has a longer-range distress beacon). */
export const MOVER_DETECTION_RANGE = DEFAULT_SENSOR_RANGE;
/** Per-scan cap on reported objects (nearest first); the remainder is only counted. */
export const SCENE_SCAN_CAP = 160;
const dist = (a: Vec3Tuple, b: Vec3Tuple) => Math.hypot(a[0] - b[0], a[1] - b[1], a[2] - b[2]);

/** The one capsule shell in the Dimension is Abigail's moving capsule, so the scattered layout's own copy is not drawn or reported. */
export const isSuppressedStatic = (d: DebrisInstance): boolean => d.asset === 'capsule_shell_remnant' && d.cluster === 'landmark';

/** Pure scene-object scan: only objects within `range` of the observer are returned; the layout is never
 * serialised. Ids are positional indices of the seeded layout. Moving objects (if given) are acquired within MOVER_DETECTION_RANGE
 * and are reported by their stable id with their attitude, never their velocity. */
export function scanSceneObjects(
  layout: DimensionLayout, observer: Vec3Tuple, range: number, cap = SCENE_SCAN_CAP,
  movers: { readonly states: readonly MoverState[]; readonly defs: readonly MoverDef[] } = { states: [], defs: [] },
): { objects: SceneObjectObservation[]; omitted: number } {
  const found: SceneObjectObservation[] = [];
  layout.debris.forEach((d, i) => {
    if (isSuppressedStatic(d)) return;
    const r = dist(observer, d.position);
    if (r > range) return;
    const spec = assetSpec(d.asset);
    found.push({ id: `obj-${String(i).padStart(3, '0')}`, category: spec.category, family: spec.family, kind: d.asset, position: [d.position[0], d.position[1], d.position[2]], radius: d.radius, range: r });
  });
  layout.formations.forEach(f => {
    const r = dist(observer, f.centre);
    if (r > range) return;
    found.push({ id: `formation-${f.id}`, category: 'microbot', family: 'microbot', kind: `microbot_${f.kind}`, position: [f.centre[0], f.centre[1], f.centre[2]], radius: f.radius, range: r });
  });
  for (const state of movers.states) {
    const def = movers.defs.find(m => m.id === state.id);
    if (!def) continue;
    const r = dist(observer, state.position);
    if (r > (def.beaconRange ?? MOVER_DETECTION_RANGE)) continue;
    found.push({ id: def.id, category: def.category, family: def.family, kind: def.assetId, label: def.label, orientation: state.quaternion, position: [state.position[0], state.position[1], state.position[2]], radius: def.radius, range: r });
  }
  found.sort((a, b) => a.range - b.range || (a.id < b.id ? -1 : 1));
  return { objects: found.slice(0, cap), omitted: Math.max(0, found.length - cap) };
}

/** Disturbance regions whose centre is within sensor range of the observer. */
export function scanDisturbances(observer: Vec3Tuple, states: readonly DisturbanceState[], range = MOVER_DETECTION_RANGE): ObservedDisturbance[] {
  return states.filter(s => dist(observer, s.position) <= range + s.radius).map(s => ({ id: s.id, label: s.label, position: [s.position[0], s.position[1], s.position[2]] as const, radius: s.radius, intensity: s.intensity }));
}

/** Peers may be loopback origins (the local demonstration) or the single origin named by ?atlasOrigin=. */
export function isAllowedOrigin(origin: string, explicit: string | null): boolean {
  if (explicit && origin === explicit) return true;
  try {
    const u = new URL(origin);
    return (u.protocol === 'http:' || u.protocol === 'https:') && ['127.0.0.1', 'localhost', '[::1]'].includes(u.hostname);
  } catch { return false; }
}
