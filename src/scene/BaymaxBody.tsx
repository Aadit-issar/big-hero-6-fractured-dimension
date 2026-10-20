import { useRef, useSyncExternalStore } from 'react';
import { useFrame } from '@react-three/fiber';
import { BaymaxHero } from '../baymax';
import type { BaymaxHeroState } from '../baymax';
import { getCameraPose } from '../bridge/poseStore';
import { getBaymaxHidden, getViewMode, subscribeBaymaxHidden, subscribeViewMode } from './viewMode';
import type { SimulationEngine } from '../simulation/simulationEngine';

/** Baymax himself, drawn at the flight position in Baymax view (V). Pose and thrust come only from the published flight state: position,
 * heading, measured velocity (acceleration and turn rate are differences of it) and the boost key. It is never a second source of motion. */
export function BaymaxBody({ engine }: { readonly engine: SimulationEngine }) {
  const mode = useSyncExternalStore(subscribeViewMode, getViewMode);
  const hidden = useSyncExternalStore(subscribeBaymaxHidden, getBaymaxHidden);
  if (mode !== 'baymax' || hidden) return null;
  return <Body engine={engine} />;
}

function Body({ engine }: { readonly engine: SimulationEngine }) {
  const state = useRef<BaymaxHeroState>({ position: [0, 0, 0], quaternion: [0, 0, 0, 1], velocity: [0, 0, 0], acceleration: [0, 0, 0], yawRate: 0, boost: false });
  const prev = useRef({ v: [0, 0, 0], yaw: 0, t: -1 });
  useFrame((_, delta) => {
    const pose = getCameraPose();
    if (!pose) return;
    const dt = Math.max(1e-3, Math.min(delta, 0.1));
    const f = [-2 * (pose.quaternion[0] * pose.quaternion[2] + pose.quaternion[3] * pose.quaternion[1]), 0, -(1 - 2 * (pose.quaternion[0] ** 2 + pose.quaternion[1] ** 2))];
    const yaw = Math.atan2(-f[0]!, -f[2]!);
    const p = prev.current;
    let dyaw = yaw - p.yaw; while (dyaw > Math.PI) dyaw -= 2 * Math.PI; while (dyaw < -Math.PI) dyaw += 2 * Math.PI;
    const s = state.current as { position: [number, number, number]; quaternion: [number, number, number, number]; velocity: [number, number, number]; acceleration: [number, number, number]; yawRate: number; boost: boolean };
    s.position = [pose.position[0], pose.position[1], pose.position[2]];
    s.quaternion = [0, Math.sin(yaw / 2), 0, Math.cos(yaw / 2)];
    s.velocity = [pose.velocity[0], pose.velocity[1], pose.velocity[2]];
    s.acceleration = p.t < 0 ? [0, 0, 0] : [(pose.velocity[0] - p.v[0]!) / dt, (pose.velocity[1] - p.v[1]!) / dt, (pose.velocity[2] - p.v[2]!) / dt];
    s.yawRate = p.t < 0 ? 0 : dyaw / dt;
    s.boost = pose.boost;
    prev.current = { v: [...pose.velocity], yaw, t: engine.clock.time };
  });
  return <BaymaxHero state={state} lod="high" showFx timeSource={() => engine.clock.time} />;
}
