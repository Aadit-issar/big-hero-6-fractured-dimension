import { ASSETS } from '../../src/scene/assets/assetRegistry';
import type { AssetSpec } from '../../src/scene/assets/assetRegistry';
import type { DebrisInstance, DimensionLayout, MicrobotFormation } from '../../src/scene/assets/placement';

/** Gallery catalogue. Built at run time from the live sources, so models produced
 * later appear after "Refresh catalogue" (no gallery rebuild):
 *  - public/assets/models/manifest.json (written by assets-src/library/buildLibrary.ts),
 *  - src/scene/assets/assetRegistry.ts (scale registry; hot-reloaded by Vite),
 *  - the dimension's own deterministic layout (formations and debris clusters),
 *  - the world's islands (procedural geology, generated on demand),
 *  - tools/asset-viewer/references.json (reference sheets and planned components). */
export type EntryKind = 'glb' | 'formation' | 'cluster' | 'terrain' | 'lineup' | 'planned';
export type EntryStatus = 'candidate' | 'approved' | 'wip' | 'missing' | 'unregistered' | 'layout' | 'procedural' | 'shader' | 'notplanned' | 'failed';

export interface ManifestEntry { file: string; bytes: number; triangles: number; vertices: number; materials: string[]; size: [number, number, number] }
export type Manifest = Record<string, ManifestEntry>;
export interface ReferenceConfig {
  sheets: Array<{ match: string; title: string; categories: string[] }>;
  planned: Array<{ label: string; category: string; status: string; note?: string }>;
}

export interface Entry {
  readonly id: string;
  readonly label: string;
  readonly group: string;
  readonly kind: EntryKind;
  status: EntryStatus;
  /** Category used to pick reference sheets. */
  readonly refCategory: string;
  readonly file?: string;
  readonly note?: string;
  readonly spec?: AssetSpec;
  readonly manifest?: ManifestEntry | undefined;
  readonly formation?: MicrobotFormation;
  readonly cluster?: readonly DebrisInstance[];
  readonly islandIndex?: number;
  readonly lineup?: readonly string[];
}

/** Only the microbot has passed the user's approval gate (commit 3ade503). */
export const APPROVED: Readonly<Record<string, string>> = { microbot: 'Approved prototype (commit 3ade503); generator output byte-identical' };

export const GROUPS = [
  'Candidates (under review)', 'Microbots', 'Microbot formations', 'Concrete & rubble', 'Steel beams', 'Scaffolding', 'Walkways', 'Pipes', 'Cables & electrical',
  'Facility panels', 'Capsule components', 'Baymax remnants', 'Debris clusters', 'Island geology (procedural)', 'True-scale lineups',
  'Planned, missing & shader effects', 'Unregistered models',
] as const;
const GROUP_OF: Record<string, (typeof GROUPS)[number]> = {
  microbot: 'Microbots', concrete: 'Concrete & rubble', rubble: 'Concrete & rubble', steel: 'Steel beams', scaffold: 'Scaffolding', walkway: 'Walkways',
  pipe: 'Pipes', electrical: 'Cables & electrical', panel: 'Facility panels', landmark: 'Capsule components', baymax: 'Baymax remnants',
};

export const pretty = (id: string) => id.replace(/[_-]+/g, ' ').replace(/\b(lod)(\d)\b/i, 'LOD$2').replace(/^\w/, (c) => c.toUpperCase());

export interface CandidateConfig { file: string; replaces: string; category: string; label: string; state: string; source: string }

