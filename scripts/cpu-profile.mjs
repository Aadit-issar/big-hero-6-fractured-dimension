import { chromium } from '@playwright/test';
import { writeFileSync } from 'node:fs';

// Main-thread CPU profile (Chrome DevTools Protocol sampling profiler) of the running
// dimension: prints the top functions by self time and by inclusive time.
// Usage: node scripts/cpu-profile.mjs <url> [seconds] [query] [out.cpuprofile]
const [url = 'http://127.0.0.1:4174', seconds = '4', query = '/?quality=balanced&hud=0', out = 'test-results/dimension.cpuprofile'] = process.argv.slice(2);
const browser = await chromium.launch({ channel: 'chrome', headless: true, args: ['--use-angle=d3d11', '--enable-gpu-rasterization', '--ignore-gpu-blocklist'] });
try {
  const page = await browser.newPage({ viewport: { width: 1440, height: 900 }, deviceScaleFactor: 1 });
  await page.goto(`${url}${query}`);
  await page.waitForSelector('[data-render-ready="true"]', { timeout: 180_000 });
  await page.waitForTimeout(3000);
  const cdp = await page.context().newCDPSession(page);
  await cdp.send('Profiler.enable');
  await cdp.send('Profiler.setSamplingInterval', { interval: 200 });
  await cdp.send('Profiler.start');
  await page.waitForTimeout(Number(seconds) * 1000);
  const { profile } = await cdp.send('Profiler.stop');
  writeFileSync(out, JSON.stringify(profile));
  const byId = new Map(profile.nodes.map((n) => [n.id, n]));
  const parent = new Map(); for (const n of profile.nodes) for (const c of n.children ?? []) parent.set(c, n.id);
  const self = new Map(); const total = new Map();
  const dt = profile.timeDeltas; let ms = 0;
  profile.samples.forEach((id, i) => {
    const d = (dt[i] ?? 0) / 1000; ms += d;
    const n = byId.get(id); const key = (x) => `${x.callFrame.functionName || '(anon)'} ${x.callFrame.url.split('/').pop()}:${x.callFrame.lineNumber}`;
    self.set(key(n), (self.get(key(n)) ?? 0) + d);
    const seen = new Set(); let cur = id;
    while (cur !== undefined) { const k = key(byId.get(cur)); if (!seen.has(k)) { total.set(k, (total.get(k) ?? 0) + d); seen.add(k); } cur = parent.get(cur); }
  });
  const top = (m) => [...m.entries()].sort((a, b) => b[1] - a[1]).slice(0, 22).map(([k, v]) => `${v.toFixed(0).padStart(6)} ms  ${k}`).join('\n');
  console.log(`profiled ${ms.toFixed(0)} ms\n--- self ---\n${top(self)}\n--- inclusive ---\n${top(total)}`);
} finally { await browser.close(); }
