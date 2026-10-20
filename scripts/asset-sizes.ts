import { ASSET_SIZES } from '../src/scene/assets/assetSizes';
let total = 0;
for (const [id, a] of Object.entries(ASSET_SIZES)) {
  if (id.startsWith('microbot')) continue;
  const lowest = a.lods.length ? a.lods[a.lods.length - 1]! : a;
  const lod1 = a.lods.length ? a.lods[0]! : a;
  total += lod1.bytes;
  console.log(id.padEnd(32), 'base', (a.bytes / 1e6).toFixed(2), 'MB', 'tris', a.triangles, '| lod1', (lod1.bytes / 1e6).toFixed(2), 'MB', lod1.triangles, '| lowest', (lowest.bytes / 1e6).toFixed(2));
}
console.log('total lod1 MB', (total / 1e6).toFixed(1));
