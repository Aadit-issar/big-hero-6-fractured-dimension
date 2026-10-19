/** Inspects public/assets/models/microbot.glb by parsing the actual exported file:
 * structure, finite data, unit normals, closed 2-manifold shells (edges welded by
 * position), outward orientation (positive signed volume per material) and bounds.
 * Run: npx tsx assets-src/microbot/inspect.ts */
import { readFileSync, writeFileSync } from 'node:fs';

const file = process.argv[2] ?? 'public/assets/models/microbot.glb';
const glb = readFileSync(file);
const dv = new DataView(glb.buffer, glb.byteOffset, glb.byteLength);
if (dv.getUint32(0, true) !== 0x46546c67 || dv.getUint32(4, true) !== 2) throw new Error('Not a glTF 2.0 GLB');
const jsonLen = dv.getUint32(12, true);
const json = JSON.parse(new TextDecoder().decode(glb.subarray(20, 20 + jsonLen)));
const binStart = 20 + jsonLen + 8;
const bin = glb.subarray(binStart, binStart + dv.getUint32(20 + jsonLen, true));
const read = (accessorIndex: number) => {
  const a = json.accessors[accessorIndex], v = json.bufferViews[a.bufferView];
  const comps = a.type === 'VEC3' ? 3 : 1;
  // Copy: Node Buffer.slice returns a view into a pooled ArrayBuffer.
  const bytes = new Uint8Array(bin.subarray(v.byteOffset, v.byteOffset + v.byteLength));
  return a.componentType === 5126 ? new Float32Array(bytes.buffer, 0, a.count * comps) : new Uint32Array(bytes.buffer, 0, a.count * comps);
};
const report: Record<string, unknown> = { file, bytes: glb.byteLength, meshes: json.meshes.length, materials: json.materials.map((m: { name: string }) => m.name), primitives: [] };
const allEdges = new Map<string, number>();
const key = (p: Float32Array | Uint32Array, i: number) => `${Math.round(p[i * 3]! * 1e6)},${Math.round(p[i * 3 + 1]! * 1e6)},${Math.round(p[i * 3 + 2]! * 1e6)}`;
let degenerate = 0, badNormals = 0, nonFinite = 0, triangles = 0, vertices = 0;
for (const prim of json.meshes[0].primitives) {
  const pos = read(prim.attributes.POSITION), nor = read(prim.attributes.NORMAL), idx = read(prim.indices);
  vertices += pos.length / 3; triangles += idx.length / 3;
  for (const v of pos) if (!Number.isFinite(v)) nonFinite += 1;
  for (let i = 0; i < nor.length; i += 3) if (Math.abs(Math.hypot(nor[i]!, nor[i + 1]!, nor[i + 2]!) - 1) > 1e-3) badNormals += 1;
  let volume = 0, facing = 0;
  for (let t = 0; t < idx.length; t += 3) {
    const [a, b, c] = [idx[t]!, idx[t + 1]!, idx[t + 2]!];
    const A = [pos[a * 3]!, pos[a * 3 + 1]!, pos[a * 3 + 2]!], B = [pos[b * 3]!, pos[b * 3 + 1]!, pos[b * 3 + 2]!], C = [pos[c * 3]!, pos[c * 3 + 1]!, pos[c * 3 + 2]!];
    const ab = [B[0]! - A[0]!, B[1]! - A[1]!, B[2]! - A[2]!], ac = [C[0]! - A[0]!, C[1]! - A[1]!, C[2]! - A[2]!];
    const g = [ab[1]! * ac[2]! - ab[2]! * ac[1]!, ab[2]! * ac[0]! - ab[0]! * ac[2]!, ab[0]! * ac[1]! - ab[1]! * ac[0]!];
    if (Math.hypot(...g) < 1e-14) degenerate += 1;
    // Geometric winding must agree with the stored shading normal.
    const n = [nor[a * 3]! + nor[b * 3]! + nor[c * 3]!, nor[a * 3 + 1]! + nor[b * 3 + 1]! + nor[c * 3 + 1]!, nor[a * 3 + 2]! + nor[b * 3 + 2]! + nor[c * 3 + 2]!];
    if (g[0]! * n[0]! + g[1]! * n[1]! + g[2]! * n[2]! < 0) facing += 1;
    volume += (A[0]! * (B[1]! * C[2]! - B[2]! * C[1]!) - A[1]! * (B[0]! * C[2]! - B[2]! * C[0]!) + A[2]! * (B[0]! * C[1]! - B[1]! * C[0]!)) / 6;
    for (const [p, q] of [[a, b], [b, c], [c, a]] as const) {
      const k1 = key(pos, p), k2 = key(pos, q);
      const k = k1 < k2 ? `${k1}|${k2}` : `${k2}|${k1}`;
      allEdges.set(k, (allEdges.get(k) ?? 0) + 1);
    }
  }
  const acc = json.accessors[prim.attributes.POSITION];
  (report.primitives as object[]).push({ material: json.materials[prim.material].name, triangles: idx.length / 3, vertices: pos.length / 3, signedVolume: volume, windingDisagreesWithNormal: facing, min: acc.min, max: acc.max });
}
const counts = [...allEdges.values()];
const boundary = counts.filter((c) => c === 1).length, nonManifold = counts.filter((c) => c > 2).length;
const mins = (report.primitives as Array<{ min: number[]; max: number[] }>).reduce((m, p) => p.min.map((v, i) => Math.min(v, m[i]!)), [Infinity, Infinity, Infinity]);
const maxs = (report.primitives as Array<{ min: number[]; max: number[] }>).reduce((m, p) => p.max.map((v, i) => Math.max(v, m[i]!)), [-Infinity, -Infinity, -Infinity]);
const totalSignedVolume = (report.primitives as Array<{ signedVolume: number }>).reduce((s, p) => s + p.signedVolume, 0);
Object.assign(report, { totalSignedVolume, triangles, vertices, nonFiniteValues: nonFinite, nonUnitNormals: badNormals, degenerateTriangles: degenerate, edges: counts.length, boundaryEdges: boundary, nonManifoldEdges: nonManifold, boundsMin: mins, boundsMax: maxs, sizeMetres: maxs.map((v, i) => v - mins[i]!) });
writeFileSync(file.replace(/\.glb$/, '.inspection.json'), JSON.stringify(report, null, 2) + '\n');
console.log(JSON.stringify(report, null, 1));
