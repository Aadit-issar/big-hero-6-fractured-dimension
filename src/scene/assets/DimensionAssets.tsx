import { useMemo } from 'react';
import type { SimulationEngine } from '../../simulation/simulationEngine';
import type { AssetQuality } from '../../rendering/qualitySettings';
import type { AtmosphereUniforms } from '../terrain/rockMaterial';
import type { SurfaceMaps } from './assetMaterial';
import { textureStats, textureTierFor, useAssets } from './assetLoader';
import { ASSET_SIZES } from './assetSizes';
import { assetStats } from './assetStats';
import { DebrisField } from './DebrisField';
import { PlacementProbe } from './PlacementProbe';
import { MICROBOT_LOD_IDS, MicrobotSwarms } from './MicrobotSwarms';
import { layoutDimension, placementInputs } from './placement';
import type { DimensionLayout, PlacementInputs } from './placement';

const SIZES = Object.fromEntries(Object.entries(ASSET_SIZES).map(([id, a]) => [id, a.size]));

const inputsCache = new WeakMap<SimulationEngine, PlacementInputs>();
/** Read-only placement inputs (swept islands, folds, exits, hazard), computed once per engine. */
export function cachedPlacementInputs(engine: SimulationEngine): PlacementInputs {
  let inputs = inputsCache.get(engine);
  if (!inputs) { inputs = placementInputs(engine); inputsCache.set(engine, inputs); }
  return inputs;
}

/** The deterministic layout for an engine (seeded; independent of quality). */
export function dimensionLayout(engine: SimulationEngine): DimensionLayout {
  return layoutDimension(engine.seed, cachedPlacementInputs(engine), SIZES);
}

const layouts = new WeakMap<SimulationEngine, DimensionLayout>();
/** The layout is pure in the engine's seed and world, so it is computed once per engine. */
export function cachedLayout(engine: SimulationEngine): DimensionLayout {
  let layout = layouts.get(engine);
  if (!layout) { layout = dimensionLayout(engine); layouts.set(engine, layout); }
  return layout;
}

/** Physical objects in the dimension: wreckage, the landmark and microbot formations. */
export function DimensionAssets({ engine, quality, atmosphere, maps, debris = true, microbots = true }: {
  readonly engine: SimulationEngine; readonly quality: AssetQuality; readonly atmosphere: AtmosphereUniforms; readonly maps: SurfaceMaps;
  /** Profiling toggles (rendering only). */
  readonly debris?: boolean; readonly microbots?: boolean;
}) {
  const layout = useMemo(() => {
    const result = cachedLayout(engine);
    const regions: Record<string, number> = {};
    for (const d of result.debris) regions[d.region] = (regions[d.region] ?? 0) + 1;
    assetStats.debrisInstances = result.debris.length;
    assetStats.debrisTriangles = result.debris.reduce((sum, d) => sum + (ASSET_SIZES[d.asset]?.triangles ?? 0), 0);
    assetStats.textures = textureStats;
    assetStats.layout = {
      clusters: [...new Set(result.debris.map((d) => d.cluster))],
      formations: result.formations.map((f) => ({ id: f.id, kind: f.kind, units: f.units.length, centre: f.centre, radius: f.radius })),
      regions,
      rejected: result.rejected,
    };
    return result;
  }, [engine]);
  const tier = textureTierFor(quality.lodScale);
  const ids = useMemo(() => [...new Set([...MICROBOT_LOD_IDS, ...(debris ? layout.debris.map((d) => d.asset) : [])])].sort(), [layout, debris]);
  const assets = useAssets(ids, tier);
  return <>
    <PlacementProbe />
    {assets && debris && <DebrisField engine={engine} debris={layout.debris} assets={assets} atmosphere={atmosphere} maps={maps} lodScale={quality.lodScale} />}
    {assets && microbots && <MicrobotSwarms engine={engine} formations={layout.formations} assets={assets} atmosphere={atmosphere} quality={quality} />}
  </>;
}
