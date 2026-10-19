/** ATLAS advisory: validation and presentation maths for the in-Dimension advisor. Pure and DOM-free.
 *
 * An advisory is DATA from a linked ATLAS window (a recommendation, a target position, a few waypoints and short strings). It is
 * validated field by field, bounded in size and tied to this Dimension's session; it can never be a command and nothing here
 * touches the simulation. */
export const ADVISORY_VERSION = 1;
export const ADVISORY_STALE_MS = 6000;

export type Vec3 = readonly [number, number, number];
export interface Advisory {
  readonly seq: number;
  readonly status: 'route' | 'needs-revalidation' | 'no-route' | 'explore' | 'abstain';
  readonly episode: number;
  readonly simTime: number | null;
  readonly goal: { readonly id: string; readonly label: string } | null;
  readonly title: string;
  readonly detail: string;
  readonly action: 'follow-route' | 'observe' | 'refresh' | 'none';
  readonly target: Vec3 | null;
  readonly waypoints: readonly Vec3[];
  readonly segments: readonly { readonly kind: 'fold' | 'approach' | 'track'; readonly caution: boolean; readonly remembered: boolean }[];
  readonly limitations: readonly string[];
  readonly goals: readonly { readonly id: string; readonly label: string }[];
}

const STATUSES = ['route', 'needs-revalidation', 'no-route', 'explore', 'abstain'];
const ACTIONS = ['follow-route', 'observe', 'refresh', 'none'];
const KINDS = ['fold', 'approach', 'track'];
const finite = (v: unknown): v is number => typeof v === 'number' && Number.isFinite(v);
const COORD_LIMIT = 100_000;
const vec3 = (v: unknown): v is Vec3 => Array.isArray(v) && v.length === 3 && v.every(x => finite(x) && Math.abs(x) <= COORD_LIMIT);
// eslint-disable-next-line no-control-regex
const clean = (v: unknown, max: number): v is string => typeof v === 'string' && v.length <= max && !/[\u0000-\u001f\u007f]/.test(v);
const isObject = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v);

/** Returns the advisory if `data` is a well-formed v1 advisory for `session` with a sequence above `lastSeq`; otherwise null. */
export function parseAdvisory(data: unknown, session: string, lastSeq: number, channel: string): Advisory | null {
  if (!isObject(data) || data.channel !== channel || data.v !== 1 || data.type !== 'advisory' || data.advisoryVersion !== ADVISORY_VERSION) return null;
  if (data.session !== session || !Number.isInteger(data.seq) || (data.seq as number) <= lastSeq) return null;
  if (!STATUSES.includes(String(data.status)) || !ACTIONS.includes(String(data.action)) || !Number.isInteger(data.episode)) return null;
  if (!(data.simTime === null || finite(data.simTime))) return null;
  if (!clean(data.title, 130) || !clean(data.detail, 250)) return null;
  if (!(data.target === null || vec3(data.target))) return null;
  if (!Array.isArray(data.waypoints) || data.waypoints.length > 8 || !data.waypoints.every(vec3)) return null;
  if (!Array.isArray(data.segments) || data.segments.length > 8) return null;
  const segments: Advisory['segments'][number][] = [];
  for (const s of data.segments) {
    if (!isObject(s) || !KINDS.includes(String(s.kind)) || typeof s.caution !== 'boolean' || typeof s.remembered !== 'boolean') return null;
    segments.push({ kind: s.kind as 'fold' | 'approach' | 'track', caution: s.caution, remembered: s.remembered });
  }
  if (!Array.isArray(data.limitations) || data.limitations.length > 2 || !data.limitations.every(l => clean(l, 170))) return null;
  if (!Array.isArray(data.goals) || data.goals.length > 12) return null;
  const goals: { id: string; label: string }[] = [];
  for (const g of data.goals) {
    if (!isObject(g) || !clean(g.id, 130) || !clean(g.label, 70)) return null;
    goals.push({ id: g.id as string, label: g.label as string });
  }
  let goal: Advisory['goal'] = null;
  if (data.goal !== null) {
    if (!isObject(data.goal) || !clean(data.goal.id, 130) || !clean(data.goal.label, 90)) return null;
    goal = { id: data.goal.id as string, label: data.goal.label as string };
  }
  return {
    seq: data.seq as number, status: data.status as Advisory['status'], episode: data.episode as number, simTime: data.simTime as number | null, goal,
    title: data.title as string, detail: data.detail as string, action: data.action as Advisory['action'], target: data.target as Vec3 | null,
    waypoints: data.waypoints as Vec3[], segments, limitations: data.limitations as string[], goals,
  };
}

export const isFresh = (receivedAtMs: number, nowMs: number): boolean => nowMs - receivedAtMs <= ADVISORY_STALE_MS;

export interface Bearing {
  readonly distance: number;
  /** Angle of the target on the screen plane, radians, 0 = right, +90 deg = up. */
  readonly screenAngle: number;
  readonly ahead: boolean;
  /** Plain-language direction relative to where the camera looks. */
  readonly words: string;
}

/** Direction to `target` as seen from a camera at `position` with orientation quaternion `q` (x, y, z, w; camera looks along -z). */
export function bearingTo(position: Vec3, q: readonly [number, number, number, number], target: Vec3): Bearing {
  const d: Vec3 = [target[0] - position[0], target[1] - position[1], target[2] - position[2]];
  const distance = Math.hypot(d[0], d[1], d[2]);
  // Rotate by the inverse (conjugate) quaternion into camera space.
  const [qx, qy, qz, qw] = [-q[0], -q[1], -q[2], q[3]];
  const tx = 2 * (qy * d[2] - qz * d[1]), ty = 2 * (qz * d[0] - qx * d[2]), tz = 2 * (qx * d[1] - qy * d[0]);
  const c: Vec3 = [d[0] + qw * tx + (qy * tz - qz * ty), d[1] + qw * ty + (qz * tx - qx * tz), d[2] + qw * tz + (qx * ty - qy * tx)];
  const forward = -c[2];
  const angle = Math.atan2(c[1], c[0]);
  const parts: string[] = [];
  const lateral = Math.hypot(c[0], c[1]) / (distance || 1);
  if (forward / (distance || 1) > 0.8) parts.push('straight ahead');
  else {
    if (forward < 0) parts.push('behind you');
    if (Math.abs(c[0]) > Math.abs(c[1]) * 0.6 && lateral > 0.25) parts.push(c[0] > 0 ? 'to the right' : 'to the left');
    if (Math.abs(c[1]) > Math.abs(c[0]) * 0.6 && lateral > 0.25) parts.push(c[1] > 0 ? 'above' : 'below');
  }
  return { distance, screenAngle: angle, ahead: forward > 0, words: parts.length ? parts.join(', ') : 'near' };
}
