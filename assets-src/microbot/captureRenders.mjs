import { chromium } from '@playwright/test';
import { mkdirSync } from 'node:fs';

// Studio renders of the exported GLB through the standalone viewer.
// Usage: node assets-src/microbot/captureRenders.mjs [viewerUrl] [outDir]
const [url = 'http://127.0.0.1:4190', out = 'docs/evidence/microbot'] = process.argv.slice(2);
mkdirSync(out, { recursive: true });
const shots = [
  ['01-hero-three-quarter', 'hero', 'material'],
  ['02-front', 'front', 'material'],
  ['03-side-end-on', 'side', 'material'],
  ['04-top', 'top', 'material'],
  ['05-rear', 'rear', 'material'],
  ['06-opposite-three-quarter', 'hero2', 'material'],
  ['07-joint-closeup', 'joint', 'material'],
  ['08-clay-three-quarter', 'hero', 'clay'],
  ['09-wireframe-three-quarter', 'hero', 'wire'],
  ['10-reference-angle', 'refmatch', 'material'],
];
const browser = await chromium.launch({ channel: 'chrome', headless: true });
const errors = [];
try {
  const page = await browser.newPage({ viewport: { width: 1600, height: 900 }, deviceScaleFactor: 1 });
  page.on('pageerror', (e) => errors.push(e.message));
  page.on('console', (m) => { if (m.type() === 'error') errors.push(m.text()); });
  await page.goto(`${url}/?capture=1`);
  await page.waitForFunction(() => window.__viewer && 'ready' in window.__viewer, null, { timeout: 30_000 });
  const viewer = await page.evaluate(() => ({ ready: window.__viewer.ready, stats: window.__viewer.stats, error: window.__viewer.error }));
  if (!viewer.ready) throw new Error(`Viewer failed: ${viewer.error}`);
  for (const [name, view, mode] of shots) {
    await page.evaluate(([v, m]) => { window.__viewer.setView(v); window.__viewer.setMode(m); }, [view, mode]);
    await page.waitForTimeout(700);
    await page.screenshot({ path: `${out}/${name}.png` });
  }
  console.log(JSON.stringify({ stats: viewer.stats, errors }));
} finally { await browser.close(); }
