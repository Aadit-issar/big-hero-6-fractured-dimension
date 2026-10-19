import { chromium } from '@playwright/test';
import { mkdirSync } from 'node:fs';

// Captures matched views of gallery entries (real GLBs) for review sheets.
// Usage: node tools/asset-viewer/captureViews.mjs <outDir> <ids,comma,separated> [url] [views] [modes] [WxH]
//   views default: hero,hero2,front,side,top,rear   modes default: material,clay
// Each shot hides the panels (capture=1) so only the model is framed.
const [out = 'test-results/views', ids = 'microbot', url = 'http://127.0.0.1:4190', views = 'hero,hero2,front,side,top,rear', modes = 'material,clay', size = '1000x700'] = process.argv.slice(2);
const [w, h] = size.split('x').map(Number);
mkdirSync(out, { recursive: true });
const browser = await chromium.launch({ channel: 'chrome', headless: true, args: ['--use-angle=d3d11', '--ignore-gpu-blocklist'] });
const errors = [];
try {
  const page = await browser.newPage({ viewport: { width: w, height: h }, deviceScaleFactor: 1 });
  page.on('pageerror', (e) => errors.push(e.message));
  for (const id of ids.split(',')) {
    await page.goto(`${url}/?capture=1&asset=${encodeURIComponent(id)}`);
    await page.waitForFunction(() => window.__viewer && (window.__viewer.ready || window.__viewer.error), null, { timeout: 90_000 });
    const ready = await page.evaluate(() => window.__viewer.ready);
    if (!ready) { errors.push(`${id}: not ready`); continue; }
    for (const mode of modes.split(',')) {
      await page.evaluate((m) => window.__viewer.setMode(m), mode);
      for (const view of views.split(',')) {
        await page.evaluate((v) => window.__viewer.setView(v), view);
        await page.waitForTimeout(350);
        await page.screenshot({ path: `${out}/${id.split('/').pop().replace(/[^a-zA-Z0-9_.-]/g, '-')}-${mode}-${view}.png` });
      }
    }
  }
  console.log(JSON.stringify({ captured: ids.split(',').length, errors }));
} finally { await browser.close(); }
