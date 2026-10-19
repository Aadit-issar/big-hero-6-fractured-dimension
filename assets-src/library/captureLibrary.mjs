import { chromium } from '@playwright/test';
import { mkdirSync, readFileSync } from 'node:fs';

// Isolated studio renders of every manifest asset through tools/asset-viewer.
// Usage: node assets-src/library/captureLibrary.mjs [viewerUrl] [outDir] [ids,comma,separated]
const [url = 'http://127.0.0.1:4190', out = 'docs/evidence/assets', only = ''] = process.argv.slice(2);
mkdirSync(out, { recursive: true });
const manifest = JSON.parse(readFileSync('public/assets/models/manifest.json', 'utf8'));
const ids = only ? only.split(',') : Object.keys(manifest);
const browser = await chromium.launch({ channel: 'chrome', headless: true });
const errors = [];
try {
  const page = await browser.newPage({ viewport: { width: 1200, height: 800 }, deviceScaleFactor: 1 });
  page.on('pageerror', (e) => errors.push(e.message));
  page.on('console', (m) => { if (m.type() === 'error') errors.push(m.text()); });
  for (const id of ids) {
    await page.goto(`${url}/?capture=1&model=${encodeURIComponent(manifest[id].file)}`);
    await page.waitForFunction(() => window.__viewer && 'ready' in window.__viewer, null, { timeout: 30_000 });
    for (const [view, mode, suffix] of [['hero', 'material', 'hero'], ['hero2', 'material', 'opposite'], ['hero', 'clay', 'clay']]) {
      await page.evaluate(([v, m]) => { window.__viewer.setView(v); window.__viewer.setMode(m); }, [view, mode]);
      await page.waitForTimeout(350);
      await page.screenshot({ path: `${out}/${id}-${suffix}.png` });
    }
  }
  console.log(JSON.stringify({ captured: ids.length, errors }));
} finally { await browser.close(); }
