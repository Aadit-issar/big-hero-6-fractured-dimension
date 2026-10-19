import { chromium } from '@playwright/test';

// Resource-lifecycle check: renderer geometry/texture/program counts and JS heap
// after repeated quality switches, viewpoint jumps, pause/resume and resets.
// Stable counts across cycles indicate no growing GPU-resource leak (not a proof).
// Usage: node scripts/lifecycle-check.mjs [url] [cycles]
const [url = 'http://127.0.0.1:4174', cycles = '3'] = process.argv.slice(2);
const browser = await chromium.launch({ channel: 'chrome', headless: true, args: ['--use-angle=d3d11', '--enable-gpu-rasterization', '--ignore-gpu-blocklist', '--js-flags=--expose-gc'] });
try {
  const page = await browser.newPage({ viewport: { width: 1280, height: 720 } });
  const errors = []; page.on('pageerror', (e) => errors.push(e.message)); page.on('console', (m) => { if (m.type() === 'error') errors.push(m.text()); });
  await page.goto(`${url}/?quality=balanced`);
  await page.waitForSelector('[data-render-ready="true"]', { timeout: 180_000 });
  const counts = async () => page.evaluate(() => { (globalThis.gc ?? (() => {}))(); const p = window.__FRACTURED_DIAGNOSTICS__.readPerformance(); return { geometries: p.geometries, textures: p.textures, programs: p.programs ?? null, heapMB: Math.round((performance.memory?.usedJSHeapSize ?? 0) / 2 ** 20) }; });
  const ready = () => page.waitForSelector('[data-render-ready="true"]', { timeout: 180_000 });
  const rows = [['start', await counts()]];
  for (let c = 0; c < Number(cycles); c += 1) {
    for (const q of ['performance', 'cinematic', 'balanced']) { await page.getByTestId(`quality-${q}`).click(); await ready(); await page.waitForTimeout(1500); }
    await page.locator('canvas').click({ position: { x: 640, y: 360 } });
    for (const k of ['Digit1', 'Digit4', 'Digit7', 'Shift+Digit3', 'KeyR']) { await page.keyboard.press(k); await page.waitForTimeout(400); }
    await page.getByTestId('play-pause').click(); await page.waitForTimeout(300); await page.getByTestId('play-pause').click();
    await page.getByTestId('reset-simulation').click(); await page.waitForTimeout(1500);
    rows.push([`cycle ${c + 1}`, await counts()]);
  }
  for (const [name, r] of rows) console.log(name.padEnd(8), JSON.stringify(r));
  console.log('errors:', errors.length ? errors.slice(0, 5) : 'none');
} finally { await browser.close(); }
