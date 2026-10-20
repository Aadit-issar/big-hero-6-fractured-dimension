// FROZEN COPY of src/world/movers.ts as of commit 9318df5 (before the dynamics overhaul). Used only by tests/moversOverhaul.test.ts to prove the original four movers are bit-identical.
import { deformPosition } from '../../src/simulation/deformation';
import { evaluateField } from '../../src/simulation/field';
import type { SimulationEngine } from '../../src/simulation/simulationEngine';
import type { FieldParameters, DeformationSettings, Vec3 } from '../../src/simulation/types';

/** Dynamical extension of the Dimension: a few physical objects that move under an explicit, deterministic law.
 *
 * The spatial law X(q,t) = L (q + α ∇Φ(q,t)) is a MAP, not a force, so on its own it only distorts positions. The movers add the
 * missing dynamics in REFERENCE space and then push the result through the unchanged map:
 *
 *     q̈ = −k (q − g(t)) − c q̇ − μ ∇Φ(q,t) + a_d(q,t)         X = L (q + α ∇Φ(q,t))
 *
 *  - g(t) is a slow closed guide orbit (the object's intended drift lane),
 *  - k, c are a damped-spring pull towards that lane (it never leaves the neighbourhood of the lane),
 *  - −μ∇Φ is a conservative force from the SAME field Φ that defines the map (field-influenced motion),
 *  - a_d is one localised, time-modulated swirl: the "dimensional disturbance" (not gravity; a fictional additional law).
 *
 * Integration is symplectic Euler at integer 1/60 s ticks from a seeded initial state, so a state is a pure function of the seed and
 * the tick count: reset and replay are exact. Nothing here imports rendering, and nothing in src/simulation depends on it. */

export const MOVER_STEP = 1 / 60;
export type Quat = readonly [number, number, number, number];

export interface DisturbanceDef {
  readonly id: string;
  readonly label: string;
  /** Reference-space centre; its world position is the map of this point at time t. */
  readonly centre: Vec3;
  /** Gaussian width (reference units). */
  readonly sigma: number;
  readonly axis: Vec3;
  /** Peak swirl acceleration (reference units / s²). */
  readonly strength: number;
  /** Modulation: s(t) = 0.5 + 0.5 sin(ω t + φ). */
  readonly omega: number;
  readonly phase: number;
}

export interface MoverDef {
  readonly id: string;
  readonly label: string;
  /** Registry asset id of the physical model (the SAME id is used by every viewer of this object). */
  readonly assetId: string;
  readonly role: 'capsule' | 'equipment' | 'debris';
  readonly category: 'landmark' | 'baymax' | 'steel';
  readonly family: 'capsule' | 'baymax' | 'industrial';
  /** Bounding radius (m), used for approach and clearance. */
  readonly radius: number;
  /** Range (m) at which the object's transponder is acquired. Abigail's capsule carries a distress beacon; the rest rely on the standard sensor range. */
  readonly beaconRange?: number;
  readonly centre: Vec3;
  /** Orbit semi-axes (reference units) along the orthonormal frame (e1, e2, e3). */
  readonly semiAxes: Vec3;
  readonly frame: readonly [Vec3, Vec3, Vec3];
  readonly omega: number;
  readonly secondaryRatio: number;
  readonly phase: readonly [number, number];
  readonly stiffness: number;
  readonly damping: number;
  readonly fieldCoupling: number;
  readonly spin: { readonly axis: Vec3; readonly rate: number; readonly q0: Quat };
}

const frameFrom = (yaw: number, tilt: number): readonly [Vec3, Vec3, Vec3] => {
  const cy = Math.cos(yaw), sy = Math.sin(yaw), ct = Math.cos(tilt), st = Math.sin(tilt);
  const e1: Vec3 = [cy, 0, -sy];
  const e2: Vec3 = [sy * ct, st, cy * ct];
  const e3: Vec3 = [e1[1] * e2[2] - e1[2] * e2[1], e1[2] * e2[0] - e1[0] * e2[2], e1[0] * e2[1] - e1[1] * e2[0]];
  return [e1, e2, e3];
};

