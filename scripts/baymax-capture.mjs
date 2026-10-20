import { chromium } from '@playwright/test';
import { spawn, execSync } from 'node:child_process';
import { mkdirSync } from 'node:fs';

// Captures deterministic armoured-Baymax stills from /baymax-preview.html (starts its own vite on 4190-4199 and kills it afterwards).
// Usage: node scripts/baymax-capture.mjs [outDir] [size] [list] [lod]
//   list = comma-separated name=view:state[:wings] (default: the standard evidence set); wings 0..1 forces deployment.
const [out = 'docs/evidence/baymax', size = '1000', list = '', lod = 'high'] = process.argv.slice(2);
const PORT = 4190 + Math.floor(Math.random() * 9);
const DEFAULT = [
  'front=front:hover:1', 'three-quarter=ref3:hover:1', 'side=side:hover:1', 'rear=rearthree:hover:1',
  'rear-thrusters=back:cruise', 'rear-folded=rearthree:hover:0', 'hover=three:hover', 'forward-flight=three:cruise',
  'forward-flight-side=side:cruise', 'turn=three:turn', 'brake=three:brake', 'climb=three:climb', 'boost=three:boost', 'boost-side=side:boost',
];
const jobs = (list ? list.split(',') : DEFAULT).map((j) => { const [name, spec] = j.split('='); const [view, state, wings] = spec.split(':'); return { name, view, state, wings }; });
mkdirSync(out, { recursive: true });

const server = spawn('npx', ['vite', '--port', String(PORT), '--strictPort', '--host', '127.0.0.1'], { shell: true, stdio: 'ignore' });
const kill = () => { try { execSync(`taskkill /pid ${server.pid} /T /F`, { stdio: 'ignore' }); } catch { /* already gone */ } };
process.on('exit', kill);
try {
  for (let i = 0; i < 80; i++) {
    try { if ((await fetch(`http://127.0.0.1:${PORT}/baymax-preview.html`)).ok) break; } catch { /* waiting */ }
    await new Promise((r) => setTimeout(r, 500));
  }
  const browser = await chromium.launch({ channel: 'chrome', headless: true, args: ['--use-angle=d3d11', '--enable-gpu-rasterization', '--ignore-gpu-blocklist'] });
  try {
    const page = await browser.newPage({ viewport: { width: Number(size), height: Number(size) }, deviceScaleFactor: 1 });
    const errors = [];
    page.on('pageerror', (e) => errors.push(e.message));
    page.on('console', (m) => { if (m.type() === 'error' || m.type() === 'warning') errors.push(m.text()); });
    for (const { name, view, state, wings } of jobs) {
      const q = `${name.startsWith('ghost') ? 'ghost=1&' : ''}view=${view}&state=${state ?? 'hover'}&lod=${lod}${wings === undefined ? '' : `&wings=${wings}`}`;
      await page.goto(`http://127.0.0.1:${PORT}/baymax-preview.html?${q}`);
      await page.waitForFunction('window.__baymaxReady === true', null, { timeout: 90_000 });
      await page.screenshot({ path: `${out}/${name}${lod === 'low' ? '-lod' : ''}.png` });
      console.log('saved', `${name}${lod === 'low' ? '-lod' : ''}.png`);
    }
    if (errors.length) console.log('console:', [...new Set(errors)].join('\n'));
  } finally { await browser.close(); }
} finally { kill(); }
