import { DEBRIS_IDS, assetSpec } from '../src/scene/assets/assetRegistry';
import { textureBudget } from './placement-manifest';

// Debris texture budget per tier (deterministic; mirrors assetLoader's sharing rules).
// Usage: npx tsx scripts/placement-budget.ts
const specs = DEBRIS_IDS.map(assetSpec);
for (const tier of [0, 1, 2]) {
  const b = textureBudget(specs, tier);
  console.log(`tier ${tier}: ${b.images} distinct images, ${(b.gpuBytes / 2 ** 20).toFixed(0)} MB GPU (RGBA8 + mips), ${(b.downloadBytes / 2 ** 20).toFixed(0)} MB GLB download`);
}
