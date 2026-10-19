import { Quaternion, Vector3 } from 'three';
import { createSeededRandom } from '../../simulation/seededRandom';
import type { Vec3 } from '../../simulation/types';
import { bridgeLike, clearanceViolation } from '../assets/placement';
import type { PlacementInputs } from '../assets/placement';
import { MIRROR_Y, cavernPoint, cavernRadius } from './layout';

/** Cosmetic spatial fractures (rendering only; never traversable, never a connection).
 *
 * Visual language, deliberately distinct from real folds: real folds are short
 * (3.1 m) lens-shaped tears in a state colour at simulated endpoints, with a
 * beacon, aperture lights and a gas passage. Fractures are long, thin, straight-
 * edged hairline networks with angular kinks and branches (shattered-space edges,
 * after the Design/ references, without any reflective panes), a constant pale
 * white-violet, a faint displaced echo of the main crack (parallax anomaly) and
 * drifting sparks. They have no interior, no opening and no state.
 *
 * Placement is seeded and world-anchored across many regions (chamber periphery,
 * ceiling, floor, entrance, funnel and distant cavern walls). Every sample along a
 * crack is kept clear of swept islands, fold endpoints (+ FOLD_GAP), aperture
 * sightline cones, traversal exits and the opening view, and main cracks never
 * line up between nearby islands. */

export interface FractureSegment { readonly a: Vec3; readonly b: Vec3; readonly core: number; readonly glow: number; readonly intensity: number; readonly s0: number; readonly s1: number; readonly echo: boolean }
export interface Fracture { readonly id: string; readonly region: string; readonly centre: Vec3; readonly radius: number; readonly phase: number; readonly segments: readonly FractureSegment[] }

/** Minimum distance (m) from any fold endpoint sample, so no fracture is mistaken for an aperture. */
export const FOLD_GAP = 14;

const v = (a: Vec3) => new Vector3(a[0], a[1], a[2]);
const arr = (a: Vector3): Vec3 => [a.x, a.y, a.z];

interface Anchor { readonly region: string; readonly centre: Vector3; readonly length: number; readonly scale: number; readonly gain?: number }

export function clearPoint(inputs: PlacementInputs, p: Vector3, radius: number): boolean {
  if (p.y < MIRROR_Y + 3) return false;
  if (clearanceViolation(inputs, arr(p), radius)) return false;
  for (const f of inputs.foldPoints) if (p.distanceToSquared(v(f)) < (FOLD_GAP + radius) ** 2) return false;
  return true;
}

