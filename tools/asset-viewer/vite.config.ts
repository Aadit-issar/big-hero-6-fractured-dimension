import { defineConfig } from 'vite';
import type { Connect, Plugin } from 'vite';
import { createReadStream, existsSync, readdirSync, statSync } from 'node:fs';
import { extname, join, normalize } from 'node:path';
import { fileURLToPath } from 'node:url';

// Standalone Asset Inspection Gallery (not part of the playable app). Serves the
// project's public/ folder so it loads the exact exported GLB files, imports the
// real scene code from src/ (registry, placement, asset shader, terrain), and
// exposes Design/Object Designs/ read-only under /design-refs/. Port 4190 avoids
// the Dimension (4173/4174) and ATLAS (5173/5174) servers.
const root = fileURLToPath(new URL('.', import.meta.url));
const designDir = fileURLToPath(new URL('../../Design/Object Designs', import.meta.url));
const IMAGE_TYPES: Record<string, string> = { '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.webp': 'image/webp' };

const designRefs: Connect.NextHandleFunction = (req, res, next) => {
  const path = decodeURIComponent((req.url ?? '/').split('?')[0]!);
  if (path === '/' || path === '/index.json') {
    const files = existsSync(designDir) ? readdirSync(designDir).filter((f) => IMAGE_TYPES[extname(f).toLowerCase()]).sort() : [];
    res.setHeader('Content-Type', 'application/json');
    res.setHeader('Cache-Control', 'no-store');
    res.end(JSON.stringify(files.map((name) => ({ name, bytes: statSync(join(designDir, name)).size }))));
    return;
  }
  const file = normalize(join(designDir, path));
  const type = IMAGE_TYPES[extname(file).toLowerCase()];
  if (!file.startsWith(designDir) || !type || !existsSync(file)) { next(); return; }
  res.setHeader('Content-Type', type);
  createReadStream(file).pipe(res);
};
const designPlugin: Plugin = {
  name: 'design-refs',
  configureServer(server) { server.middlewares.use('/design-refs', designRefs); },
  configurePreviewServer(server) { server.middlewares.use('/design-refs', designRefs); },
};

export default defineConfig({
  root,
  publicDir: fileURLToPath(new URL('../../public', import.meta.url)),
  plugins: [designPlugin],
  server: { host: '127.0.0.1', port: 4190, strictPort: true, fs: { allow: [fileURLToPath(new URL('../..', import.meta.url))] } },
  preview: { host: '127.0.0.1', port: 4191, strictPort: true },
  build: { outDir: fileURLToPath(new URL('../../test-results/asset-viewer-dist', import.meta.url)), emptyOutDir: true },
});
