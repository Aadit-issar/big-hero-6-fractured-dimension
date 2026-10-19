import { chromium } from '@playwright/test';
import { mkdirSync } from 'node:fs';

// Close-up review captures of one gallery entry from explicit camera poses relative to the model bounds.
// Usage: node tools/asset-viewer/captureCloseups.mjs <outDir> <assetId> <mode> <name=dx,dy,dz,distFraction,tx,ty,tz ...>
//   direction (dx,dy,dz) from the target, distance = distFraction * bounds radius, target = centre + (tx,ty,tz) * radius.
const [out, id, mode = 'material', ...poses] = process.argv.slice(2);
mkdirSync(out, { recursive: true });
const browser = await chromium.launch({ channel: 'chrome', headless: true, args: ['--use-angle=d3d11', '--ignore-gpu-blocklist'] });
try {
  const page = await browser.newPage({ viewport: { width: 1100, height: 760 }, deviceScaleFactor: 1 });
  await page.goto(`http://127.0.0.1:4282/?capture=1&asset=${encodeURIComponent(id)}`);
  await page.waitForFunction(() => window.__viewer && (window.__viewer.ready || window.__viewer.error), null, { timeout: 90_000 });
  await page.evaluate((m) => window.__viewer.setMode(m), mode);
  const b = await page.evaluate(() => window.__viewer.bounds());
  for (const spec of poses) {
    const [name, v] = spec.split('=');
    const [dx, dy, dz, df, tx, ty, tz] = v.split(',').map(Number);
    const len = Math.hypot(dx, dy, dz);
    const target = [b.centre[0] + tx * b.radius, b.centre[1] + ty * b.radius, b.centre[2] + tz * b.radius];
    const pos = [target[0] + (dx / len) * df * b.radius, target[1] + (dy / len) * df * b.radius, target[2] + (dz / len) * df * b.radius];
    await page.evaluate(([p, t]) => window.__viewer.setCamera(p, t), [pos, target]);
    await page.waitForTimeout(450);
    await page.screenshot({ path: `${out}/${id.split('/').pop().replace(/[^a-zA-Z0-9_.-]/g, '-')}-${mode}-${name}.png` });
  }
  console.log(JSON.stringify({ bounds: b }));
} finally { await browser.close(); }
