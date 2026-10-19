import { Quaternion, Vector3 } from 'three';
import { createSeededRandom } from '../../simulation/seededRandom';
import type { Vec3 } from '../../simulation/types';
import { bridgeLike } from '../assets/placement';
import type { PlacementInputs } from '../assets/placement';
import { clearPoint } from './fractureLayout';
import { cavernPoint, cavernRadius } from './layout';

/** Cosmetic spatial tears (rendering only; never traversable, never a connection).
 *
 * Two classes complement the hairline fissures of fractureLayout.ts:
 *  - 'rift' (class A): rare, large (40–95 m) jagged gashes on the cavern walls and
 *    funnel, a dark starless void between luminous zig-zag lips; landmarks seen
 *    through the gas from far away.
 *  - 'shear' (class B): mid-size (14–34 m) narrow bands around the chamber in which
 *    the gas behind is shown displaced (a sheared copy of the gas frame) between
 *    thin bright edges.
 * Neither resembles a real fold: those are 3.1 m lens apertures in a state colour at
 * simulated endpoints, with a beacon and a gas passage. Tears are an order of
 * magnitude larger, angular, white-violet, stateless, and kept FOLD_GAP from every
 * fold endpoint, clear of islands, apertures, exits and the opening view; shears are
 * never aligned between nearby islands (no bridge reading). */

export type TearKind = 'rift' | 'shear';
export interface Tear {
  readonly id: string; readonly kind: TearKind; readonly region: string;
  readonly centre: Vec3; readonly axis: Vec3; readonly normal: Vec3;
  readonly halfLength: number; readonly halfWidth: number; readonly seed: number; readonly intensity: number;
}

const v = (a: Vec3) => new Vector3(a[0], a[1], a[2]);
const arr = (a: Vector3): Vec3 => [a.x, a.y, a.z];

interface Anchor { readonly kind: TearKind; readonly region: string; readonly centre: Vector3; readonly length: number; readonly intensity: number }

export function layoutTears(seed: number, inputs: PlacementInputs): Tear[] {
  const r = createSeededRandom(seed ^ 0x7e4125);
  const centres = Object.values(inputs.islandCentres).map(v);
  const chamber = centres.reduce((s, c) => s.add(c), new Vector3()).divideScalar(Math.max(1, centres.length));
  const top = Math.max(...centres.map((c) => c.y));
  const anchors: Anchor[] = [];
  // Class A: distant rifts in a broken ring on the cavern walls, one high above, one in the funnel.
  for (let i = 0; i < 6; i += 1) {
    const a = (i / 6) * Math.PI * 2 + 0.3 + r() * 0.6, rad = 150 + r() * 90;
    anchors.push({ kind: 'rift', region: 'distant', centre: chamber.clone().add(new Vector3(Math.cos(a) * rad, (r() - 0.35) * 60, Math.sin(a) * rad * 0.8 - 25)), length: 55 + r() * 40, intensity: 1 });
  }
  anchors.push({ kind: 'rift', region: 'ceiling', centre: chamber.clone().add(new Vector3((r() - 0.5) * 60, top - chamber.y + 55 + r() * 20, (r() - 0.5) * 60)), length: 50 + r() * 25, intensity: 0.9 });
  for (const u of [0.8]) {
    const c = v(cavernPoint(u)), rad = cavernRadius(u), a = r() * Math.PI * 2;
    anchors.push({ kind: 'rift', region: 'funnel', centre: c.add(new Vector3(Math.cos(a) * rad.horizontal * 0.7, Math.sin(a) * rad.up * 0.6, (r() - 0.5) * 16)), length: 34 + r() * 16, intensity: 1 });
  }
  // Class B: shears around the chamber periphery, at the entrance and below the islands.
  for (let i = 0; i < 6; i += 1) {
    const a = (i / 6) * Math.PI * 2 + r() * 0.7, rad = 48 + r() * 34;
    anchors.push({ kind: 'shear', region: 'chamber', centre: chamber.clone().add(new Vector3(Math.cos(a) * rad, (r() - 0.45) * 34, Math.sin(a) * rad * 0.9)), length: 18 + r() * 16, intensity: 0.85 });
  }
  {
    const u = 0.18, c = v(cavernPoint(u)), rad = cavernRadius(u), a = r() * Math.PI * 2;
    anchors.push({ kind: 'shear', region: 'entrance', centre: c.add(new Vector3(Math.cos(a) * rad.horizontal * 0.7, Math.sin(a) * rad.up * 0.6, 0)), length: 14 + r() * 8, intensity: 0.8 });
  }

  const out: Tear[] = [];
  anchors.forEach((anchor, index) => {
    const facing = chamber.clone().sub(anchor.centre).normalize();
    for (let attempt = 0; attempt < 10; attempt += 1) {
      // Seen broadside from the explorable space, tilted, with the long axis free in the plane.
      const tilt = new Quaternion().setFromAxisAngle(new Vector3(r() - 0.5, r() - 0.5, r() - 0.5).normalize(), (r() - 0.5) * 0.8);
      const normal = facing.clone().applyQuaternion(tilt).normalize();
      const u = new Vector3().crossVectors(normal, Math.abs(normal.y) > 0.9 ? new Vector3(1, 0, 0) : new Vector3(0, 1, 0)).normalize();
      const w = new Vector3().crossVectors(normal, u);
      const angle = r() * Math.PI * 2;
      const axis = u.clone().multiplyScalar(Math.cos(angle)).addScaledVector(w, Math.sin(angle));
      const halfLength = (anchor.length / 2) * (0.85 + r() * 0.3);
      const halfWidth = halfLength * (anchor.kind === 'rift' ? 0.16 + r() * 0.07 : 0.08 + r() * 0.03);
      const centre = anchor.centre.clone().addScaledVector(axis, (r() - 0.5) * 6);
      if (anchor.kind === 'shear' && bridgeLike(inputs, arr(centre), axis)) continue;
      let clear = true;
      for (let k = -4; k <= 4 && clear; k += 1) clear = clearPoint(inputs, centre.clone().addScaledVector(axis, (k / 4) * halfLength), halfWidth + 2);
      if (!clear) continue;
      out.push({ id: `tear-${index}`, kind: anchor.kind, region: anchor.region, centre: arr(centre), axis: arr(axis), normal: arr(normal), halfLength, halfWidth, seed: r() * 100, intensity: anchor.intensity });
      break;
    }
  });
  return out;
}
