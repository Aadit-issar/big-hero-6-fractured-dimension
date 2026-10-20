import type { QuatTuple, Vec3Tuple } from '../shared/liveLink';

/** Pure camera maths for the navigation HUD: world point → camera space → screen. No DOM, no three.js. */

/** Rotates a world-space vector into camera space (inverse of the camera quaternion). The camera looks along its local −Z. */
export function toCameraSpace(delta: Vec3Tuple, q: QuatTuple): Vec3Tuple {
  const qx = -q[0], qy = -q[1], qz = -q[2], qw = q[3];
  const tx = 2 * (qy * delta[2] - qz * delta[1]), ty = 2 * (qz * delta[0] - qx * delta[2]), tz = 2 * (qx * delta[1] - qy * delta[0]);
  return [delta[0] + qw * tx + (qy * tz - qz * ty), delta[1] + qw * ty + (qz * tx - qx * tz), delta[2] + qw * tz + (qx * ty - qy * tx)];
}

export interface ScreenPoint {
  /** Pixels from the top-left of the viewport (may be outside it). */
  readonly x: number;
  readonly y: number;
  /** Distance along the viewing direction (negative = behind the camera). */
  readonly depth: number;
  readonly distance: number;
  readonly inFront: boolean;
  readonly onScreen: boolean;
  /** Camera-relative offsets in metres: right, up, ahead. */
  readonly right: number;
  readonly up: number;
  readonly ahead: number;
}

export function projectToScreen(point: Vec3Tuple, cameraPosition: Vec3Tuple, q: QuatTuple, fovYDeg: number, width: number, height: number, margin = 0): ScreenPoint {
  const d: Vec3Tuple = [point[0] - cameraPosition[0], point[1] - cameraPosition[1], point[2] - cameraPosition[2]];
  const c = toCameraSpace(d, q);
  const ahead = -c[2];
  const f = 1 / Math.tan((fovYDeg * Math.PI / 180) / 2);
  const aspect = width / height;
  const inFront = ahead > 1e-4;
  // NDC; for points behind the camera the sign is flipped so the result still points the right way round the screen centre.
  const w = inFront ? ahead : -ahead || 1e-4;
  const ndcX = (c[0] * f / aspect) / w * (inFront ? 1 : -1);
  const ndcY = (c[1] * f) / w * (inFront ? 1 : -1);
  const x = (ndcX * 0.5 + 0.5) * width, y = (1 - (ndcY * 0.5 + 0.5)) * height;
  return {
    x, y, depth: ahead, distance: Math.hypot(d[0], d[1], d[2]), inFront,
    onScreen: inFront && x >= margin && x <= width - margin && y >= margin && y <= height - margin,
    right: c[0], up: c[1], ahead,
  };
}

export interface EdgeIndicator { readonly x: number; readonly y: number; readonly angle: number }

/** Clamps a (possibly off-screen or behind-the-camera) point to a rounded rectangle inset by `margin`, with the arrow angle (radians, screen space, 0 = right, clockwise).
 * A point behind the camera is pushed to the lower edge on the side it lies on, never mirrored through the centre. */
export function clampToEdge(p: ScreenPoint, width: number, height: number, margin: number, insets?: { l: number; t: number; r: number; b: number }): EdgeIndicator {
  const ins = insets ?? { l: margin, t: margin, r: margin, b: margin };
  const cx = (ins.l + width - ins.r) / 2, cy = (ins.t + height - ins.b) / 2;
  const hw = (width - ins.l - ins.r) / 2, hh = (height - ins.t - ins.b) / 2;
  let dx = p.x - cx, dy = p.y - cy;
  if (!p.inFront) {
    // Behind: use the lateral/vertical offset directly, biased downward so "behind you" reads as a turn-around cue.
    dx = p.right * 1000; dy = -p.up * 1000 + height;
  }
  if (Math.abs(dx) < 1e-6 && Math.abs(dy) < 1e-6) dy = 1;
  const sx = hw / Math.abs(dx || 1e-9), sy = hh / Math.abs(dy || 1e-9);
  const s = Math.min(sx, sy);
  return { x: cx + dx * s, y: cy + dy * s, angle: Math.atan2(dy, dx) };
}

export type GuidanceMode = 'far' | 'near' | 'precision';
/** The HUD sharpens as Baymax closes in: far (coarse marker), near (<40 m: marker + offsets), precision (<12 m: reticle with camera-relative offsets). */
export function guidanceMode(distance: number, arrivalRadius: number): GuidanceMode {
  if (distance <= Math.max(12, arrivalRadius * 2.5)) return 'precision';
  if (distance <= 40) return 'near';
  return 'far';
}

export function describeElevation(dy: number): string {
  const a = Math.abs(dy);
  if (a < 1) return 'level';
  return `${a.toFixed(a < 10 ? 1 : 0)} m ${dy > 0 ? 'above' : 'below'}`;
}

export function describeOffsets(right: number, up: number, ahead: number): string {
  const part = (v: number, pos: string, neg: string) => (Math.abs(v) < 0.5 ? null : `${Math.abs(v).toFixed(Math.abs(v) < 10 ? 1 : 0)} m ${v > 0 ? pos : neg}`);
  return [part(ahead, 'ahead', 'behind'), part(right, 'right', 'left'), part(up, 'up', 'down')].filter(Boolean).join(' · ') || 'on target';
}

/** Projects the segment a→b, clipped to the camera's near plane, or null if it lies wholly behind the camera. */
export function projectSegment(a: Vec3Tuple, b: Vec3Tuple, cameraPosition: Vec3Tuple, q: QuatTuple, fovYDeg: number, width: number, height: number, near = 0.2): { x1: number; y1: number; x2: number; y2: number } | null {
  const ca = toCameraSpace([a[0] - cameraPosition[0], a[1] - cameraPosition[1], a[2] - cameraPosition[2]], q);
  const cb = toCameraSpace([b[0] - cameraPosition[0], b[1] - cameraPosition[1], b[2] - cameraPosition[2]], q);
  let za = -ca[2], zb = -cb[2];
  if (za < near && zb < near) return null;
  let pa = ca, pb = cb;
  if (za < near) { const t = (near - za) / (zb - za); pa = [ca[0] + (cb[0] - ca[0]) * t, ca[1] + (cb[1] - ca[1]) * t, ca[2] + (cb[2] - ca[2]) * t]; za = near; }
  else if (zb < near) { const t = (near - zb) / (za - zb); pb = [cb[0] + (ca[0] - cb[0]) * t, cb[1] + (ca[1] - cb[1]) * t, cb[2] + (ca[2] - cb[2]) * t]; zb = near; }
  const f = 1 / Math.tan((fovYDeg * Math.PI / 180) / 2), aspect = width / height;
  const px = (c: Vec3Tuple, z: number) => ({ x: ((c[0] * f / aspect) / z * 0.5 + 0.5) * width, y: (1 - ((c[1] * f) / z * 0.5 + 0.5)) * height });
  const A = px(pa, za), B = px(pb, zb);
  return { x1: A.x, y1: A.y, x2: B.x, y2: B.y };
}
