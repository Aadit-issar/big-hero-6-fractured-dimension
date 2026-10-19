/** Minimal glTF 2.0 binary (GLB) writer for procedurally modelled assets.
 * One node → one mesh → one primitive per material; PBR metallic-roughness
 * materials; POSITION (with required min/max), NORMAL and UINT32 indices. */

export interface GltfMaterial {
  readonly name: string;
  readonly baseColor: readonly [number, number, number, number];
  readonly metallic: number;
  readonly roughness: number;
}

export interface Primitive {
  readonly geometry: { readonly positions: Float32Array; readonly normals: Float32Array; readonly indices: Uint32Array; readonly colors?: Float32Array };
  readonly material: number;
}

const ARRAY_BUFFER = 34962, ELEMENT_ARRAY_BUFFER = 34963, FLOAT = 5126, UNSIGNED_INT = 5125, TRIANGLES = 4;

export function writeGlb({ name, primitives, materials }: { name: string; primitives: readonly Primitive[]; materials: readonly GltfMaterial[] }): Uint8Array {
  const chunks: Uint8Array[] = [];
  const bufferViews: object[] = [];
  const accessors: object[] = [];
  let offset = 0;
  const pushView = (bytes: Uint8Array, target: number): number => {
    const padded = (bytes.byteLength + 3) & ~3;
    const view = new Uint8Array(padded);
    view.set(bytes);
    chunks.push(view);
    bufferViews.push({ buffer: 0, byteOffset: offset, byteLength: bytes.byteLength, target });
    offset += padded;
    return bufferViews.length - 1;
  };
  const meshPrimitives = primitives.map((p) => {
    const { positions, normals, indices } = p.geometry;
    for (const v of positions) if (!Number.isFinite(v)) throw new RangeError(`${name}: non-finite vertex position`);
    for (const v of normals) if (!Number.isFinite(v)) throw new RangeError(`${name}: non-finite normal`);
    const min = [Infinity, Infinity, Infinity], max = [-Infinity, -Infinity, -Infinity];
    for (let i = 0; i < positions.length; i += 3) for (let k = 0; k < 3; k += 1) {
      min[k] = Math.min(min[k]!, positions[i + k]!); max[k] = Math.max(max[k]!, positions[i + k]!);
    }
    const count = positions.length / 3;
    const pos = accessors.push({ bufferView: pushView(new Uint8Array(positions.buffer, positions.byteOffset, positions.byteLength), ARRAY_BUFFER), componentType: FLOAT, count, type: 'VEC3', min, max }) - 1;
    const nor = accessors.push({ bufferView: pushView(new Uint8Array(normals.buffer, normals.byteOffset, normals.byteLength), ARRAY_BUFFER), componentType: FLOAT, count, type: 'VEC3' }) - 1;
    const attributes: Record<string, number> = { POSITION: pos, NORMAL: nor };
    const colors = p.geometry.colors;
    if (colors) {
      for (const v of colors) if (!Number.isFinite(v) || v < 0 || v > 1) throw new RangeError(`${name}: vertex colour outside [0, 1]`);
      attributes.COLOR_0 = accessors.push({ bufferView: pushView(new Uint8Array(colors.buffer, colors.byteOffset, colors.byteLength), ARRAY_BUFFER), componentType: FLOAT, count, type: 'VEC3' }) - 1;
    }
    const idx = accessors.push({ bufferView: pushView(new Uint8Array(indices.buffer, indices.byteOffset, indices.byteLength), ELEMENT_ARRAY_BUFFER), componentType: UNSIGNED_INT, count: indices.length, type: 'SCALAR' }) - 1;
    return { attributes, indices: idx, material: p.material, mode: TRIANGLES };
  });
  const json = {
    asset: { version: '2.0', generator: 'BigHero6 assets-src/gltf/writeGlb.ts' },
    scene: 0,
    scenes: [{ name, nodes: [0] }],
    nodes: [{ name, mesh: 0 }],
    meshes: [{ name, primitives: meshPrimitives }],
    materials: materials.map((m) => ({ name: m.name, pbrMetallicRoughness: { baseColorFactor: [...m.baseColor], metallicFactor: m.metallic, roughnessFactor: m.roughness } })),
    buffers: [{ byteLength: offset }],
    bufferViews,
    accessors,
  };
  const jsonBytes = new TextEncoder().encode(JSON.stringify(json));
  const jsonPadded = new Uint8Array((jsonBytes.byteLength + 3) & ~3).fill(0x20);
  jsonPadded.set(jsonBytes);
  const bin = new Uint8Array(offset);
  let o = 0;
  for (const c of chunks) { bin.set(c, o); o += c.byteLength; }
  const total = 12 + 8 + jsonPadded.byteLength + 8 + bin.byteLength;
  const out = new Uint8Array(total);
  const dv = new DataView(out.buffer);
  dv.setUint32(0, 0x46546c67, true); dv.setUint32(4, 2, true); dv.setUint32(8, total, true);
  dv.setUint32(12, jsonPadded.byteLength, true); dv.setUint32(16, 0x4e4f534a, true); out.set(jsonPadded, 20);
  const binHeader = 20 + jsonPadded.byteLength;
  dv.setUint32(binHeader, bin.byteLength, true); dv.setUint32(binHeader + 4, 0x004e4942, true); out.set(bin, binHeader + 8);
  return out;
}
