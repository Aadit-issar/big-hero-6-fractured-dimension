import { useEffect, useState } from 'react';
import { Box3, LinearFilter, LinearMipmapLinearFilter, Mesh, MeshStandardMaterial, RepeatWrapping, Texture } from 'three';
import type { BufferGeometry } from 'three';
import { GLTFLoader } from 'three/examples/jsm/loaders/GLTFLoader.js';
import type { GLTFLoaderPlugin, GLTFParser } from 'three/examples/jsm/loaders/GLTFLoader.js';
import { updateReadiness } from '../../rendering/renderReadiness';
import { assetSpec, METRES_PER_WORLD_UNIT } from './assetRegistry';

/** Texture tier: caps every embedded texture edge (see AssetSpec.textureCap). */
export type TextureTier = 0 | 1 | 2;
export type AssetPart = { readonly geometry: BufferGeometry; readonly material: MeshStandardMaterial };
/** One detail level of a GLB as instancing-ready parts (one geometry + PBR material per primitive). */
export interface AssetLevel { readonly file: string; readonly parts: readonly AssetPart[]; readonly triangles: number }
export interface LoadedAsset {
  readonly id: string;
  /** Nearest level's parts (shorthand for levels[0].parts). */
  readonly parts: readonly AssetPart[];
  readonly levels: readonly AssetLevel[];
  /** Measured bounds of the nearest level in world units (metres × METRES_PER_WORLD_UNIT). */
  readonly size: readonly [number, number, number];
  readonly triangles: number;
}

// ---------- shared, de-duplicated, capped textures ----------
// Every candidate GLB level embeds its own images, and many images repeat across
// files (capsule and Baymax LODs are byte-identical; the concrete family shares its
// maps). Images are keyed by content hash and cap, so each distinct image is decoded
// and uploaded once, at most `cap` pixels on its longest edge.
interface SharedTexture { texture: Texture; bytes: number; users: number }
const textures = new Map<string, Promise<SharedTexture>>();
/** Rendering diagnostics: distinct decoded images, cache hits and estimated GPU bytes (RGBA8 + mips). */
export const textureStats = { decoded: 0, reused: 0, gpuBytes: 0 };

function contentHash(data: Uint8Array): string {
  let a = 0x811c9dc5, b = 0x01000193 ^ data.length;
  for (let i = 0; i < data.length; i += 1) { a = Math.imul(a ^ data[i]!, 0x01000193); if ((i & 7) === 0) b = Math.imul(b ^ data[i]!, 0x5bd1e995); }
  return `${(a >>> 0).toString(16)}${(b >>> 0).toString(16)}:${data.length}`;
}

async function decode(data: Uint8Array, mimeType: string, cap: number): Promise<SharedTexture> {
  const full = await createImageBitmap(new Blob([data as BlobPart], { type: mimeType }), { premultiplyAlpha: 'none', colorSpaceConversion: 'none' });
  let bitmap = full;
  const longest = Math.max(full.width, full.height);
  if (cap > 0 && longest > cap) {
    const k = cap / longest;
    bitmap = await createImageBitmap(full, { resizeWidth: Math.max(1, Math.round(full.width * k)), resizeHeight: Math.max(1, Math.round(full.height * k)), resizeQuality: 'high', premultiplyAlpha: 'none', colorSpaceConversion: 'none' });
    full.close();
  }
  const texture = new Texture(bitmap);
  texture.flipY = false;
  texture.wrapS = texture.wrapT = RepeatWrapping;
  texture.magFilter = LinearFilter;
  texture.minFilter = LinearMipmapLinearFilter;
  texture.generateMipmaps = true;
  texture.needsUpdate = true;
  const bytes = Math.round(bitmap.width * bitmap.height * 4 * 4 / 3);
  textureStats.gpuBytes += bytes;
  return { texture, bytes, users: 0 };
}

