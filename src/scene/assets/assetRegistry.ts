/** Central asset scale registry (rendering only; nothing here reaches src/simulation).
 *
 * WORLD SCALE CONVENTION: 1 world (rendering) unit = 1 metre.
 * Grounded in existing code rather than assumed:
 *  - traversable fold apertures are 1.55 u in radius (a 3.1 m opening sized for
 *    Hiro and Baymax), and the traversal approach radius is 5 u;
 *  - free flight moves at 14 u/s (≈ 50 km/h, armoured flight) and 42 u/s boosted;
 *  - the explorer's mapped coordinates are X = 7.5·(q + 4∇Φ), so one reference unit
 *    spans 7.5 m; islands are 2.2–4.35 u in radius and 1.3–2.6 u thick (rock masses
 *    ≈ 5–9 m across, the same size class as a large wall slab).
 * GLBs are authored in metres, so the model→world scale is exactly 1. Assets are
 * never rescaled for visibility; small things stay small (see tests/assetScale.test.ts).
 *
 * The dimension uses the reviewed candidate families (concrete, industrial, Baymax,
 * capsule) directly from public/assets/models/candidates/ and the approved microbot.
 * Files, LOD levels and measured sizes come from the generated assetSizes.ts
 * (scripts/placement-manifest.ts), never from hand-typed numbers.
 */
import { ASSET_SIZES } from './assetSizes';

export const METRES_PER_WORLD_UNIT = 1;

export type AssetCategory = 'microbot' | 'concrete' | 'rubble' | 'steel' | 'scaffold' | 'walkway' | 'pipe' | 'electrical' | 'panel' | 'landmark' | 'baymax';
export type AssetFamily = 'microbot' | 'concrete' | 'industrial' | 'baymax' | 'capsule';
/** Placement role in the visual hierarchy: anchors, mid-size pieces, small fillers. */
export type AssetRole = 'anchor' | 'mid' | 'filler';

/** How a multi-level asset gets its textures (each GLB level embeds its own):
 *  - a level index: only that level's textures are decoded; the other levels are
 *    loaded geometry-only and take its materials by name (same UV atlas; verified
 *    for the industrial, Baymax and capsule families);
 *  - 'own': every level keeps its own textures (concrete LODs are re-baked). */
export type TextureSource = number | 'own';

export interface AssetSpec {
  readonly id: string;
  readonly file: string;
  readonly category: AssetCategory;
  readonly family: AssetFamily;
  readonly role: AssetRole;
  /** Intended physical size (largest dimension, metres) and where that estimate comes from. */
  readonly intendedLength: readonly [number, number];
  readonly scaleSource: string;
  /** Allowed per-instance uniform scale variation (1 = fixed). */
  readonly scaleVariation: readonly [number, number];
  /** Coarser LOD asset ids, nearest first (microbot only: its LODs are separate registry ids). */
  readonly lods?: readonly string[];
  /** GLB files drawn per detail level, nearest first. */
  readonly levels: readonly string[];
  readonly textureSource: TextureSource;
  /** Largest texture edge (px) per texture tier: [low, mid, high]. */
  readonly textureCap: readonly [number, number, number];
}

const DESIGN = 'Design starting range from the production brief (illustrative, not film-verified)';
const measured = (id: string) => {
  const m = ASSET_SIZES[id];
  if (!m) throw new RangeError(`Asset ${id} is not in the generated manifest`);
  return m;
};
/** Levels to draw: the base file plus measured LODs, minus duplicates (identical triangle count) and skipped levels. */
function levelsOf(id: string, skip: readonly number[] = []): string[] {
  const m = measured(id), all = [{ file: m.file, triangles: m.triangles }, ...m.lods];
  return all.filter((l, i) => !skip.includes(i) && (i === 0 || l.triangles !== all[i - 1]!.triangles)).map((l) => l.file);
}

interface Options { family: AssetFamily; role: AssetRole; scale?: [number, number]; textureSource?: TextureSource; cap?: [number, number, number]; skip?: number[] }
function spec(id: string, category: AssetCategory, intendedLength: [number, number], scaleSource: string, o: Options): AssetSpec {
  return {
    id, file: measured(id).file, category, family: o.family, role: o.role, intendedLength, scaleSource, scaleVariation: o.scale ?? [0.9, 1.1],
    levels: levelsOf(id, o.skip), textureSource: o.textureSource ?? 0, textureCap: o.cap ?? [512, 512, 1024],
  };
}

const CONCRETE = { family: 'concrete' as const };
const INDUSTRIAL = { family: 'industrial' as const, textureSource: 1 };
const BAYMAX = { family: 'baymax' as const, scale: [1, 1] as [number, number], cap: [512, 512, 1024] as [number, number, number] };
const CAPSULE = { family: 'capsule' as const, scale: [1, 1] as [number, number], cap: [384, 512, 1024] as [number, number, number] };
const BAYMAX_SRC = 'Estimated from Baymax armour proportions (≈ 2 m tall robot); unverified';
const CAPSULE_SRC = 'Estimated: crew capsule ≈ 3.9 m heat shield (v2 model); film dimensions unverified';