const SPRING = { stiffness: 2.6, damping: 3.0 };

/** The authored population. Parameters are fixed constants (not random), so the world is identical in every run. */
export const MOVER_DEFS: readonly MoverDef[] = [
  {
    id: 'capsule-abigail', label: "Abigail's Capsule", assetId: 'capsule_shell_remnant', role: 'capsule', category: 'landmark', family: 'capsule', radius: 2.4, beaconRange: 100,
    centre: [-0.1537, 2.0585, -3.5875], semiAxes: [3.3874, 2.2618, 0.7472], frame: [[0.089, 0, -0.996], [0.931, -0.355, 0.084], [-0.353, -0.935, -0.032]], omega: 0.0823, secondaryRatio: 1.7, phase: [3.6082, 1.3873], ...SPRING, fieldCoupling: 1.7343,
    spin: { axis: [0, 1, 0], rate: 0.22, q0: [0.12, 0.2, 0.05, 0.97] },
  },
  {
    id: 'armor-chest', label: 'Baymax chest armour', assetId: 'baymax_chest_armor', role: 'equipment', category: 'baymax', family: 'baymax', radius: 0.9,
    centre: [-0.8, 1.2, -1.2], semiAxes: [1.4, 0.9, 0.3], frame: frameFrom(-0.6, 0.15), omega: 0.09, secondaryRatio: 2.1, phase: [2.2, 1.1], ...SPRING, fieldCoupling: 1.2,
    spin: { axis: [0.3, 1, 0.1], rate: 0.35, q0: [0.3, 0.1, -0.2, 0.92] },
  },
  {
    id: 'armor-shoulder', label: 'Baymax shoulder armour', assetId: 'baymax_shoulder_shell', role: 'equipment', category: 'baymax', family: 'baymax', radius: 0.7,
    centre: [1.5, 0.9, -3.0], semiAxes: [1.2, 1.0, 0.3], frame: frameFrom(0.9, -0.2), omega: 0.07, secondaryRatio: 1.9, phase: [4.0, 2.2], ...SPRING, fieldCoupling: 1.0,
    spin: { axis: [1, 0.2, 0.4], rate: 0.28, q0: [-0.1, 0.4, 0.2, 0.88] },
  },
  {
    id: 'girder-drift', label: 'Drifting steel girder', assetId: 'industrial_ibeam_twisted', role: 'debris', category: 'steel', family: 'industrial', radius: 2.4,
    centre: [-0.2, 2.0, -3.4], semiAxes: [1.6, 1.0, 0.4], frame: frameFrom(-1.3, 0.4), omega: 0.06, secondaryRatio: 1.5, phase: [1.4, 3.3], ...SPRING, fieldCoupling: 0.8,
    spin: { axis: [0.1, 0.2, 1], rate: 0.16, q0: [0, 0.25, 0, 0.97] },
  },
];

/** An alternate, equally deterministic lane for Abigail's capsule: about twice as fast (mean 4 m/s, up to 6.5 m/s) and about twice as sharply
 * curved. It is the stress case for predictive interception (`?capsule=fast`, tested in tests/commandCore and scripts/atlas-intercept-report.ts):
 * a target this quick is not caught by simply flying at where it was last seen. The default lane is the one tuned for learnable motion. */
export type MoverVariant = 'cruise' | 'fast';
export const FAST_CAPSULE: MoverDef = {
  ...MOVER_DEFS[0]!,
  centre: [1.325, 2.1845, -1.8808], semiAxes: [4.2887, 2.8382, 0.4665], frame: [[0.123, 0, 0.992], [-0.974, 0.193, 0.121], [-0.192, -0.981, 0.024]], omega: 0.1474, phase: [6.1837, 5.7161], fieldCoupling: 0.6025,
};
export function moverDefsFor(variant: MoverVariant): readonly MoverDef[] { return variant === 'fast' ? [FAST_CAPSULE, ...MOVER_DEFS.slice(1)] : MOVER_DEFS; }
function variantFromUrl(): MoverVariant { try { return new URLSearchParams(window.location.search).get('capsule') === 'fast' ? 'fast' : 'cruise'; } catch { return 'cruise'; } }

