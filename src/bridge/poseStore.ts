import type { QuatTuple, Vec3Tuple } from '../shared/liveLink';

/** Baymax's own pose and the camera that renders it, published once per frame by the exploration camera.
 * It is the single source for the bridge's pose reports and for the navigation HUD, so both see exactly what the player sees. */
export interface CameraPose {
  readonly position: Vec3Tuple;
  readonly quaternion: QuatTuple;
  /** Vertical field of view in degrees and the viewport aspect (width / height). */
  readonly fovY: number;
  readonly aspect: number;
  /** Measured vehicle velocity (smoothed finite difference of the flown position). */
  readonly velocity: Vec3Tuple;
  /** Simulation time of this pose. */
  readonly simTime: number;
  /** Where the rendered camera is: equal to `position` in first person, behind and above it in Baymax view. The HUD projects from here. */
  readonly viewPosition: Vec3Tuple;
  /** Boost key held (drives the thruster boost state). */
  readonly boost: boolean;
}

let pose: CameraPose | null = null;
let last: { position: Vec3Tuple; wall: number } | null = null;
let velocity: Vec3Tuple = [0, 0, 0];

export const getCameraPose = (): CameraPose | null => pose;

export function publishCameraPose(position: Vec3Tuple, quaternion: QuatTuple, fovY: number, aspect: number, simTime: number, wallSeconds: number, viewPosition: Vec3Tuple = position, boost = false): void {
  if (last && wallSeconds > last.wall) {
    const dt = Math.min(0.5, wallSeconds - last.wall);
    const raw = [(position[0] - last.position[0]) / dt, (position[1] - last.position[1]) / dt, (position[2] - last.position[2]) / dt];
    // A teleport (fold traversal, reset) is not a velocity.
    const jump = Math.hypot(position[0] - last.position[0], position[1] - last.position[1], position[2] - last.position[2]) > 25;
    velocity = jump ? [0, 0, 0] : [velocity[0] + (raw[0]! - velocity[0]) * 0.35, velocity[1] + (raw[1]! - velocity[1]) * 0.35, velocity[2] + (raw[2]! - velocity[2]) * 0.35];
  }
  last = { position, wall: wallSeconds };
  pose = { position, quaternion, fovY, aspect, velocity, simTime, viewPosition, boost };
}

export function clearCameraPose(): void { pose = null; last = null; velocity = [0, 0, 0]; }
