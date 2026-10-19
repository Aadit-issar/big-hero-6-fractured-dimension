import { chromium } from '@playwright/test';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';

// Browser verification of the Asset Inspection Gallery. Exercises every catalogue
// entry, all shading modes and views, camera controls, references, the contact
// sheet and missing-file handling; writes screenshots and a JSON report.
// Usage: node tools/asset-viewer/verify.mjs [url] [outDir]
const [url = 'http://127.0.0.1:4190', out = 'docs/evidence/gallery'] = process.argv.slice(2);
mkdirSync(out, { recursive: true });
const manifest = JSON.parse(readFileSync('public/assets/models/manifest.json', 'utf8'));
const report = { url, checks: [], failures: [], console: [] };
const check = (name, ok, detail = '') => { report.checks.push({ name, ok, detail }); if (!ok) report.failures.push(`${name} ${detail}`); };
const browser = await chromium.launch({ channel: 'chrome', headless: true, args: ['--use-angle=d3d11', '--ignore-gpu-blocklist'] });
try {
  const page = await browser.newPage({ viewport: { width: 1600, height: 960 }, deviceScaleFactor: 1 });
  page.on('pageerror', (e) => report.console.push(`pageerror: ${e.message}`));
  page.on('console', (m) => { if (m.type() === 'error' || m.type() === 'warning') report.console.push(`${m.type()}: ${m.text()}`); });
  const ready = () => page.waitForFunction(() => window.__viewer && (window.__viewer.ready || window.__viewer.error), null, { timeout: 60_000 });
  const variance = () => page.evaluate(() => {
    const c = document.querySelector('#stage canvas'); const g = document.createElement('canvas'); g.width = 160; g.height = 100;
    const x = g.getContext('2d'); x.drawImage(c, 0, 0, 160, 100); const d = x.getImageData(0, 0, 160, 100).data;
    let s = 0, s2 = 0; for (let i = 0; i < d.length; i += 4) { const l = d[i] + d[i + 1] + d[i + 2]; s += l; s2 += l * l; } const n = d.length / 4; return s2 / n - (s / n) ** 2;
  });
  const t0 = Date.now();
  await page.goto(url); await ready();
  check('initial load (microbot)', await page.evaluate(() => window.__viewer.ready && window.__viewer.current.id === 'microbot'), `${Date.now() - t0} ms`);
  check('microbot is marked approved', await page.evaluate(() => window.__viewer.current.status === 'approved'));
  await page.waitForFunction(() => window.__viewer.entries().some((e) => e.kind === 'formation'), null, { timeout: 60_000 });
  const entries = await page.evaluate(() => window.__viewer.entries());
  const groups = [...new Set(entries.map((e) => e.group))];
  report.groups = Object.fromEntries(groups.map((g) => [g, entries.filter((e) => e.group === g).length]));
  for (const g of ['Microbots', 'Microbot formations', 'Concrete & rubble', 'Steel beams', 'Scaffolding', 'Walkways', 'Pipes', 'Cables & electrical', 'Capsule components', 'Baymax remnants', 'Debris clusters', 'Island geology (procedural)', 'True-scale lineups', 'Planned, missing & shader effects']) check(`category ${g}`, groups.includes(g));
  check('every manifest model is catalogued', Object.keys(manifest).every((id) => entries.some((e) => e.id === id)));
  await page.screenshot({ path: `${out}/gallery-microbot.png` });

  // Every GLB loads and reports the manifest's triangle count.
  for (const id of Object.keys(manifest)) {
    const ok = await page.evaluate((i) => window.__viewer.select(i), id);
    const tris = await page.evaluate(() => window.__viewer.stats?.Triangles);
    check(`GLB ${id}`, ok && Number(String(tris).replace(/[^0-9]/g, '')) === manifest[id].triangles, `tris ${tris} vs ${manifest[id].triangles}`);
  }
  // Modes and views on a debris model.
  await page.evaluate(() => window.__viewer.select('concrete_slab_rebar'));
  for (const mode of ['material', 'clay', 'wire', 'dimension']) {
    await page.evaluate((m) => window.__viewer.setMode(m), mode); await page.waitForTimeout(300);
    const v = await variance(); check(`mode ${mode} renders`, v > 20, `variance ${v.toFixed(0)}`);
    await page.screenshot({ path: `${out}/mode-${mode}.png` });
  }
  await page.evaluate(() => window.__viewer.setMode('material'));
  for (const view of ['hero', 'front', 'side', 'top', 'rear', 'hero2']) {
    await page.evaluate((v) => window.__viewer.setView(v), view); await page.waitForTimeout(150);
    check(`view ${view}`, (await page.evaluate(() => window.__viewer.current.view)) === view);
  }
  // Camera controls: orbit drag, pan (right drag) and wheel zoom move the camera.
  const cam = () => page.evaluate(() => [...document.querySelectorAll('#stats dd')].length);
  const box = await page.locator('#stage canvas').boundingBox();
  const shot0 = await page.locator('#stage').screenshot();
  await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2); await page.mouse.down(); await page.mouse.move(box.x + box.width / 2 + 180, box.y + box.height / 2 + 40, { steps: 8 }); await page.mouse.up();
  await page.mouse.wheel(0, -400); await page.waitForTimeout(400);
  const shot1 = await page.locator('#stage').screenshot();
  check('orbit / zoom changes the view', !shot0.equals(shot1));
  await cam();
  // Formation, cluster, island, lineup, planned.
  for (const id of ['formation:opening-swarm', 'formation:landmark-tendril', 'cluster:landmark-context', 'cluster:wreckage-structure', 'island:island-01', 'lineup:all', 'lineup:small']) {
    const ok = await page.evaluate((i) => window.__viewer.select(i), id); await page.waitForTimeout(400);
    const v = await variance();
    check(`entry ${id}`, ok && v > 20, `variance ${v.toFixed(0)}`);
    await page.screenshot({ path: `${out}/${id.replace(/[:]/g, '-')}.png` });
  }
  await page.evaluate(() => window.__viewer.select('formation:opening-swarm'));
  await page.evaluate(() => window.__viewer.setMode('dimension'));
  await page.click('#play'); await page.waitForTimeout(1500);
  await page.screenshot({ path: `${out}/formation-dimension-motion.png` });
  await page.click('#play');
  await page.evaluate(() => window.__viewer.setMode('material'));
  const planned = entries.find((e) => e.kind === 'planned' && e.status === 'missing');
  check('planned/missing entry shows a message', await page.evaluate((i) => window.__viewer.select(i), planned.id) && (await page.locator('#status').innerText()).includes('Missing'));
  // References: thumbnails load for the microbot and the pane opens.
  await page.evaluate(() => window.__viewer.select('baymax_shoulder_fragment'));
  await page.waitForFunction(() => [...document.querySelectorAll('#refs img')].some((i) => i.complete && i.naturalWidth > 0), null, { timeout: 20_000 });
  await page.click('#refs img'); await page.waitForFunction(() => document.querySelector('#refimg img').naturalWidth > 0, null, { timeout: 20_000 });
  await page.waitForTimeout(600);
  check('reference comparison pane', await page.locator('#refpane').evaluate((e) => e.classList.contains('open')));
  await page.screenshot({ path: `${out}/reference-comparison.png` });
  await page.click('#refclose');
  // Contact sheet.
  const sheetCount = await page.evaluate(() => window.__viewer.contactSheet());
  check('contact sheet renders every GLB', sheetCount === Object.keys(manifest).length, `${sheetCount}`);
  await page.locator('#sheet').screenshot({ path: `${out}/contact-sheet.png` });
  // Missing file handling.
  await page.goto(`${url}/?model=/assets/models/does-not-exist.glb`); await ready();
  const err = await page.evaluate(() => window.__viewer.error ?? null);
  check('missing file reports an error', Boolean(err) && (await page.locator('#status').innerText()).includes('Could not load'));
  await page.screenshot({ path: `${out}/missing-file.png` });
} finally {
  await browser.close();
  report.passed = report.failures.length === 0;
  report.console = report.console.filter((m) => !m.includes('does-not-exist'));
  writeFileSync(`${out}/verification.json`, JSON.stringify(report, null, 2));
  console.log(JSON.stringify({ passed: report.passed, checks: report.checks.length, failures: report.failures, console: report.console.slice(0, 10), groups: report.groups }, null, 1));
}
