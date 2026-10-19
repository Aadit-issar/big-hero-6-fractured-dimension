import { assetSpec } from '../scene/assets/assetRegistry';
import type { DimensionLayout } from '../scene/assets/placement';
import type { SceneObjectObservation, Vec3Tuple } from './atlasLinkProtocol';

/** Proximity radius of the scene-object scanner (world units, = metres). */
export const SCENE_SCAN_RANGE = 45;
/** Per-scan cap on reported objects (nearest first); the remainder is only counted. */
export const SCENE_SCAN_CAP = 160;
const dist = (a: Vec3Tuple, b: Vec3Tuple) => Math.hypot(a[0] - b[0], a[1] - b[1], a[2] - b[2]);

/** Pure scene-object scan: only objects within `range` of the observer are returned; the layout is never
 * serialised. Ids are positional indices of the seeded layout. */
export function scanSceneObjects(layout: DimensionLayout, observer: Vec3Tuple, range: number, cap = SCENE_SCAN_CAP): { objects: SceneObjectObservation[]; omitted: number } {
  const found: SceneObjectObservation[] = [];
  layout.debris.forEach((d, i) => {
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
  found.sort((a, b) => a.range - b.range || (a.id < b.id ? -1 : 1));
  return { objects: found.slice(0, cap), omitted: Math.max(0, found.length - cap) };
}

/** Peers may be loopback origins (the local demonstration) or the single origin named by ?atlasOrigin=. */
export function isAllowedOrigin(origin: string, explicit: string | null): boolean {
  if (explicit && origin === explicit) return true;
  try {
    const u = new URL(origin);
    return (u.protocol === 'http:' || u.protocol === 'https:') && ['127.0.0.1', 'localhost', '[::1]'].includes(u.hostname);
  } catch { return false; }
}