/** GLTFLoader plugin: textures are skipped (geometry-only level) or taken from the shared cache. */
function texturePlugin(parser: GLTFParser, mode: { skip: boolean; cap: number; keys: Set<string> }): GLTFLoaderPlugin {
  return {
    name: 'FRACTURED_shared_textures',
    loadTexture(textureIndex: number) {
      if (mode.skip) return Promise.resolve(null) as unknown as Promise<Texture>;
      const json = parser.json as { textures: Array<{ source: number; sampler?: number }>; images: Array<{ bufferView?: number; mimeType?: string }>; samplers?: Array<{ wrapS?: number; wrapT?: number }> };
      const def = json.textures[textureIndex]!, image = json.images[def.source]!;
      // External URIs keep the loader's default path.
      if (image.bufferView === undefined) return null as unknown as Promise<Texture>;
      const sampler = json.samplers?.[def.sampler ?? -1] ?? {};
      return parser.getDependency('bufferView', image.bufferView).then((view: ArrayBuffer) => {
        const data = new Uint8Array(view);
        const key = `${contentHash(data)}@${mode.cap}:${sampler.wrapS ?? 10497}/${sampler.wrapT ?? 10497}`;
        let entry = textures.get(key);
        if (entry) textureStats.reused += 1;
        else { textureStats.decoded += 1; entry = decode(data, image.mimeType ?? 'image/jpeg', mode.cap); textures.set(key, entry); }
        if (!mode.keys.has(key)) { mode.keys.add(key); void entry.then((e) => { e.users += 1; }); }
        return entry.then((e) => e.texture);
      });
    },
  };
}
function releaseTextures(keys: Iterable<string>): void {
  for (const key of keys) {
    const entry = textures.get(key);
    void entry?.then((e) => {
      e.users -= 1;
      if (e.users > 0 || textures.get(key) !== entry) return;
      textures.delete(key);
      textureStats.gpuBytes -= e.bytes;
      (e.texture.image as ImageBitmap | undefined)?.close?.();
      e.texture.dispose();
    });
  }
}

// ---------- levels and assets ----------
// Keep cold-start downloads below browser/CDN HTTP/2 stream pressure. This only
// limits asset transfer and parsing concurrency; simulation state and timing are unchanged.
const MAX_CONCURRENT_GLTF_LOADS = 8;
let activeGltfLoads = 0;
const gltfLoadQueue: Array<() => void> = [];
async function loadGLTFWithSlot(loader: GLTFLoader, url: string) {
  if (activeGltfLoads >= MAX_CONCURRENT_GLTF_LOADS) {
    await new Promise<void>((resolve) => gltfLoadQueue.push(resolve));
  } else {
    activeGltfLoads += 1;
  }
  try {
    return await loader.loadAsync(url);
  } finally {
    const next = gltfLoadQueue.shift();
    if (next) next();
    else activeGltfLoads -= 1;
  }
}

