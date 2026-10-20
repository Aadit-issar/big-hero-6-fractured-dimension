// Physics-overhaul captures. Usage: node scripts/physics-shots.mjs <url> <outDir> <name> <keys e.g. KeyW:3000,Space:500> [frames=1] [gapMs=2000] [WxH=1920x1080] [query]
import { chromium } from '@playwright/test';
import { mkdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
const [url = 'http://127.0.0.1:4210/', out = 'docs/evidence/overhaul/physics', name = 'shot', keys = '', frames = '1', gap = '2000', size = '1920x1080', query = '?quality=balanced&hud=0'] = process.argv.slice(2);
const [w, h] = size.split('x').map(Number);
await mkdir(out, { recursive: true });
const browser = await chromium.launch({ channel: 'chrome', headless: true, args: ['--use-angle=d3d11', '--ignore-gpu-blocklist', '--enable-gpu-rasterization'] });
try {
  const page = await (await browser.newContext({ viewport: { width: w, height: h } })).newPage();
  const errors = []; page.on('pageerror', e => errors.push(e.message)); page.on('console', m => { if (m.type() === 'error') errors.push(m.text()); });
  await page.goto(url + query);
  await page.waitForSelector('[data-render-ready="true"]', { timeout: 120000 });
  await page.waitForTimeout(2500);
  for (const [key, ms] of keys.split(',').filter(Boolean).map(x => x.split(':'))) { await page.keyboard.down(key); await page.waitForTimeout(Number(ms)); await page.keyboard.up(key); }
  await page.waitForTimeout(600);
  for (let i = 0; i < Number(frames); i += 1) {
    await page.screenshot({ path: join(out, `${name}${Number(frames) > 1 ? '-' + i : ''}.png`) });
    if (i < Number(frames) - 1) await page.waitForTimeout(Number(gap));
  }
  const d = await page.evaluate(() => window.__FRACTURED_DIAGNOSTICS__?.read());
  await writeFile(join(out, `${name}.json`), JSON.stringify({ camera: d?.cameraPosition, time: d?.time, movers: d?.movers?.map(m => [m.id, m.position.map(x => +x.toFixed(1))]) }, null, 1));
  console.log(errors.join('\n') || 'no page errors', JSON.stringify(d?.cameraPosition));
} finally { await browser.close(); }