/** One swirl in the reference volume the movers share. Its position drifts with the map, so it is visible as a moving region. */
export const DISTURBANCES: readonly DisturbanceDef[] = [
  { id: 'disturbance-1', label: 'Dimensional disturbance', centre: [1.8, 1.7, -2.4], sigma: 0.9, axis: [0, 1, 0.2], strength: 2.6, omega: 0.21, phase: 0.6 },
];

export const MOVER_IDS: readonly string[] = MOVER_DEFS.map(m => m.id);

interface Body { q: Vec3; v: Vec3 }

export interface MoverState {
  readonly id: string;
  /** Mapped world position (rendering units, metres) at the state's own time. */
  readonly position: Vec3;
  readonly quaternion: Quat;
  /** Reference-space speed × map scale is NOT the world speed; the world velocity is the finite difference of the map. */
  readonly referencePosition: Vec3;
}

const guide = (m: MoverDef, t: number): Vec3 => {
  const a = m.omega * t + m.phase[0], b = m.secondaryRatio * m.omega * t + m.phase[1];
  const x = m.semiAxes[0] * Math.cos(a), y = m.semiAxes[1] * Math.sin(a), z = m.semiAxes[2] * Math.sin(b);
  return [0, 1, 2].map(i => m.centre[i]! + x * m.frame[0][i]! + y * m.frame[1][i]! + z * m.frame[2][i]!) as unknown as Vec3;
};

const cross = (a: Vec3, b: Vec3): Vec3 => [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]];
const norm3 = (v: Vec3) => Math.hypot(v[0], v[1], v[2]);
const unit = (v: Vec3): Vec3 => { const n = norm3(v); return n > 1e-12 ? [v[0] / n, v[1] / n, v[2] / n] : [0, 1, 0]; };

/** Unit-quaternion product (x, y, z, w). */
export function quatMultiply(a: Quat, b: Quat): Quat {
  return [
    a[3] * b[0] + a[0] * b[3] + a[1] * b[2] - a[2] * b[1],
    a[3] * b[1] - a[0] * b[2] + a[1] * b[3] + a[2] * b[0],
    a[3] * b[2] + a[0] * b[1] - a[1] * b[0] + a[2] * b[3],
    a[3] * b[3] - a[0] * b[0] - a[1] * b[1] - a[2] * b[2],
  ];
}
const normalizeQuat = (q: Quat): Quat => { const n = Math.hypot(q[0], q[1], q[2], q[3]); return [q[0] / n, q[1] / n, q[2] / n, q[3] / n]; };

/** Analytic orientation: a fixed initial attitude followed by a constant-rate spin about a body axis. */
export function moverQuaternion(m: MoverDef, t: number): Quat {
  const axis = unit(m.spin.axis), half = 0.5 * m.spin.rate * t, s = Math.sin(half);
  return normalizeQuat(quatMultiply(normalizeQuat(m.spin.q0), [axis[0] * s, axis[1] * s, axis[2] * s, Math.cos(half)]));
}

export interface DisturbanceState { readonly id: string; readonly label: string; readonly position: Vec3; readonly radius: number; readonly intensity: number }

/** Deterministic fixed-step mover integrator. Use `syncTo(time)` with the engine clock time; rewinding replays from tick 0. */
export class MoverSystem {
  private bodies: Body[];
  tick = 0;

  constructor(readonly field: FieldParameters, readonly mapping: DeformationSettings, readonly defs: readonly MoverDef[] = MOVER_DEFS, readonly disturbances: readonly DisturbanceDef[] = DISTURBANCES) {
    this.bodies = this.initial();
  }

  private initial(): Body[] {
    // Start exactly on the lane with the lane's own velocity, so there is no start-up transient.
    return this.defs.map(m => {
      const g0 = guide(m, 0), g1 = guide(m, MOVER_STEP);
      return { q: g0, v: [(g1[0] - g0[0]) / MOVER_STEP, (g1[1] - g0[1]) / MOVER_STEP, (g1[2] - g0[2]) / MOVER_STEP] as Vec3 };
    });
  }

