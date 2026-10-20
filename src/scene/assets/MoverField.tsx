import { useEffect, useMemo } from 'react';
import { useFrame } from '@react-three/fiber';
import { BufferGeometry, InstancedBufferAttribute, InstancedMesh, Matrix4, Quaternion, Vector3 } from 'three';
import type { MeshStandardMaterial } from 'three';
import type { SimulationEngine } from '../../simulation/simulationEngine';
import type { AtmosphereUniforms } from '../terrain/rockMaterial';
import { MOVER_DEFS, moversFor } from '../../world/movers';
import { createAssetMaterial } from './assetMaterial';
import type { SurfaceMaps } from './assetMaterial';
import type { LoadedAsset } from './assetLoader';
import { shareGeometry } from './DebrisField';

/** The Dimension's moving physical objects (src/world/movers.ts): Abigail's capsule, Baymax armour and a drifting girder.
 * Each is the SAME registry GLB, with the same material and haze, as the scattered wreckage and as the model ATLAS draws.
 * Position and attitude come from the deterministic mover system at the engine clock; nothing here moves anything by itself. */
const LEVEL_SWITCH = [7, 20] as const;

interface Rig { readonly id: string; readonly size: number; readonly levels: InstancedMesh[][] }

export function MoverField({ engine, assets, atmosphere, maps, lodScale }: {
  readonly engine: SimulationEngine; readonly assets: Readonly<Record<string, LoadedAsset>>; readonly atmosphere: AtmosphereUniforms; readonly maps: SurfaceMaps; readonly lodScale: number;
}) {
  const built = useMemo(() => {
    const materials = new Map<MeshStandardMaterial, MeshStandardMaterial>(), geometries: BufferGeometry[] = [], meshes: InstancedMesh[] = [];
    const rigs: Rig[] = [];
    for (const def of MOVER_DEFS) {
      const asset = assets[def.assetId];
      if (!asset) continue;
      const levels = asset.levels.map((level) => level.parts.map((part) => {
        const geometry = shareGeometry(part.geometry);
        // Rigid, motionless drift attributes: the pose comes from the instance matrix alone.
        geometry.setAttribute('aBob', new InstancedBufferAttribute(new Float32Array([0, 0, 0, 1]), 4));
        geometry.setAttribute('aSpin', new InstancedBufferAttribute(new Float32Array([0, 1, 0, 0]), 4));
        geometry.setAttribute('aPhase', new InstancedBufferAttribute(new Float32Array([0]), 1));
        geometry.setAttribute('aFade', new InstancedBufferAttribute(new Float32Array([1]), 1));
        let material = materials.get(part.material);
        if (!material) { material = createAssetMaterial(part.material, atmosphere, 'drift', undefined, maps, true); materials.set(part.material, material); }
        const mesh = new InstancedMesh(geometry, material, 1);
        mesh.frustumCulled = false;
        mesh.visible = false;
        mesh.name = `mover-${def.id}`;
        mesh.receiveShadow = true;
        geometries.push(geometry); meshes.push(mesh);
        return mesh;
      }));
      rigs.push({ id: def.id, size: Math.max(...asset.size), levels });
    }
    return { rigs, materials: [...materials.values()], geometries, meshes };
  }, [assets, atmosphere, maps]);
  useEffect(() => () => {
    built.meshes.forEach((m) => m.dispose());
    built.materials.forEach((m) => m.dispose());
    built.geometries.forEach((g) => g.dispose());
  }, [built]);

  const scratch = useMemo(() => ({ m: new Matrix4(), q: new Quaternion(), p: new Vector3(), s: new Vector3(1, 1, 1) }), []);
  useFrame(({ camera }) => {
    for (const material of built.materials) (material.userData.uTime as { value: number }).value = engine.clock.time;
    const states = moversFor(engine).states();
    for (const rig of built.rigs) {
      const state = states.find((s) => s.id === rig.id);
      if (!state) continue;
      scratch.m.compose(scratch.p.set(...state.position), scratch.q.set(...state.quaternion), scratch.s);
      const dist = camera.position.distanceTo(scratch.p);
      let level = 0;
      for (let k = 0; k < rig.levels.length - 1; k += 1) if (dist > rig.size * LEVEL_SWITCH[Math.min(k, LEVEL_SWITCH.length - 1)]! * lodScale) level = k + 1;
      rig.levels.forEach((parts, k) => parts.forEach((mesh) => {
        mesh.visible = k === level;
        if (k === level) { mesh.setMatrixAt(0, scratch.m); mesh.instanceMatrix.needsUpdate = true; }
      }));
    }
  });
  return <group name="movers">{built.meshes.map((mesh) => <primitive key={mesh.uuid} object={mesh} />)}</group>;
}
