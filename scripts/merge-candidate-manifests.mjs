// Merges per-family candidate manifests into public/assets/models/candidates/manifest.json (the gallery's source).
import { readFileSync, writeFileSync, readdirSync, statSync } from 'node:fs';
const dir = 'public/assets/models/candidates';
const main = JSON.parse(readFileSync(`${dir}/manifest.json`, 'utf8'));
let added = 0;
for (const fam of readdirSync(dir).filter((d) => statSync(`${dir}/${d}`).isDirectory())) {
  const m = JSON.parse(readFileSync(`${dir}/${fam}/manifest.json`, 'utf8'));
  for (const [id, c] of Object.entries(m)) {
    if (id.startsWith('_')) continue;
    const { file, replaces, category, label, state, source, triangles, bytes, bounds_m, lods } = c;
    main[id] = { file, replaces, category, label, state: `${state} Not approved.`, source, family: fam, triangles, bytes, bounds_m, lods };
    added++;
  }
}
writeFileSync(`${dir}/manifest.json`, JSON.stringify(main, null, 2) + '\n');
console.log('merged', added, 'candidates; total', Object.keys(main).length - 1);