  reset(): void { this.tick = 0; this.bodies = this.initial(); }

  private acceleration(m: MoverDef, b: Body, t: number): Vec3 {
    const g = guide(m, t);
    const grad = evaluateField(b.q, t, this.field).gradient;
    const a: [number, number, number] = [0, 0, 0];
    for (let i = 0; i < 3; i += 1) a[i] = -m.stiffness * (b.q[i]! - g[i]!) - m.damping * b.v[i]! - m.fieldCoupling * grad[i]!;
    for (const d of this.disturbances) {
      const r: Vec3 = [b.q[0] - d.centre[0], b.q[1] - d.centre[1], b.q[2] - d.centre[2]];
      const w = Math.exp(-(r[0] * r[0] + r[1] * r[1] + r[2] * r[2]) / (2 * d.sigma * d.sigma));
      if (w < 1e-4) continue;
      const mod = 0.5 + 0.5 * Math.sin(d.omega * t + d.phase);
      const swirl = cross(unit(d.axis), r);
      for (let i = 0; i < 3; i += 1) a[i]! += d.strength * mod * w * swirl[i]! / d.sigma;
    }
    return a;
  }

  private step(): void {
    const t = this.tick * MOVER_STEP;
    this.defs.forEach((m, i) => {
      const b = this.bodies[i]!;
      const a = this.acceleration(m, b, t);
      const v: Vec3 = [b.v[0] + a[0] * MOVER_STEP, b.v[1] + a[1] * MOVER_STEP, b.v[2] + a[2] * MOVER_STEP];
      const q: Vec3 = [b.q[0] + v[0] * MOVER_STEP, b.q[1] + v[1] * MOVER_STEP, b.q[2] + v[2] * MOVER_STEP];
      if (!q.every(Number.isFinite) || norm3(v) > 50) throw new RangeError(`Mover ${m.id} integration failed.`);
      this.bodies[i] = { q, v };
    });
    this.tick += 1;
  }

  /** Advance to the tick containing `time` (a pure function of the tick count). Earlier times replay from the start. */
  syncTo(time: number): void {
    if (!Number.isFinite(time) || time < 0) throw new RangeError('Invalid mover time.');
    const target = Math.floor((time + 1e-9) / MOVER_STEP);
    if (target < this.tick) this.reset();
    while (this.tick < target) this.step();
  }

  /** Model time of the integrated state (an integer tick). */
  get time(): number { return this.tick * MOVER_STEP; }

  /** Mapped states at the integrated tick; the field is evaluated at that same instant. */
  states(): MoverState[] {
    const t = this.time;
    return this.defs.map((m, i) => ({ id: m.id, position: deformPosition(this.bodies[i]!.q, t, this.field, this.mapping), quaternion: moverQuaternion(m, t), referencePosition: this.bodies[i]!.q }));
  }

  /** Mapped position of the disturbance regions at the integrated tick. Intensity is its current modulation 0..1. */
  disturbanceStates(): DisturbanceState[] {
    const t = this.time;
    return this.disturbances.map(d => ({ id: d.id, label: d.label, position: deformPosition(d.centre, t, this.field, this.mapping), radius: d.sigma * this.mapping.worldScale * 1.6, intensity: 0.5 + 0.5 * Math.sin(d.omega * t + d.phase) }));
  }
}

const systems = new WeakMap<SimulationEngine, MoverSystem>();
/** The mover system attached to an engine, advanced to the engine clock. The engine itself is untouched. */
export function moversFor(engine: SimulationEngine): MoverSystem {
  let system = systems.get(engine);
  if (!system) { system = new MoverSystem(engine.field, engine.mapping, moverDefsFor(variantFromUrl())); systems.set(engine, system); }
  system.syncTo(engine.clock.time);
  return system;
}

export function moverDef(id: string): MoverDef | undefined { return MOVER_DEFS.find(m => m.id === id); }
