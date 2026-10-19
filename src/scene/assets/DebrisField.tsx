import { useEffect, useMemo } from 'react';
import { useFrame } from '@react-three/fiber';
import { BufferGeometry, Frustum, InstancedBufferAttribute, InstancedMesh, Matrix4, Quaternion, Sphere, Vector3 } from 'three';
import type { MeshStandardMaterial } from 'three';
import type { SimulationEngine } from '../../simulation/simulationEngine';
import type { AtmosphereUniforms } from '../terrain/rockMaterial';
import { createAssetMaterial } from './assetMaterial';
import type { SurfaceMaps } from './assetMaterial';
import type { LoadedAsset } from './assetLoader';
import { assetStats } from './assetStats';
import type { DebrisInstance } from './placement';

/** A geometry that shares the source's vertex buffers (no copy) so per-mesh
 * instance attributes can be attached without duplicating vertex data. */
export function shareGeometry(source: BufferGeometry): BufferGeometry {
  const g = new BufferGeometry();
  g.setIndex(source.index);
  for (const [name, attribute] of Object.entries(source.attributes)) g.setAttribute(name, attribute);
  for (const group of source.groups) g.addGroup(group.start, group.count, group.materialIndex);
  g.boundingBox = source.boundingBox;
  g.boundingSphere = source.boundingSphere;
  return g;
}

/** Detail switching by apparent size (rendering only). Distances are multiples of
 * the piece's largest dimension (metres), scaled by the preset's lodScale:
 * level k → k+1 at size × LEVEL_SWITCH[k]; fade-out at size × CULL (clamped). The
 * switch band is dithered (both levels drawn with complementary screen-door
 * masks) so nothing pops; the far fade sinks into the gas haze. */
export const DEBRIS_LOD = { levelSwitch: [7, 20] as const, band: 0.12, cull: 105, minCull: 60, maxCull: 420, farFade: 0.15 } as const;

interface LevelBuffers {
  readonly matrices: InstancedBufferAttribute; readonly bob: InstancedBufferAttribute; readonly spin: InstancedBufferAttribute;
  readonly phase: InstancedBufferAttribute; readonly fade: InstancedBufferAttribute;
  readonly meshes: InstancedMesh[]; readonly triangles: number;
}
interface Group {
  readonly id: string;
  readonly instances: readonly DebrisInstance[];
  readonly rest: Float32Array; // 16 floats per instance
  readonly centres: Vector3[];
  readonly reach: Float32Array; // bounding radius incl. drift
  readonly size: Float32Array; // largest dimension × scale (m)
  readonly levels: LevelBuffers[];
}

/** Physical wreckage: per (asset, level, material) one instanced draw. Placement is
 * the deterministic layout; slow drift and spin are evaluated on the GPU from model
 * time. Each frame the camera re-partitions instances between detail levels with
 * per-instance frustum and distance culling (only populated prefixes are uploaded
 * and drawn). Rendering only; never casts into the simulation. */
