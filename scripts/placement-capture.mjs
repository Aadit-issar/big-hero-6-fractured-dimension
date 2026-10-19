import { chromium } from '@playwright/test';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';

// Placement evidence: the 1–9 viewpoints, the Shift+1–9 asset views and fixed
// free-flight poses that sample distinct regions of the explorable space. The
// simulation is paused and reset to model time 0 so before/after frames see the
// same state. Writes <out>/<name>.png and <out>/counters.json (renderer counters).
// Usage: node scripts/placement-capture.mjs <url> <outDir> [quality] [width] [height] [only=comma list]
const [url = 'http://127.0.0.1:4291', out = 'docs/evidence/dimension-placement/after', quality = 'balanced', width = '1280', height = '720', only = ''] = process.argv.slice(2);
// Fixed world poses [position, target] (metres) from the camera test matrix. Identical before and after.
export const POSES = Object.fromEntries(Object.entries(JSON.parse(readFileSync(new URL('./placement-matrix.json', import.meta.url), 'utf8')).poses).map(([n, p]) => [n, [p.position, p.target]]));
const keys = ['1', '2', '3', '4', '5', '6', '7', '8', '9', 's1', 's2', 's3', 's4', 's5', 's6', 's7', 's8', 's9'];
const wanted = only ? new Set(only.split(',')) : null;
mkdirSync(out, { recursive: true });
const browser = await chromium.launch({ channel: 'chrome', headless: true, args: ['--use-angle=d3d11', '--enable-gpu-rasterization', '--ignore-gpu-blocklist'] });
const counters = {};
try {
  const page = await browser.newPage({ viewport: { width: Number(width), height: Number(height) }, deviceScaleFactor: 1 });
  const errors = []; page.on('pageerror', (e) => errors.push(e.message)); page.on('console', (m) => { if (m.type() === 'error') errors.push(m.text()); });
  const t0 = Date.now();
  await page.goto(`${url}/?quality=${quality}&hud=1&probe=1${process.env.CAPTURE_QUERY ? `&${process.env.CAPTURE_QUERY}` : ""}`);
  await page.waitForSelector('[data-render-ready="true"]', { timeout: 180_000 });
  const readyMs = Date.now() - t0;
  await page.click('[data-testid="play-pause"]');
  await page.click('[data-testid="reset-simulation"]');
  await page.evaluate(() => (document.activeElement instanceof HTMLElement) && document.activeElement.blur());
  await page.keyboard.press('KeyH');
  await page.waitForTimeout(2500);
  const shots = [...keys.map((k) => [`view-${k}`, k]), ...Object.entries(POSES).map(([n, p]) => [n, p])];
  for (const [name, how] of shots) {
    if (wanted && !wanted.has(name)) continue;
    if (typeof how === 'string') await page.keyboard.press(how.startsWith('s') ? `Shift+Digit${how.slice(1)}` : `Digit${how}`);
    else await page.evaluate(([p, t]) => window.__FRACTURED_PLACEMENT__.frame(p, t), how);
    await page.waitForTimeout(1300);
    await page.screenshot({ path: `${out}/${name}.jpg`, type: 'jpeg', quality: 88 });
    counters[name] = await page.evaluate(() => ({ ...window.__FRACTURED_PLACEMENT__.counters(), perf: (({ drawCalls, triangles, textures, geometries, p50FrameMs, p95FrameMs }) => ({ drawCalls, triangles, textures, geometries, p50FrameMs, p95FrameMs }))(window.__FRACTURED_DIAGNOSTICS__.readPerformance()) }));
  }
  counters._meta = { quality, width, height, readyMs, errors };
  writeFileSync(`${out}/counters.json`, JSON.stringify(counters, null, 1));
  if (errors.length) console.log('console:', errors.join('\n'));
  console.log('ready in', readyMs, 'ms; captured', Object.keys(counters).length - 1);
} finally { await browser.close(); }
