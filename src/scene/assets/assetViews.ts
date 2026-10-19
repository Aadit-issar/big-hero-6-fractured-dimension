import { Vector3 } from 'three';
import type { SimulationEngine } from '../../simulation/simulationEngine';
import type { Vec3 } from '../../simulation/types';
import { VORTEX } from '../dimension/layout';
import { cachedLayout } from './DimensionAssets';

/** Rendering-only framings of the physical objects (Shift+1–9). Like the
 * cinematic views they are ordinary free-flight jumps derived from the
 * deterministic layout; nothing is written to the simulation. */
export type AssetViewName = 'swarm-closeup' | 'formation-medium' | 'debris-cluster' | 'beams' | 'landmark' | 'fold-shear' | 'strain-shear' | 'vortex-inflow' | 'material-closeup';
export const ASSET_VIEWS: readonly AssetViewName[] = ['swarm-closeup', 'formation-medium', 'debris-cluster', 'beams', 'landmark', 'fold-shear', 'strain-shear', 'vortex-inflow', 'material-closeup'];

const v = (a: Vec3) => new Vector3(a[0], a[1], a[2]);
const arr = (a: Vector3): Vec3 => [a.x, a.y, a.z];
/** Camera `distance` from `target`, approaching from `from` (and lifted a little). */
function look(target: Vector3, from: Vector3, distance: number, lift = 0.15): { position: Vec3; target: Vec3 } {
  const dir = from.clone().sub(target).normalize();
  dir.y += lift;
  return { position: arr(target.clone().addScaledVector(dir.normalize(), distance)), target: arr(target) };
}
function centroid(points: readonly Vec3[]): Vector3 {
  return points.reduce((s, p) => s.add(v(p)), new Vector3()).divideScalar(Math.max(1, points.length));
}

export function assetViewPose(name: AssetViewName, engine: SimulationEngine): { position: Vec3; target: Vec3 } {
  const layout = cachedLayout(engine);
  const t = engine.clock.time;
  const opening = v(engine.explorer.pose(t).position);
  const formation = (id: string) => layout.formations.find((f) => f.id === id);
  const cluster = (id: string) => layout.debris.filter((d) => d.cluster === id);
  switch (name) {
    case 'swarm-closeup': {
      const f = formation('opening-swarm');
      return f ? look(v(f.centre), opening, f.radius + 0.35, 0.05) : { position: arr(opening), target: arr(opening.clone().add(new Vector3(0, 0, -1))) };
    }
    case 'formation-medium': {
      const f = formation('island-swarm-a') ?? formation('opening-swarm')!;
      return look(v(f.centre), opening, f.radius * 3.2 + 2);
    }
    case 'debris-cluster': {
      const c = centroid(cluster('breach-slabs').map((d) => d.position));
      return look(c, opening, 20, 0.25);
    }
    case 'beams': {
      const pieces = cluster('industrial-structure');
      return look(centroid(pieces.map((d) => d.position)), opening, 18, 0.1);
    }
    case 'landmark': {
      const shell = layout.debris.find((d) => d.cluster === 'landmark');
      const c = shell ? v(shell.position) : opening;
      // Framed from the trail side so the shell and its shed parts read together.
      return look(c, opening, 5 + (shell?.radius ?? 1.5) * 2.2, 0.2);
    }
    case 'fold-shear': {
      // Oblique (≈45°) to the primary connection's entry plane: seam and echo both read.
      const id = engine.explorer.primaryFoldId;
      const fold = id ? engine.network.getConnectionState(id, t) : null;
      if (!fold) return { position: arr(opening), target: arr(opening.clone().add(new Vector3(0, 0, -1))) };
      const entry = v(fold.entryWorldPosition), n = v(fold.entryNormal).normalize();
      const side = new Vector3().crossVectors(n, new Vector3(0, 1, 0)).normalize();
      return { position: arr(entry.clone().addScaledVector(side, 30).addScaledVector(n, 28).add(new Vector3(0, 6, 0))), target: arr(entry) };
    }
    case 'strain-shear': {
      const hazard = layout.debris.filter((d) => d.cluster === 'hazard-0');
      return look(centroid(hazard.map((d) => d.position)), opening, 24, 0.2);
    }
    case 'vortex-inflow': {
      const f = formation('vortex-swarm');
      const c = f ? v(f.centre) : v(VORTEX);
      const toward = v(VORTEX).sub(c).normalize();
      return { position: arr(c.clone().addScaledVector(toward, -26).add(new Vector3(0, 4, 0))), target: arr(c.clone().addScaledVector(toward, 30)) };
    }
    case 'material-closeup': {
      const slab = layout.debris.find((d) => d.asset === 'concrete_slab_rebar') ?? layout.debris[0]!;
      return look(v(slab.position), opening, 3.2, 0.3);
    }
  }
}
