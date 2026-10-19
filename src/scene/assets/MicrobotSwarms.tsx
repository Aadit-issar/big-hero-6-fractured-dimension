import { useEffect, useMemo, useRef } from 'react';
import { useFrame } from '@react-three/fiber';
import { InstancedBufferAttribute, InstancedMesh, Matrix4, Quaternion, Sphere, Vector3, Vector4 } from 'three';
import type { BufferGeometry, MeshStandardMaterial } from 'three';
import type { SimulationEngine } from '../../simulation/simulationEngine';
import type { AtmosphereUniforms } from '../terrain/rockMaterial';
import type { AssetQuality } from '../../rendering/qualitySettings';
import { createAssetMaterial, createFormationUniforms } from './assetMaterial';
import type { LoadedAsset } from './assetLoader';
import { shareGeometry } from './DebrisField';
import { assetStats } from './assetStats';
import type { FormationKind, MicrobotFormation } from './placement';

/** Microbot LOD chain, nearest first, with the base switch distances (metres). */
export const MICROBOT_LOD_IDS = ['microbot', 'microbot_lod1', 'microbot_lod2'] as const;
export const MICROBOT_LOD_DISTANCES = [3.5, 28, 150] as const;

/** Coherent motion per formation kind: [differential rotation, wobble (× radius), ripple (m)]. */
const MOTION: Record<FormationKind, readonly [number, number, number]> = {
  swarm: [1, 0.03, 0], chain: [0, 0, 0.06], cluster: [0, 0.004, 0], inactive: [0, 0, 0],
};

/** Mirrors the formation vertex motion (without wobble) for LOD distances. */
function unitPosition(f: MicrobotFormation, rest: Vector3, time: number, out: Vector3, axis: Vector3, centre: Vector3): Vector3 {
  out.copy(rest).sub(centre);
  const along = out.dot(axis), radial = Math.sqrt(Math.max(0, out.lengthSq() - along * along));
  const rate = MOTION[f.kind][0] ? 1 / (0.45 + radial / Math.max(f.radius, 1e-3)) : 1;
  return out.applyAxisAngle(axis, f.omega * rate * time).add(centre);
}

interface FormationMeshes {
  readonly formation: MicrobotFormation;
  readonly rest: Float32Array; // 16 floats per unit
  readonly positions: Vector3[];
  readonly phases: Float32Array;
  readonly levels: ReadonlyArray<{ readonly matrices: InstancedBufferAttribute; readonly phase: InstancedBufferAttribute; readonly meshes: InstancedMesh[]; readonly triangles: number }>;
}

/** Instanced microbots at their true 38.8 mm size. Large shapes come only from
 * numbers and arrangement. Each formation turns coherently about its axis on the
 * GPU (model time); units are re-partitioned between three LODs as the camera
 * moves. Rendering only. */
