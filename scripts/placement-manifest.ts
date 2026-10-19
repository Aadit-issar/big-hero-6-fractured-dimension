import { createHash } from 'node:crypto';
import { readFileSync, writeFileSync } from 'node:fs';
import { Box3, Matrix4, Quaternion, Vector3 } from 'three';

/** Integrated-asset manifest generator (rendering only).
 *
 * Reads the reviewed candidate families from public/assets/models/candidates/
 * manifest.json, MEASURES every GLB level actually used (bounds with the node
 * hierarchy applied, triangles, vertices, materials, largest embedded texture)
 * and writes:
 *  - public/assets/models/manifest.json (approved microbot + integrated candidates),
 *  - src/scene/assets/assetSizes.ts (generated sizes, files and LOD levels).
 * Sizes are never typed by hand, so refined GLBs (for example the capsule family)
 * drop in by re-running: npx tsx scripts/placement-manifest.ts
 * tests/assetScale.test.ts re-measures the GLBs and fails if this was not re-run. */

const ROOT = 'public';
export interface GlbInfo { readonly size: [number, number, number]; readonly min: [number, number, number]; readonly max: [number, number, number]; readonly triangles: number; readonly vertices: number; readonly materials: string[]; readonly maxTexture: number; readonly bytes: number }

/** Parses a binary glTF's JSON chunk (no decoding of buffers except image headers). */
export function measureGlb(file: string): GlbInfo {
  const bytes = readFileSync(`${ROOT}${file}`);
  if (bytes.readUInt32LE(0) !== 0x46546c67) throw new Error(`${file} is not a GLB`);
  const jsonLength = bytes.readUInt32LE(12);
  const json = JSON.parse(bytes.subarray(20, 20 + jsonLength).toString('utf8')) as {
    nodes?: Array<{ mesh?: number; children?: number[]; matrix?: number[]; translation?: number[]; rotation?: number[]; scale?: number[] }>;
    scenes?: Array<{ nodes: number[] }>; scene?: number;
    meshes: Array<{ primitives: Array<{ attributes: Record<string, number>; indices?: number }> }>;
    accessors: Array<{ count: number; min?: number[]; max?: number[] }>;
    materials?: Array<{ name?: string }>;
    images?: Array<{ bufferView?: number; mimeType?: string }>;
    bufferViews?: Array<{ byteOffset?: number; byteLength: number }>;
  };
  const binStart = 20 + jsonLength + 8;
  const box = new Box3();
  let triangles = 0, vertices = 0;
  const local = (n: NonNullable<typeof json.nodes>[number]) => n.matrix ? new Matrix4().fromArray(n.matrix)
    : new Matrix4().compose(new Vector3(...(n.translation ?? [0, 0, 0])), new Quaternion(...(n.rotation ?? [0, 0, 0, 1])), new Vector3(...(n.scale ?? [1, 1, 1])));
  const visit = (index: number, parent: Matrix4) => {
    const node = json.nodes![index]!;
    const world = parent.clone().multiply(local(node));
    if (node.mesh !== undefined) for (const p of json.meshes[node.mesh]!.primitives) {
      const pos = json.accessors[p.attributes.POSITION!]!;
      const corners = [0, 1, 2, 3, 4, 5, 6, 7].map((k) => new Vector3(k & 1 ? pos.max![0]! : pos.min![0]!, k & 2 ? pos.max![1]! : pos.min![1]!, k & 4 ? pos.max![2]! : pos.min![2]!).applyMatrix4(world));
      for (const c of corners) box.expandByPoint(c);
      triangles += (p.indices !== undefined ? json.accessors[p.indices]!.count : pos.count) / 3;
      vertices += pos.count;
    }
    for (const c of node.children ?? []) visit(c, world);
  };
  for (const n of json.scenes?.[json.scene ?? 0]?.nodes ?? []) visit(n, new Matrix4());
  // Largest embedded image dimension (JPEG SOF / PNG IHDR header only).
  let maxTexture = 0;
  for (const image of json.images ?? []) {
    const view = json.bufferViews![image.bufferView!]!;
    const data = bytes.subarray(binStart + (view.byteOffset ?? 0), binStart + (view.byteOffset ?? 0) + view.byteLength);
    let w = 0, h = 0;
    if (data[0] === 0x89 && data[1] === 0x50) { w = data.readUInt32BE(16); h = data.readUInt32BE(20); }
    else for (let i = 2; i < data.length - 9;) {
      if (data[i] !== 0xff) { i += 1; continue; }
      const marker = data[i + 1]!;
      if (marker >= 0xc0 && marker <= 0xcf && marker !== 0xc4 && marker !== 0xc8 && marker !== 0xcc) { h = data.readUInt16BE(i + 5); w = data.readUInt16BE(i + 7); break; }
      i += 2 + data.readUInt16BE(i + 2);
    }
    maxTexture = Math.max(maxTexture, w, h);
  }
  const s = box.getSize(new Vector3());
  const r = (x: number) => +x.toFixed(5);
  return { size: [r(s.x), r(s.y), r(s.z)], min: [r(box.min.x), r(box.min.y), r(box.min.z)], max: [r(box.max.x), r(box.max.y), r(box.max.z)], triangles: Math.round(triangles), vertices, materials: (json.materials ?? []).map((m) => m.name ?? ''), maxTexture, bytes: bytes.length };
}