async function loadLevel(file: string, skipTextures: boolean, cap: number, keys: Set<string>): Promise<AssetLevel> {
  const loader = new GLTFLoader();
  loader.register((parser) => texturePlugin(parser, { skip: skipTextures, cap, keys }));
  const url = import.meta.env.BASE_URL + file.replace(/^\//, '');
  const gltf = await loadGLTFWithSlot(loader, url);
  const parts: AssetPart[] = [];
  gltf.scene.updateMatrixWorld(true);
  gltf.scene.traverse((object) => {
    if (!(object instanceof Mesh)) return;
    const geometry = (object.geometry as BufferGeometry).clone().applyMatrix4(object.matrixWorld);
    if (METRES_PER_WORLD_UNIT !== 1) geometry.scale(METRES_PER_WORLD_UNIT, METRES_PER_WORLD_UNIT, METRES_PER_WORLD_UNIT);
    geometry.computeBoundingBox();
    geometry.computeBoundingSphere();
    parts.push({ geometry, material: object.material as MeshStandardMaterial });
    (object.geometry as BufferGeometry).dispose();
  });
  const triangles = parts.reduce((n, p) => n + (p.geometry.index?.count ?? p.geometry.getAttribute('position').count) / 3, 0);
  return { file, parts, triangles };
}

/** Name without Blender duplicate suffixes (".001"). */
const baseName = (name: string) => name.replace(/\.\d{3}$/, '');

interface CacheEntry { promise: Promise<LoadedAsset>; keys: Set<string>; users: number }
const cache = new Map<string, CacheEntry>();
let requested = 0, loaded = 0, failed = 0;

async function load(id: string, tier: TextureTier, keys: Set<string>): Promise<LoadedAsset> {
  const spec = assetSpec(id);
  const cap = spec.textureCap[tier];
  const source = spec.textureSource;
  const sourceLevel = source === 'own' ? -1 : Math.min(source, spec.levels.length - 1);
  const levels = await Promise.all(spec.levels.map((file, i) => loadLevel(file, source !== 'own' && i !== sourceLevel, cap, keys)));
  if (sourceLevel >= 0) {
    // Geometry-only levels take the textured level's materials (same atlas and names).
    const donor = levels[sourceLevel]!.parts;
    const byName = new Map(donor.map((p) => [baseName(p.material.name), p.material]));
    levels.forEach((level, i) => {
      if (i === sourceLevel) return;
      const parts = level.parts as AssetPart[];
      parts.forEach((p, k) => {
        const material = byName.get(baseName(p.material.name)) ?? donor[k]?.material;
        if (!material) return;
        p.material.dispose();
        parts[k] = { geometry: p.geometry, material };
      });
    });
  }
  const box = new Box3();
  for (const p of levels[0]!.parts) box.union(p.geometry.boundingBox!);
  const s = box.getSize(box.min.clone());
  return { id, parts: levels[0]!.parts, levels, size: [s.x, s.y, s.z] as const, triangles: levels[0]!.triangles };
}

const cacheKey = (id: string, tier: TextureTier) => `${assetSpec(id).id}#${tier}`;

/** Cached, readiness-tracked load. Failures are counted (the loading veil still
 * completes) and the asset is simply absent from the scene. */
export function requestAsset(id: string, tier: TextureTier = 1): Promise<LoadedAsset> {
  const key = cacheKey(id, tier);
  let entry = cache.get(key);
  if (!entry) {
    requested += 1;
    updateReadiness({ assetsTotal: requested });
    const keys = new Set<string>();
    const promise = load(assetSpec(id).id, tier, keys);
    promise.then(() => { loaded += 1; updateReadiness({ assetsReady: loaded + failed }); }, (error: unknown) => {
      failed += 1;
      console.warn(`Asset ${id} failed to load`, error);
      updateReadiness({ assetsReady: loaded + failed, assetsFailed: failed });
    });
    entry = { promise, keys, users: 0 };
    cache.set(key, entry);
  }
  return entry.promise;
}

/** Drops one user of an asset; the last user disposes its geometries, materials and textures. */
function releaseAsset(id: string, tier: TextureTier): void {
  const key = cacheKey(id, tier), entry = cache.get(key);
  if (!entry) return;
  entry.users -= 1;
  if (entry.users > 0) return;
  // Deferred, so a remount (StrictMode, quality toggle back) reuses the loaded asset.
  setTimeout(() => {
    if (entry.users > 0 || cache.get(key) !== entry) return;
    cache.delete(key);
    disposeAsset(entry);
  }, 1500);
}
function disposeAsset(entry: CacheEntry): void {
  void entry.promise.then((asset) => {
    const materials = new Set<MeshStandardMaterial>();
    for (const level of asset.levels) for (const p of level.parts) { p.geometry.dispose(); materials.add(p.material); }
    materials.forEach((m) => m.dispose());
    releaseTextures(entry.keys);
  }, () => undefined);
}

/** Resolves once every requested asset has loaded or failed; missing ids are omitted.
 * Holds a reference while mounted; the last user's unmount disposes GPU resources. */
export function useAssets(ids: readonly string[], tier: TextureTier = 1): Readonly<Record<string, LoadedAsset>> | null {
  const key = ids.join(',');
  const [assets, setAssets] = useState<Readonly<Record<string, LoadedAsset>> | null>(null);
  useEffect(() => {
    let alive = true;
    const list = key ? key.split(',') : [];
    const promises = list.map((id) => requestAsset(id, tier));
    for (const id of list) cache.get(cacheKey(id, tier))!.users += 1;
    void Promise.allSettled(promises).then((results) => {
      if (!alive) return;
      const out: Record<string, LoadedAsset> = {};
      results.forEach((r, i) => { if (r.status === 'fulfilled') out[list[i]!] = r.value; });
      setAssets(out);
    });
    return () => { alive = false; setAssets(null); for (const id of list) releaseAsset(id, tier); };
  }, [key, tier]);
  return assets;
}

/** Texture tier for a quality preset's LOD scale (performance 0.7 → low, balanced 1 → mid,
 * cinematic 1.4 → high). An explicit preset field is requested; see docs/DIMENSION_PLACEMENT.md. */
export function textureTierFor(lodScale: number): TextureTier {
  return lodScale < 0.85 ? 0 : lodScale < 1.2 ? 1 : 2;
}