export const ASSETS: Readonly<Record<string, AssetSpec>> = Object.fromEntries([
  ...(['microbot', 'microbot_lod1', 'microbot_lod2'] as const).map((id) => ({
    ...spec(id, 'microbot', [0.03, 0.05], id === 'microbot' ? 'Approved prototype 38.8 mm (fingertip scale; working assumption)' : 'LOD of the approved microbot (same bounds)', { family: 'microbot', role: 'filler', scale: [1, 1] }),
    ...(id === 'microbot' ? { lods: ['microbot_lod1', 'microbot_lod2'] } : {}),
  })),
  // Concrete family (shared textures). Slab and wall LODs are decimations of LOD0 that keep
  // its UVs, so they draw with LOD0's materials (their own black bakes were replaced).
  spec('concrete_wall_breach', 'concrete', [2, 6], `${DESIGN}: large construction slab 2–6 m`, { ...CONCRETE, role: 'anchor', scale: [0.95, 1.05], cap: [512, 1024, 1024] }),
  spec('concrete_slab_rebar', 'concrete', [2, 6], `${DESIGN}: large construction slab 2–6 m`, { ...CONCRETE, role: 'mid', cap: [512, 1024, 1024] }),
  spec('concrete_slab_plain', 'concrete', [2, 6], `${DESIGN}: large construction slab 2–6 m`, { ...CONCRETE, role: 'mid' }),
  spec('concrete_chunk_a', 'concrete', [0.5, 2], `${DESIGN}: medium concrete fragment 0.5–2 m`, { ...CONCRETE, role: 'filler', scale: [0.85, 1.15] }),
  spec('concrete_chunk_b', 'concrete', [0.5, 2.2], `${DESIGN}: medium concrete fragment 0.5–2 m (slab-edge strip)`, { ...CONCRETE, role: 'filler', scale: [0.85, 1.1] }),
  spec('concrete_chunk_c', 'concrete', [0.5, 2], `${DESIGN}: medium concrete fragment 0.5–2 m`, { ...CONCRETE, role: 'filler', scale: [0.85, 1.15] }),
  spec('concrete_rubble_cluster_a', 'rubble', [0.8, 2.5], `${DESIGN}: small rubble pieces 10–50 cm (cluster extent)`, { ...CONCRETE, role: 'filler', scale: [0.8, 1.2] }),
  spec('concrete_rubble_cluster_b', 'rubble', [0.8, 2.5], `${DESIGN}: small rubble pieces 10–50 cm (cluster extent)`, { ...CONCRETE, role: 'filler', scale: [0.8, 1.2] }),
  // Industrial family (LOD textures are the same atlas at 2048/1024/512).
  spec('industrial_steel_girder_premium', 'steel', [2, 8], `${DESIGN}: steel beam 2–8 m`, { ...INDUSTRIAL, role: 'anchor', cap: [512, 1024, 1024] }),
  spec('industrial_ibeam_twisted', 'steel', [2, 8], `${DESIGN}: steel beam 2–8 m; 360 mm I-section`, { ...INDUSTRIAL, role: 'mid' }),
  spec('industrial_ibeam_bolted', 'steel', [2, 8], `${DESIGN}: steel beam 2–8 m; 360 mm I-section`, { ...INDUSTRIAL, role: 'mid' }),
  spec('industrial_column_bent', 'steel', [2, 8], `${DESIGN}: steel beam 2–8 m; 300 mm H-column`, { ...INDUSTRIAL, role: 'mid' }),
  spec('industrial_scaffold_section', 'scaffold', [2.5, 6], `${DESIGN}: scaffolding assembly; Ø48 mm tube, 2 m bay`, { ...INDUSTRIAL, role: 'anchor', cap: [512, 1024, 1024] }),
  spec('industrial_scaffold_pole_bent', 'scaffold', [2, 6.5], 'Standard scaffold tube lengths (2–6.4 m)', { ...INDUSTRIAL, role: 'filler', textureSource: 2 }),
  spec('industrial_walkway_section', 'walkway', [2, 8], `${DESIGN}: walkway section 2–8 m; 1 m wide, 1.05 m rail`, { ...INDUSTRIAL, role: 'mid' }),
  spec('industrial_walkway_torn', 'walkway', [2, 8], `${DESIGN}: walkway section 2–8 m`, { ...INDUSTRIAL, role: 'anchor', cap: [512, 1024, 1024] }),
  spec('industrial_pipe_large_fractured', 'pipe', [1, 6], `${DESIGN}: industrial pipe section 1–6 m; Ø600 mm`, { ...INDUSTRIAL, role: 'mid' }),
  spec('industrial_pipe_elbow_torn', 'pipe', [1, 6], `${DESIGN}: industrial pipe section 1–6 m; Ø300 mm`, { ...INDUSTRIAL, role: 'filler', textureSource: 2 }),
  spec('industrial_cable_bundle', 'electrical', [0.5, 4], `${DESIGN}: loose cable centimetres to metres; Ø27 mm cables`, { ...INDUSTRIAL, role: 'filler', textureSource: 2 }),
  spec('industrial_junction_box_broken', 'electrical', [0.4, 2], 'Wall-mounted industrial enclosure with torn conduit ≈ 0.7 × 1.7 m', { ...INDUSTRIAL, role: 'filler', textureSource: 2 }),
  spec('industrial_facility_panel', 'panel', [1.5, 4], 'Facility wall cladding panel ≈ 2.2 × 1.3 m', { ...INDUSTRIAL, role: 'mid' }),
  // Baymax remnants (LOD2 files are broken: LOD1 is the farthest level; excluded in the manifest).
  spec('baymax_chest_armor', 'baymax', [0.8, 1.6], BAYMAX_SRC, { ...BAYMAX, role: 'mid' }),
  spec('baymax_shoulder_shell', 'baymax', [0.5, 1.3], BAYMAX_SRC, { ...BAYMAX, role: 'mid' }),
  spec('baymax_forearm_shell', 'baymax', [0.4, 1.3], BAYMAX_SRC, { ...BAYMAX, role: 'filler' }),
  spec('baymax_joint_shell', 'baymax', [0.3, 1], BAYMAX_SRC, { ...BAYMAX, role: 'filler' }),
  spec('baymax_plating_shard', 'baymax', [0.3, 1], BAYMAX_SRC, { ...BAYMAX, role: 'filler' }),
  // Capsule: the narrative landmark and the components of its debris trail.
  spec('capsule_shell_remnant', 'landmark', [3.4, 4.6], CAPSULE_SRC, { ...CAPSULE, role: 'anchor', cap: [256, 512, 1024] }),
  spec('capsule_collar_ring', 'landmark', [1.5, 3.2], `${CAPSULE_SRC}; separation collar Ø ≈ 2.2 m`, { ...CAPSULE, role: 'mid' }),
  spec('capsule_heatshield_panel', 'landmark', [0.8, 2.6], CAPSULE_SRC, { ...CAPSULE, role: 'mid' }),
  spec('capsule_upper_shell_fragment', 'landmark', [0.8, 2.6], CAPSULE_SRC, { ...CAPSULE, role: 'mid' }),
  spec('capsule_impact_fragment', 'landmark', [0.8, 2.6], CAPSULE_SRC, { ...CAPSULE, role: 'mid' }),
  spec('capsule_rcs_thruster', 'landmark', [0.3, 1.2], CAPSULE_SRC, { ...CAPSULE, role: 'filler' }),
  spec('capsule_antenna_broken', 'landmark', [0.25, 1.2], CAPSULE_SRC, { ...CAPSULE, role: 'filler' }),
  spec('capsule_instrument_unit', 'landmark', [0.3, 1.2], CAPSULE_SRC, { ...CAPSULE, role: 'filler' }),
].map((s) => [s.id, s]));