interface Candidate { file: string; replaces: string | null; category: string; label: string; family?: string; lods?: unknown }
/** The three family manifests store LODs differently: {lod1,lod2}, {"1","2"} or a list. */
export function candidateLodFiles(c: Candidate): string[] {
  const l = c.lods;
  if (!l) return [];
  if (Array.isArray(l)) return (l as Array<{ file: string }>).map((x) => x.file);
  return Object.entries(l as Record<string, { file: string }>).sort(([a], [b]) => a.localeCompare(b, 'en', { numeric: true })).map(([, x]) => x.file);
}

/** Known-broken levels never used (Baymax LOD2 files are broken: LOD1 is the farthest level). */
const BROKEN_LEVEL = (id: string, level: number) => id.startsWith('baymax_') && level === 2;
export const INTEGRATED_FAMILIES = ['concrete', 'industrial', 'baymax', 'capsule'] as const;

export function integratedEntries() {
  const candidates = JSON.parse(readFileSync(`${ROOT}/assets/models/candidates/manifest.json`, 'utf8')) as Record<string, Candidate | string>;
  const out: Record<string, unknown> = {};
  for (const [id, c] of Object.entries(candidates)) {
    if (typeof c === 'string' || !c.family || !(INTEGRATED_FAMILIES as readonly string[]).includes(c.family)) continue;
    const files = [c.file, ...candidateLodFiles(c)].filter((_, level) => !BROKEN_LEVEL(id, level));
    const levels = files.map((file) => ({ file, ...measureGlb(file) }));
    const base = levels[0]!;
    out[id] = {
      file: base.file, bytes: base.bytes, triangles: base.triangles, vertices: base.vertices, materials: base.materials, min: base.min, max: base.max, size: base.size,
      family: c.family, replaces: c.replaces, label: c.label, maxTexture: base.maxTexture,
      lods: levels.slice(1).map((l) => ({ file: l.file, bytes: l.bytes, triangles: l.triangles, size: l.size, maxTexture: l.maxTexture, materials: l.materials })),
    };
  }
  return out;
}