export function buildCatalogue(manifest: Manifest, refs: ReferenceConfig, layout: DimensionLayout | null, islands: ReadonlyArray<{ id: string }>, candidates: Record<string, CandidateConfig> = {}): Entry[] {
  const entries: Entry[] = [];
  const candidateEntries = Object.entries(candidates).filter(([id]) => !id.startsWith('_'));
  // Candidates under visual review: real GLBs, never approved, never used by the dimension.
  for (const [id, c] of Object.entries(candidates)) {
    if (id.startsWith('_')) continue;
    entries.push({ id, label: c.label, group: 'Candidates (under review)', kind: 'glb', refCategory: c.category, file: c.file, status: 'candidate',
      note: `Candidate for ${c.replaces}. ${c.state} Source: ${c.source}. Not approved.` });
  }
  for (const spec of Object.values(ASSETS)) {
    const m = manifest[spec.id];
    const lodOf = Object.values(ASSETS).find((s) => s.lods?.includes(spec.id));
    entries.push({
      id: spec.id, label: pretty(spec.id), group: GROUP_OF[spec.category] ?? 'Unregistered models', kind: 'glb', refCategory: spec.category, spec, manifest: m,
      file: m?.file ?? spec.file,
      status: !m ? 'missing' : APPROVED[spec.id] ? 'approved' : 'wip',
      note: !m ? 'Registered but no exported GLB in manifest.json' : APPROVED[spec.id] ?? (lodOf ? `Lower-detail version of the approved ${lodOf.id}; not separately approved` : 'Procedurally modelled GLB (assets-src/library); work in progress, not yet approved'),
    });
  }
  for (const [id, m] of Object.entries(manifest)) {
    if (ASSETS[id]) continue;
    entries.push({ id, label: pretty(id), group: 'Unregistered models', kind: 'glb', refCategory: 'other', manifest: m, file: m.file, status: 'unregistered', note: 'In manifest.json but not in the scale registry' });
  }
  if (layout) {
    for (const f of layout.formations) {
      entries.push({ id: `formation:${f.id}`, label: pretty(f.id), group: 'Microbot formations', kind: 'formation', refCategory: 'formation', formation: f, status: 'layout',
        note: `${f.units.length} microbots (${f.kind}) exactly as placed in the dimension; formations are not separately approved` });
    }
    const clusters = new Map<string, DebrisInstance[]>();
    for (const d of layout.debris) {
      const key = d.cluster.startsWith('vortex-') ? 'vortex-spiral' : d.cluster;
      clusters.set(key, [...(clusters.get(key) ?? []), d]);
    }
    for (const [id, list] of clusters) {
      entries.push({ id: `cluster:${id}`, label: pretty(id), group: 'Debris clusters', kind: 'cluster', refCategory: 'cluster', cluster: list, status: 'layout',
        note: `${list.length} pieces with their real placement, orientation and scale` });
    }
  }
  islands.forEach((island, index) => entries.push({ id: `island:${island.id}`, label: pretty(island.id), group: 'Island geology (procedural)', kind: 'terrain', refCategory: 'terrain', islandIndex: index, status: 'procedural',
    note: 'Generated live by src/scene/terrain (performance resolution); not a GLB' }));
  const glbs = entries.filter((e) => e.kind === 'glb' && e.manifest).map((e) => e.id);
  const pick = (cats: string[]) => entries.filter((e) => e.kind === 'glb' && e.manifest && e.spec && cats.includes(e.spec.category)).map((e) => e.id);
  entries.push(
    ...(candidateEntries.length ? [{ id: 'lineup:pilots', label: 'Pilots: old versus candidates (true scale)', group: 'True-scale lineups', kind: 'lineup' as const, refCategory: 'other', lineup: candidateEntries.flatMap(([id, c]) => [c.replaces, id]), status: 'layout' as const, note: 'Each old model is followed by its candidate; same scale, same lighting' }] : []),
    { id: 'lineup:all', label: 'Every model at true scale', group: 'True-scale lineups', kind: 'lineup', refCategory: 'other', lineup: glbs, status: 'layout', note: 'Side by side in metres; camera framing is independent of scale' },
    { id: 'lineup:small', label: 'Microbots, Baymax and small debris', group: 'True-scale lineups', kind: 'lineup', refCategory: 'other', lineup: [...pick(['microbot']), 'concrete_chunk_c', 'junction_box_broken', ...pick(['baymax'])].filter((id) => glbs.includes(id)), status: 'layout' },
    { id: 'lineup:structure', label: 'Structural debris and the capsule remnant', group: 'True-scale lineups', kind: 'lineup', refCategory: 'other', lineup: pick(['concrete', 'steel', 'scaffold', 'walkway', 'landmark']), status: 'layout' },
  );
  for (const p of refs.planned) {
    entries.push({ id: `planned:${p.label}`, label: p.label, group: 'Planned, missing & shader effects', kind: 'planned', refCategory: p.category,
      status: p.status === 'shader' ? 'shader' : p.status === 'not planned' ? 'notplanned' : 'missing', note: p.note ?? 'Seen on a reference sheet; no model exists yet' });
  }
  return entries;
}

export function referencesFor(entry: Entry, refs: ReferenceConfig, files: readonly string[]): Array<{ file: string; title: string }> {
  const out: Array<{ file: string; title: string }> = [];
  for (const file of files) {
    const sheet = refs.sheets.find((s) => file.includes(s.match));
    if (!sheet) out.push({ file, title: `Unmapped reference: ${file}` });
    else if (sheet.categories.includes(entry.refCategory)) out.push({ file, title: sheet.title });
  }
  return out;
}