/** Old procedural library ids, retired in favour of the reviewed candidates (the
 * old GLBs stay on disk for the gallery's old-versus-candidate lineup). */
export const RETIRED_ASSETS: Readonly<Record<string, string>> = {
  rubble_cluster_a: 'concrete_rubble_cluster_a', rubble_cluster_b: 'concrete_rubble_cluster_b',
  steel_ibeam_twisted: 'industrial_ibeam_twisted', steel_ibeam_bolted: 'industrial_ibeam_bolted', steel_column_bent: 'industrial_column_bent',
  scaffold_section: 'industrial_scaffold_section', scaffold_pole_bent: 'industrial_scaffold_pole_bent',
  walkway_section: 'industrial_walkway_section', walkway_torn: 'industrial_walkway_torn',
  pipe_large_fractured: 'industrial_pipe_large_fractured', pipe_elbow_torn: 'industrial_pipe_elbow_torn',
  cable_bundle: 'industrial_cable_bundle', junction_box_broken: 'industrial_junction_box_broken', facility_panel_krei: 'industrial_facility_panel',
  capsule_collar_remnant: 'capsule_collar_ring', baymax_shoulder_fragment: 'baymax_shoulder_shell', baymax_forearm_fragment: 'baymax_forearm_shell',
};

/** Resolves an id (retired library ids map to their replacement; the concrete
 * candidates kept the library ids). */
export function assetSpec(id: string): AssetSpec {
  const s = ASSETS[id] ?? ASSETS[RETIRED_ASSETS[id] ?? ''];
  if (!s) throw new RangeError(`Unknown asset ${id}`);
  return s;
}

/** Ids of debris assets (everything except the microbot chain). */
export const DEBRIS_IDS: readonly string[] = Object.values(ASSETS).filter((s) => s.family !== 'microbot').map((s) => s.id);