export function MicrobotSwarms({ engine, formations, assets, atmosphere, quality }: {
  readonly engine: SimulationEngine;
  readonly formations: readonly MicrobotFormation[];
  readonly assets: Readonly<Record<string, LoadedAsset>>;
  readonly atmosphere: AtmosphereUniforms;
  readonly quality: AssetQuality;
}) {
  const built = useMemo(() => {
    const lods = MICROBOT_LOD_IDS.map((id) => assets[id]);
    const materials: MeshStandardMaterial[] = [], geometries: BufferGeometry[] = [];
    const out: FormationMeshes[] = [];
    if (lods.some((l) => !l)) return { out, materials, geometries };
    const m = new Matrix4(), q = new Quaternion(), s = new Vector3(1, 1, 1);
    for (const f of formations) {
      // Quality renders a prefix of a formation (uniform subset); chains stay whole.
      const count = f.kind === 'chain' ? f.units.length : Math.max(1, Math.round(f.units.length * quality.microbotDensity));
      const units = f.units.slice(0, count);
      const rest = new Float32Array(count * 16), phases = new Float32Array(count);
      const positions = units.map((u, i) => {
        m.compose(new Vector3(...u.position), q.set(...u.quaternion), s).toArray(rest, i * 16);
        phases[i] = u.phase;
        return new Vector3(...u.position);
      });
      const uniforms = createFormationUniforms();
      const [differential, wobble, ripple] = MOTION[f.kind];
      uniforms.uCentre.value.set(...f.centre);
      uniforms.uAxis.value.set(...f.axis).normalize();
      uniforms.uFormation.value.set(f.omega, f.radius, wobble * f.radius, ripple);
      uniforms.uFormationMode.value = new Vector4(differential, 0, 0, 0);
      const bounds = new Sphere(new Vector3(...f.centre), f.kind === 'chain' ? f.radius + 1 : f.radius * 1.35 + 0.3);
      const levels = lods.map((lod) => {
        const matrices = new InstancedBufferAttribute(new Float32Array(count * 16), 16);
        const phase = new InstancedBufferAttribute(new Float32Array(count), 1);
        const meshes = lod!.parts.map((part) => {
          const geometry = shareGeometry(part.geometry);
          geometry.setAttribute('aPhase', phase);
          const material = createAssetMaterial(part.material, atmosphere, 'formation', uniforms);
          const mesh = new InstancedMesh(geometry, material, count);
          mesh.instanceMatrix = matrices;
          mesh.count = 0;
          mesh.boundingSphere = bounds;
          mesh.name = `microbots-${f.id}`;
          materials.push(material); geometries.push(geometry);
          return mesh;
        });
        return { matrices, phase, meshes, triangles: lod!.triangles };
      });
      out.push({ formation: f, rest, positions, phases, levels });
    }
    return { out, materials, geometries };
  }, [formations, assets, atmosphere, quality.microbotDensity]);
  useEffect(() => () => {
    built.out.forEach((f) => f.levels.forEach((l) => l.meshes.forEach((mesh) => mesh.dispose())));
    built.materials.forEach((material) => material.dispose());
    built.geometries.forEach((geometry) => geometry.dispose());
  }, [built]);

  const last = useRef({ x: Infinity, y: 0, z: 0, t: -1 });
  const scratch = useMemo(() => ({ p: new Vector3(), axis: new Vector3(), centre: new Vector3() }), []);
  useFrame(({ camera }) => {
    const time = engine.clock.time;
    for (const material of built.materials) (material.userData.uTime as { value: number }).value = time;
    // Re-partition when the camera has moved or a model-time quarter-second passed.
    const c = camera.position, l = last.current;
    if (Math.hypot(c.x - l.x, c.y - l.y, c.z - l.z) < 0.25 && Math.abs(time - l.t) < 0.25) return;
    last.current = { x: c.x, y: c.y, z: c.z, t: time };
    const d0 = MICROBOT_LOD_DISTANCES[0] * quality.lodScale, d1 = MICROBOT_LOD_DISTANCES[1] * quality.lodScale, d2 = MICROBOT_LOD_DISTANCES[2] * quality.lodScale;
    const visible = [0, 0, 0];
    let triangles = 0;
    for (const f of built.out) {
      scratch.axis.set(...f.formation.axis).normalize();
      scratch.centre.set(...f.formation.centre);
      const counts = [0, 0, 0];
      // Whole formations beyond the last LOD are skipped without per-unit work.
      const far = c.distanceTo(scratch.centre) - f.formation.radius * 1.5 > d2;
      if (!far) f.positions.forEach((rest, i) => {
        const d = unitPosition(f.formation, rest, time, scratch.p, scratch.axis, scratch.centre).distanceTo(c);
        const level = d < d0 ? 0 : d < d1 ? 1 : d < d2 ? 2 : -1;
        if (level < 0) return;
        const target = f.levels[level]!, k = counts[level]!;
        (target.matrices.array as Float32Array).set(f.rest.subarray(i * 16, i * 16 + 16), k * 16);
        (target.phase.array as Float32Array)[k] = f.phases[i]!;
        counts[level] = k + 1;
      });
      f.levels.forEach((level, k) => {
        // Upload only the populated prefix.
        level.matrices.clearUpdateRanges(); level.matrices.addUpdateRange(0, counts[k]! * 16); level.matrices.needsUpdate = true;
        level.phase.clearUpdateRanges(); level.phase.addUpdateRange(0, counts[k]!); level.phase.needsUpdate = true;
        for (const mesh of level.meshes) mesh.count = counts[k]!;
        visible[k]! += counts[k]!;
        triangles += counts[k]! * level.triangles;
      });
    }
    assetStats.microbotsVisible = visible;
    assetStats.microbotTriangles = triangles;
  });
  return <group name="microbot-formations">{built.out.flatMap((f) => f.levels.flatMap((l) => l.meshes)).map((mesh) => <primitive key={mesh.uuid} object={mesh} />)}</group>;
}
