import { chromium } from '@playwright/test';
import { writeFileSync } from 'node:fs';

// Frame-pacing probe: rAF intervals plus main-thread long tasks (PerformanceObserver),
// so a stall can be attributed to JavaScript (long task overlaps it) or to the GPU /
// compositor (no long task). These are frame INTERVALS, not GPU timings.
// Usage: node scripts/frame-pacing.mjs <url> <out.json> [seconds] [query] [WxH] [motion=0|1]
const [url = 'http://127.0.0.1:4174', out = 'test-results/frame-pacing.json', seconds = '10', query = '/?quality=balanced&hud=0', size = '1440x900', motion = '0'] = process.argv.slice(2);
const [width, height] = size.split('x').map(Number);
const browser = await chromium.launch({ channel: 'chrome', headless: true, args: ['--use-angle=d3d11', '--enable-gpu-rasterization', '--ignore-gpu-blocklist'] });
try {
  const page = await browser.newPage({ viewport: { width, height }, deviceScaleFactor: 1 });
  const t0 = Date.now();
  await page.goto(`${url}${query}`);
  await page.waitForSelector('[data-render-ready="true"]', { timeout: 180_000 });
  const readyMs = Date.now() - t0;
  await page.waitForTimeout(3000);
  if (motion === '1') { await page.mouse.move(width / 2, height / 2); await page.keyboard.down('KeyW'); }
  const result = await page.evaluate(async (ms) => {
    const longTasks = [];
    const obs = new PerformanceObserver((l) => { for (const e of l.getEntries()) longTasks.push([e.startTime, e.duration]); });
    try { obs.observe({ type: 'longtask', buffered: false }); } catch { /* unsupported */ }
    const frames = [];
    await new Promise((resolve) => {
      let last = performance.now(); const end = last + ms;
      const tick = (t) => { frames.push([t, t - last]); last = t; if (t < end) requestAnimationFrame(tick); else resolve(); };
      requestAnimationFrame(tick);
    });
    obs.disconnect();
    return { frames, longTasks };
  }, Number(seconds) * 1000);
  if (motion === '1') await page.keyboard.up('KeyW');
  const d = result.frames.map((f) => f[1]).slice(1).sort((a, b) => a - b);
  const q = (p) => d[Math.min(d.length - 1, Math.floor(p * d.length))];
  const long = result.frames.filter((f) => f[1] > 50);
  const explained = long.filter(([t, dt]) => result.longTasks.some(([s, dur]) => s < t && s + dur > t - dt)).length;
  const summary = { query, size, readyMs, frames: d.length, avgFps: d.length / Number(seconds), p50: q(0.5), p95: q(0.95), p99: q(0.99), max: d[d.length - 1],
    over33: d.filter((x) => x > 33.4).length, over50: long.length, longFramesOverlappingLongTasks: explained, longTasks: result.longTasks.length,
    longTaskMs: Math.round(result.longTasks.reduce((s, l) => s + l[1], 0)), stallTimes: long.slice(0, 40).map(([t, dt]) => [Math.round(t), Math.round(dt)]) };
  writeFileSync(out, JSON.stringify(summary, null, 1));
  console.log(JSON.stringify({ ...summary, stallTimes: undefined }));
} finally { await browser.close(); }