export function DebrisField({ engine, debris, assets, atmosphere, maps, lodScale }: {
  readonly engine: SimulationEngine;
  readonly debris: readonly DebrisInstance[];
  readonly assets: Readonly<Record<string, LoadedAsset>>;
  readonly atmosphere: AtmosphereUniforms;
  readonly maps: SurfaceMaps;
  readonly lodScale: number;
}) {
  const built = useMemo(() => {
    const byAsset = new Map<string, DebrisInstance[]>();
    for (const d of debris) if (assets[d.asset]) byAsset.set(d.asset, [...(byAsset.get(d.asset) ?? []), d]);
    const groups: Group[] = [], materials = new Map<MeshStandardMaterial, MeshStandardMaterial>(), geometries: BufferGeometry[] = [];
    const m = new Matrix4(), q = new Quaternion(), p = new Vector3(), s = new Vector3();
    for (const [id, list] of [...byAsset.entries()].sort(([a], [b]) => a.localeCompare(b))) {
      const asset = assets[id]!, n = list.length, largest = Math.max(...asset.size);
      const rest = new Float32Array(n * 16), reach = new Float32Array(n), size = new Float32Array(n);
      const centres = list.map((d, i) => {
        m.compose(p.set(...d.position), q.set(...d.quaternion), s.setScalar(d.scale)).toArray(rest, i * 16);
        reach[i] = d.radius + Math.hypot(...d.drift.amplitude) + 0.2;
        size[i] = largest * d.scale;
        return new Vector3(...d.position);
      });
      const levels = asset.levels.map((level) => {
        const buffers = {
          matrices: new InstancedBufferAttribute(new Float32Array(n * 16), 16), bob: new InstancedBufferAttribute(new Float32Array(n * 4), 4),
          spin: new InstancedBufferAttribute(new Float32Array(n * 4), 4), phase: new InstancedBufferAttribute(new Float32Array(n), 1), fade: new InstancedBufferAttribute(new Float32Array(n), 1),
        };
        for (const b of Object.values(buffers)) b.setUsage(35048); // DynamicDrawUsage
        const meshes = level.parts.map((part) => {
          const geometry = shareGeometry(part.geometry);
          geometry.setAttribute('aBob', buffers.bob); geometry.setAttribute('aSpin', buffers.spin); geometry.setAttribute('aPhase', buffers.phase); geometry.setAttribute('aFade', buffers.fade);
          let material = materials.get(part.material);
          if (!material) { material = createAssetMaterial(part.material, atmosphere, 'drift', undefined, maps, true); materials.set(part.material, material); }
          const mesh = new InstancedMesh(geometry, material, n);
          mesh.instanceMatrix = buffers.matrices;
          mesh.count = 0; mesh.visible = false;
          // Culled per instance below; the mesh-level test would be meaningless (instances span the world).
          mesh.frustumCulled = false;
          mesh.name = `debris-${id}`;
          mesh.receiveShadow = true;
          geometries.push(geometry);
          return mesh;
        });
        return { ...buffers, meshes, triangles: level.triangles };
      });
      groups.push({ id, instances: list, rest, centres, reach, size, levels });
    }
    return { groups, materials: [...materials.values()], geometries };
  }, [debris, assets, atmosphere, maps]);
  useEffect(() => () => {
    built.groups.forEach((g) => g.levels.forEach((l) => l.meshes.forEach((mesh) => mesh.dispose())));
    built.materials.forEach((material) => material.dispose());
    built.geometries.forEach((geometry) => geometry.dispose());
  }, [built]);

  const scratch = useMemo(() => ({ frustum: new Frustum(), matrix: new Matrix4(), sphere: new Sphere(), last: new Matrix4(), lastScale: -1, dirty: true }), []);
  useEffect(() => { scratch.dirty = true; }, [built, scratch]);
  useFrame(({ camera }) => {
    for (const material of built.materials) (material.userData.uTime as { value: number }).value = engine.clock.time;
    // Re-partition only when the view changed (camera matrices are static while paused).
    scratch.matrix.multiplyMatrices(camera.projectionMatrix, camera.matrixWorldInverse);
    if (!scratch.dirty && scratch.matrix.equals(scratch.last) && scratch.lastScale === lodScale) return;
    scratch.dirty = false; scratch.last.copy(scratch.matrix); scratch.lastScale = lodScale;
    scratch.frustum.setFromProjectionMatrix(scratch.matrix);
    const c = camera.position, visible = [0, 0, 0];
    let triangles = 0;
    const counts = [0, 0, 0];
    for (const g of built.groups) {
      const L = g.levels.length;
      counts.fill(0);
      const emit = (level: number, i: number, fade: number) => {
        const b = g.levels[level]!, k = counts[level]!, d = g.instances[i]!;
        (b.matrices.array as Float32Array).set(g.rest.subarray(i * 16, i * 16 + 16), k * 16);
        (b.bob.array as Float32Array).set([...d.drift.amplitude, d.drift.period], k * 4);
        (b.spin.array as Float32Array).set([...d.drift.spinAxis, d.drift.spinRate], k * 4);
        (b.phase.array as Float32Array)[k] = d.drift.phase;
        (b.fade.array as Float32Array)[k] = fade;
        counts[level] = k + 1;
      };
      for (let i = 0; i < g.instances.length; i += 1) {
        const size = g.size[i]!, dist = c.distanceTo(g.centres[i]!);
        const cull = Math.min(DEBRIS_LOD.maxCull, Math.max(DEBRIS_LOD.minCull, size * DEBRIS_LOD.cull)) * lodScale;
        if (dist > cull) continue;
        if (!scratch.frustum.intersectsSphere(scratch.sphere.set(g.centres[i]!, g.reach[i]!))) continue;
        const far = Math.min(1, (cull - dist) / (cull * DEBRIS_LOD.farFade));
        let level = 0, blend = -1;
        for (let k = 0; k < L - 1; k += 1) {
          const t = size * DEBRIS_LOD.levelSwitch[Math.min(k, DEBRIS_LOD.levelSwitch.length - 1)]! * lodScale, band = t * DEBRIS_LOD.band;
          if (dist > t + band) level = k + 1;
          else { if (dist > t - band) blend = (dist - (t - band)) / (2 * band); break; }
        }
        if (blend >= 0 && level + 1 < L && far >= 1) {
          // Complementary screen-door masks across the switch band.
          emit(level, i, 1 - blend);
          emit(level + 1, i, 2 - blend);
        } else emit(level, i, far);
      }
      g.levels.forEach((b, k) => {
        const n = counts[k]!;
        for (const [attribute, width] of [[b.matrices, 16], [b.bob, 4], [b.spin, 4], [b.phase, 1], [b.fade, 1]] as const) {
          attribute.clearUpdateRanges(); attribute.addUpdateRange(0, n * width); attribute.needsUpdate = true;
        }
        for (const mesh of b.meshes) { mesh.count = n; mesh.visible = n > 0; }
        visible[k]! += n;
        triangles += n * b.triangles;
      });
    }
    assetStats.debrisVisible = visible;
    assetStats.debrisTrianglesVisible = triangles;
  });
  return <group name="debris-field">{built.groups.flatMap((g) => g.levels.flatMap((l) => l.meshes)).map((mesh) => <primitive key={mesh.uuid} object={mesh} />)}</group>;
}
