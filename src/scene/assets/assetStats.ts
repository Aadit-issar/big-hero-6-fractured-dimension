import type { Vec3 } from '../../simulation/types';

/** Live rendering counters for diagnostics and the benchmark (rendering only). */
export const assetStats = {
  /** Microbots drawn per LOD (full, lod1, lod2) after distance culling. */
  microbotsVisible: [0, 0, 0] as number[],
  microbotTriangles: 0,
  debrisInstances: 0,
  /** Debris instances drawn per LOD (lod0, lod1, lod2) after distance and frustum culling. */
  debrisVisible: [0, 0, 0] as number[],
  /** Triangles of every placed piece at its nearest level (static). */
  debrisTriangles: 0,
  /** Triangles of the debris actually drawn last view (after LOD and culling). */
  debrisTrianglesVisible: 0,
  /** Distinct decoded debris textures and their estimated GPU bytes (RGBA8 + mips). */
  textures: { decoded: 0, reused: 0, gpuBytes: 0 },
  layout: null as null | {
    readonly clusters: readonly string[];
    readonly formations: ReadonlyArray<{ readonly id: string; readonly kind: string; readonly units: number; readonly centre: Vec3; readonly radius: number }>;
    readonly regions: Readonly<Record<string, number>>;
    readonly rejected: Readonly<Record<string, number>>;
  },
};
