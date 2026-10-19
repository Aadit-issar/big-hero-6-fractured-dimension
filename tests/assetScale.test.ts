import { createHash } from 'node:crypto';
import { existsSync, readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { ASSETS, DEBRIS_IDS, METRES_PER_WORLD_UNIT, RETIRED_ASSETS, assetSpec } from '../src/scene/assets/assetRegistry';
import { ASSET_SIZES } from '../src/scene/assets/assetSizes';
import { QUALITY_PRESETS } from '../src/rendering/qualitySettings';
import { measureGlb, textureBudget } from '../scripts/placement-manifest';

// The physical scale contract (rendering only): 1 world unit = 1 metre, models
// are authored in metres and never rescaled for visibility.
const manifest = JSON.parse(readFileSync('public/assets/models/manifest.json', 'utf8')) as Record<string, { file: string; size: [number, number, number]; triangles: number; lods?: Array<{ file: string; triangles: number }> }>;
const largest = (id: string) => Math.max(...ASSET_SIZES[id]!.size);

describe('asset scale registry', () => {
  it('uses metres as world units', () => {
    expect(METRES_PER_WORLD_UNIT).toBe(1);
  });

  it('covers exactly the published models, and the generated sizes match the manifest', () => {
    expect(Object.keys(ASSETS).sort()).toEqual(Object.keys(manifest).sort());
    expect(Object.keys(ASSET_SIZES).sort()).toEqual(Object.keys(manifest).sort());
    for (const [id, m] of Object.entries(manifest)) {
      expect(ASSETS[id]!.file).toBe(m.file);
      ASSET_SIZES[id]!.size.forEach((s, k) => expect(s).toBeCloseTo(m.size[k]!, 4));
      expect(ASSET_SIZES[id]!.triangles).toBe(m.triangles);
    }
  });

  it('matches the GLB files on disk (re-run scripts/placement-manifest.ts after refined models arrive)', () => {
    for (const [id, m] of Object.entries(manifest)) {
      if (id.startsWith('microbot')) continue;
      const measured = measureGlb(m.file);
      measured.size.forEach((s, k) => expect(s, `${id} size`).toBeCloseTo(m.size[k]!, 3));
      expect(measured.triangles, `${id} triangles`).toBe(m.triangles);
      for (const level of m.lods ?? []) expect(measureGlb(level.file).triangles, level.file).toBe(level.triangles);
    }
  });

  it('draws the integrated candidate families directly from their review folders, with valid levels', () => {
    for (const id of DEBRIS_IDS) {
      const s = assetSpec(id);
      expect(s.file.startsWith(`/assets/models/candidates/${s.family}/`), id).toBe(true);
      expect(s.levels.length).toBeGreaterThan(0);
      for (const file of s.levels) expect(existsSync(`public${file}`), file).toBe(true);
      // Baymax LOD2 files are broken: never drawn.
      if (s.family === 'baymax') for (const file of s.levels) expect(file).not.toMatch(/_lod2\.glb$/);
      if (s.textureSource !== 'own') expect(s.textureSource).toBeLessThan(Math.max(s.levels.length, s.textureSource + 1));
    }
    for (const family of ['concrete', 'industrial', 'baymax', 'capsule']) expect(DEBRIS_IDS.some((id) => assetSpec(id).family === family), family).toBe(true);
  });

  it('keeps retired library ids working (they resolve to their replacement)', () => {
    for (const [old, replacement] of Object.entries(RETIRED_ASSETS)) expect(assetSpec(old).id, old).toBe(replacement);
  });

  it('keeps every model (and every allowed scale variation) inside its intended physical size', () => {
    for (const spec of Object.values(ASSETS)) {
      const size = ASSET_SIZES[spec.id]!.size;
      for (const s of size) { expect(Number.isFinite(s)).toBe(true); expect(s).toBeGreaterThan(0); }
      const [lo, hi] = spec.intendedLength, [smin, smax] = spec.scaleVariation;
      expect(smin).toBeLessThanOrEqual(smax);
      expect(largest(spec.id) * smin, `${spec.id} smallest`).toBeGreaterThanOrEqual(lo);
      expect(largest(spec.id) * smax, `${spec.id} largest`).toBeLessThanOrEqual(hi);
    }
  });

  it('never varies the scale of microbots, the capsule or Baymax fragments', () => {
    for (const spec of Object.values(ASSETS)) {
      if (['microbot', 'landmark', 'baymax'].includes(spec.category)) expect(spec.scaleVariation).toEqual([1, 1]);
    }
  });

  it('preserves the approved microbot byte for byte, and its LODs share its bounds', () => {
    const glb = readFileSync('public/assets/models/microbot.glb');
    expect(createHash('sha256').update(glb).digest('hex')).toBe('efceac86dfccaa1d090d3442c8b79e0f3747008529bcdedaa67c86facf37329d');
    expect(largest('microbot')).toBeCloseTo(0.0388, 4);
    for (const lod of assetSpec('microbot').lods!) {
      ASSET_SIZES[lod]!.size.forEach((s, k) => expect(Math.abs(s - ASSET_SIZES.microbot!.size[k]!)).toBeLessThan(1e-4));
      expect(ASSET_SIZES[lod]!.triangles).toBeLessThan(ASSET_SIZES.microbot!.triangles);
    }
  });

  it('keeps a physically sensible size hierarchy', () => {
    const microbot = largest('microbot');
    const baymax = Math.max(...DEBRIS_IDS.filter((id) => assetSpec(id).family === 'baymax').map(largest));
    expect(microbot * 10).toBeLessThan(baymax);
    expect(baymax).toBeLessThan(largest('capsule_shell_remnant'));
    // The v2 capsule (≈ 3.9 m heat shield) is the largest single wreck; the wall fragment is ≈ 3.8 m.
    expect(largest('capsule_shell_remnant')).toBeGreaterThan(largest('concrete_slab_plain') * 0.5);
    expect(largest('capsule_shell_remnant')).toBeLessThan(6);
    for (const small of ['capsule_rcs_thruster', 'capsule_antenna_broken', 'capsule_instrument_unit']) expect(largest(small)).toBeLessThan(largest('capsule_shell_remnant'));
    expect(largest('industrial_ibeam_twisted')).toBeGreaterThan(largest('concrete_chunk_a'));
    expect(largest('concrete_rubble_cluster_a')).toBeLessThan(largest('concrete_slab_plain'));
  });

  it('lets quality presets change counts and LOD distances only, never size', () => {
    for (const preset of Object.values(QUALITY_PRESETS)) {
      expect(Object.keys(preset.assets).sort()).toEqual(['lodScale', 'microbotDensity']);
      expect(preset.assets.microbotDensity).toBeGreaterThan(0);
      expect(preset.assets.microbotDensity).toBeLessThanOrEqual(1);
      expect(preset.assets.lodScale).toBeGreaterThan(0);
    }
  });

  it('stays inside the debris texture budget per tier (shared, de-duplicated, capped)', () => {
    const specs = DEBRIS_IDS.map(assetSpec), MB = 2 ** 20;
    // Balanced 280 -> 320 MB, cinematic 480 -> 540 MB, for the v2 capsule landmark (46 material maps, capped at 512 px).
    const budgets = [150, 320, 540];
    budgets.forEach((limit, tier) => expect(textureBudget(specs, tier).gpuBytes / MB, `tier ${tier}`).toBeLessThan(limit));
  });
});
