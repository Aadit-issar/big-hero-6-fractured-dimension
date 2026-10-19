import { chromium } from '@playwright/test';
import { mkdirSync } from 'node:fs';

// Paused A/B capture of one viewpoint with and without a `?disable=` layer, to
// isolate a single rendering feature (e.g. gas shears). The simulation is paused
// and reset to model time 0, so both frames see the same simulation state.
// Usage: node scripts/capture-ab.mjs <url> <outDir> <viewKey e.g. s6|3> <layer> [quality] [width] [height]
const [url = 'http://127.0.0.1:4173', out = 'test-results/ab', view = 's6', layer = 'shears', quality = 'balanced', width = '1440', height = '900'] = process.argv.slice(2);
mkdirSync(out, { recursive: true });
const browser = await chromium.launch({ channel: 'chrome', headless: true, args: ['--use-angle=d3d11', '--enable-gpu-rasterization', '--ignore-gpu-blocklist'] });
try {
  for (const [name, extra] of [['with', ''], ['without', `&disable=${layer}`]]) {
    const page = await browser.newPage({ viewport: { width: Number(width), height: Number(height) }, deviceScaleFactor: 1 });
    await page.goto(`${url}/?quality=${quality}&hud=1${extra}`);
    await page.waitForSelector('[data-render-ready="true"]', { timeout: 90_000 });
    await page.click('[data-testid="play-pause"]');
    await page.click('[data-testid="reset-simulation"]');
    const time = await page.evaluate(() => window.__FRACTURED_DIAGNOSTICS__?.read().time);
    // Clicked controls keep focus and swallow keys; return focus to the page.
    await page.evaluate(() => (document.activeElement instanceof HTMLElement) && document.activeElement.blur());
    await page.waitForTimeout(300);
    await page.keyboard.press('KeyH');
    await page.keyboard.press(view.startsWith('s') ? `Shift+Digit${view.slice(1)}` : `Digit${view}`);
    await page.waitForTimeout(1500);
    await page.screenshot({ path: `${out}/${view}-${name}-${layer}.png` });
    console.log(name, 'paused at model time', time);
    await page.close();
  }
} finally { await browser.close(); }