if (process.argv[1]?.replace(/\\/g, '/').endsWith('scripts/placement-manifest.ts')) {
  const path = `${ROOT}/assets/models/manifest.json`;
  const old = JSON.parse(readFileSync(path, 'utf8')) as Record<string, { file: string; size: number[]; triangles: number }>;
  const manifest: Record<string, unknown> = {};
  // The approved microbot and its LODs are kept byte for byte as recorded.
  for (const id of ['microbot', 'microbot_lod1', 'microbot_lod2']) manifest[id] = old[id];
  Object.assign(manifest, integratedEntries());
  writeFileSync(path, JSON.stringify(manifest, null, 2) + '\n');
  type Entry = { file: string; size: number[]; triangles: number; bytes: number; maxTexture?: number; lods?: Array<{ file: string; triangles: number; bytes: number; maxTexture: number }> };
  const lines = Object.entries(manifest as Record<string, Entry>).map(([id, m]) =>
    `  ${id}: { size: [${m.size.join(', ')}], triangles: ${m.triangles}, file: '${m.file}', bytes: ${m.bytes}, maxTexture: ${m.maxTexture ?? 0}, lods: [${(m.lods ?? []).map((l) => `{ file: '${l.file}', triangles: ${l.triangles}, bytes: ${l.bytes}, maxTexture: ${l.maxTexture} }`).join(', ')}] },`);
  writeFileSync('src/scene/assets/assetSizes.ts', `// Generated by scripts/placement-manifest.ts from public/assets/models/manifest.json. Do not edit.
/** One LOD level after the base file: its GLB, triangles, bytes and largest embedded texture (px). */
export interface AssetLevel { readonly file: string; readonly triangles: number; readonly bytes: number; readonly maxTexture: number }
/** Measured model bounds (metres), triangles and levels of every model the dimension uses. */
export const ASSET_SIZES: Readonly<Record<string, { readonly size: readonly [number, number, number]; readonly triangles: number; readonly file: string; readonly bytes: number; readonly maxTexture: number; readonly lods: readonly AssetLevel[] }>> = {
${lines.join('\n')}
};
`);
  console.log(`wrote ${path} and src/scene/assets/assetSizes.ts: ${Object.keys(manifest).length} models`);
}

/** Embedded images of a GLB: content hash and pixel size (header only). */
export function glbImages(file: string): Array<{ hash: string; width: number; height: number }> {
  const bytes = readFileSync(`${ROOT}${file}`);
  const jsonLength = bytes.readUInt32LE(12);
  const json = JSON.parse(bytes.subarray(20, 20 + jsonLength).toString('utf8')) as { images?: Array<{ bufferView?: number }>; bufferViews?: Array<{ byteOffset?: number; byteLength: number }> };
  const binStart = 20 + jsonLength + 8;
  return (json.images ?? []).map((image) => {
    const view = json.bufferViews![image.bufferView!]!;
    const data = bytes.subarray(binStart + (view.byteOffset ?? 0), binStart + (view.byteOffset ?? 0) + view.byteLength);
    let width = 0, height = 0;
    if (data[0] === 0x89 && data[1] === 0x50) { width = data.readUInt32BE(16); height = data.readUInt32BE(20); }
    else for (let i = 2; i < data.length - 9;) {
      if (data[i] !== 0xff) { i += 1; continue; }
      const marker = data[i + 1]!;
      if (marker >= 0xc0 && marker <= 0xcf && marker !== 0xc4 && marker !== 0xc8 && marker !== 0xcc) { height = data.readUInt16BE(i + 5); width = data.readUInt16BE(i + 7); break; }
      i += 2 + data.readUInt16BE(i + 2);
    }
    return { hash: createHash('sha1').update(data).digest('hex'), width, height };
  });
}

/** Debris texture budget for a tier, mirroring assetLoader: only the texture-source
 * level's images (every level for 'own'), de-duplicated by content and cap, capped
 * to the asset's tier limit; RGBA8 with a full mip chain. Also the download size. */
export function textureBudget(specs: ReadonlyArray<{ id: string; levels: readonly string[]; textureSource: number | 'own'; textureCap: readonly number[] }>, tier: number) {
  const unique = new Map<string, number>();
  let bytes = 0;
  for (const s of specs) {
    const cap = s.textureCap[tier]!;
    s.levels.forEach((file, i) => {
      bytes += readFileSync(`${ROOT}${file}`).length;
      const source = s.textureSource === 'own' ? i : Math.min(s.textureSource, s.levels.length - 1);
      if (i !== source) return;
      for (const img of glbImages(file)) {
        const k = Math.min(1, cap / Math.max(img.width, img.height, 1));
        unique.set(`${img.hash}@${cap}`, Math.round(img.width * k) * Math.round(img.height * k) * 4 * 4 / 3);
      }
    });
  }
  return { images: unique.size, gpuBytes: [...unique.values()].reduce((a, b) => a + b, 0), downloadBytes: bytes };
}