export function layoutFractures(seed: number, inputs: PlacementInputs): Fracture[] {
  const r = createSeededRandom(seed ^ 0x7ac7e5);
  const centres = Object.values(inputs.islandCentres).map(v);
  const chamber = centres.reduce((s, c) => s.add(c), new Vector3()).divideScalar(Math.max(1, centres.length));
  const top = Math.max(...centres.map((c) => c.y)), bottom = Math.min(...centres.map((c) => c.y));
  const anchors: Anchor[] = [];
  // Chamber periphery: a broken ring of medium fractures around the islands.
  for (let i = 0; i < 7; i += 1) {
    const a = (i / 7) * Math.PI * 2 + r() * 0.5, rad = 58 + r() * 30;
    anchors.push({ region: 'chamber', centre: chamber.clone().add(new Vector3(Math.cos(a) * rad, (r() - 0.4) * 30, Math.sin(a) * rad * 0.9)), length: 30 + r() * 30, scale: 1.5 });
  }
  // Ceiling and floor.
  for (let i = 0; i < 3; i += 1) anchors.push({ region: 'ceiling', centre: chamber.clone().add(new Vector3((r() - 0.5) * 90, top - chamber.y + 26 + r() * 16, (r() - 0.5) * 90)), length: 40 + r() * 30, scale: 2 });
  for (let i = 0; i < 2; i += 1) anchors.push({ region: 'floor', centre: chamber.clone().add(new Vector3((r() - 0.5) * 80, bottom - chamber.y - 8 - r() * 5, (r() - 0.5) * 70)), length: 30 + r() * 20, scale: 1.8 });
  // Entrance corridor and vortex funnel walls.
  for (const u of [0.12, 0.2, 0.27]) {
    const c = v(cavernPoint(u)), rad = cavernRadius(u), a = r() * Math.PI * 2;
    anchors.push({ region: 'entrance', centre: c.add(new Vector3(Math.cos(a) * rad.horizontal * 0.72, Math.sin(a) * rad.up * 0.62, 0)), length: 14 + r() * 10, scale: 1 });
  }
  for (const u of [0.7, 0.78, 0.86]) {
    const c = v(cavernPoint(u)), rad = cavernRadius(u), a = r() * Math.PI * 2;
    anchors.push({ region: 'funnel', centre: c.add(new Vector3(Math.cos(a) * rad.horizontal * 0.6, Math.sin(a) * rad.up * 0.55, (r() - 0.5) * 20)), length: 45 + r() * 35, scale: 2.6, gain: 1.3 });
  }
  // Distant mega-fractures on the cavern walls: large structure at every distance.
  for (let i = 0; i < 5; i += 1) {
    const a = (i / 5) * Math.PI * 2 + 0.5 + r() * 0.5, rad = 170 + r() * 110;
    anchors.push({ region: 'distant', centre: chamber.clone().add(new Vector3(Math.cos(a) * rad, (r() - 0.3) * 70, Math.sin(a) * rad * 0.8 - 30)), length: 110 + r() * 90, scale: 6, gain: 2.2 });
  }

  // Restraint: one or two networks per region (supervisor review: fewer, softer, wider).
  const KEEP: Record<string, number> = { chamber: 2, ceiling: 1, floor: 1, entrance: 1, funnel: 1, distant: 2 };
  const kept: Record<string, number> = {};
  const out: Fracture[] = [];
  anchors.forEach((anchor, index) => {
    if ((kept[anchor.region] ?? 0) >= (KEEP[anchor.region] ?? 0)) return;
    // Faces the island chamber (seen broadside from the explorable space), tilted.
    const facing = chamber.clone().sub(anchor.centre).normalize();
    for (let attempt = 0; attempt < 8; attempt += 1) {
      const tilt = new Quaternion().setFromAxisAngle(new Vector3(r() - 0.5, r() - 0.5, r() - 0.5).normalize(), (r() - 0.5) * 0.9);
      const normal = facing.clone().applyQuaternion(tilt).normalize();
      const u = new Vector3().crossVectors(normal, Math.abs(normal.y) > 0.9 ? new Vector3(1, 0, 0) : new Vector3(0, 1, 0)).normalize();
      const w = new Vector3().crossVectors(normal, u);
      const angle = r() * Math.PI * 2;
      const dir = u.clone().multiplyScalar(Math.cos(angle)).addScaledVector(w, Math.sin(angle));
      if (bridgeLike(inputs, arr(anchor.centre), dir)) continue;
      const segments: FractureSegment[] = [];
      const pad = 2 + anchor.scale * 1.5;
      /** A straight-edged polyline with angular kinks, truncated at the first blocked sample. */
      const crack = (start: Vector3, heading: Vector3, length: number, pieces: number, core: number, glow: number, intensity: number, s0: number, s1: number, echo: boolean): Vector3[] => {
        const points = [start.clone()];
        let h = heading.clone(), p = start.clone();
        const clearSpan = (a: Vector3, b: Vector3) => { for (let t = 0; t <= 1.0001; t += 0.25) if (!clearPoint(inputs, a.clone().lerp(b, t), pad)) return false; return true; };
        for (let k = 0; k < pieces; k += 1) {
          const step = (length / pieces) * (0.7 + r() * 0.6);
          h = h.clone().applyAxisAngle(normal, (r() - 0.5) * 0.7).normalize();
          let q = p.clone().addScaledVector(h, step);
          // One sharper kink around an obstruction before the crack stops.
          if (!clearSpan(p, q)) { h = h.clone().applyAxisAngle(normal, r() < 0.5 ? 0.6 : -0.6); q = p.clone().addScaledVector(h, step); }
          if (!clearSpan(p, q)) break;
          const t0 = s0 + (s1 - s0) * (k / pieces), t1 = s0 + (s1 - s0) * ((k + 1) / pieces);
          segments.push({ a: arr(p), b: arr(q), core, glow, intensity: intensity * (anchor.gain ?? 1), s0: t0, s1: t1, echo });
          points.push(q); p = q;
        }
        return points;
      };
      const half = anchor.length / 2;
      const start = anchor.centre.clone().addScaledVector(dir, -half);
      if (!clearPoint(inputs, start, pad)) { start.copy(anchor.centre); }
      if (!clearPoint(inputs, start, pad)) continue;
      const core = 0.06 * anchor.scale + r() * 0.04 * anchor.scale, glow = 1.0 * anchor.scale + r() * 0.6 * anchor.scale;
      const main = crack(start, dir, anchor.length, 3 + Math.floor(r() * 4), core, glow, 1, 0, 1, false);
      if (main.length < 3) continue;
      // Displaced echo of the main crack: offset across its plane (parallax anomaly).
      const shift = normal.clone().multiplyScalar((0.9 + r() * 1.6) * anchor.scale).addScaledVector(dir, (r() - 0.5) * anchor.scale);
      for (let k = 1; k < main.length && false; k += 1) {
        const a = main[k - 1]!.clone().add(shift), b = main[k]!.clone().add(shift);
        if (clearPoint(inputs, a, pad) && clearPoint(inputs, b, pad)) segments.push({ a: arr(a), b: arr(b), core: core * 0.5, glow: glow * 0.9, intensity: 0.18 * (anchor.gain ?? 1), s0: (k - 1) / (main.length - 1), s1: k / (main.length - 1), echo: true });
      }
      // Branches (and the odd sub-branch) off the main crack.
      const branches = Math.floor(r() * 2);
      for (let b = 0; b < branches; b += 1) {
        const from = main[1 + Math.floor(r() * (main.length - 2))]!;
        const side = r() < 0.5 ? -1 : 1, offAngle = side * (0.35 + r() * 0.6);
        const heading = dir.clone().applyAxisAngle(normal, offAngle);
        const at = 0.25 + r() * 0.5;
        const points = crack(from, heading, anchor.length * (0.22 + r() * 0.3), 1 + Math.floor(r() * 3), core * 0.7, glow * 0.75, 0.75, at, at + 0.35, false);
        if (points.length > 2 && r() < 0.4) crack(points[1]!, heading.clone().applyAxisAngle(normal, -side * (0.4 + r() * 0.4)), anchor.length * 0.14, 1 + Math.floor(r() * 2), core * 0.5, glow * 0.6, 0.55, at + 0.2, at + 0.45, false);
      }
      const all = segments.flatMap((s) => [v(s.a), v(s.b)]);
      const c = all.reduce((s, p) => s.add(p), new Vector3()).divideScalar(all.length);
      kept[anchor.region] = (kept[anchor.region] ?? 0) + 1;
      out.push({ id: `fracture-${index}`, region: anchor.region, centre: arr(c), radius: Math.max(...all.map((p) => p.distanceTo(c))) + glow, phase: r() * Math.PI * 2, segments });
      break;
    }
  });
  return out;
}
