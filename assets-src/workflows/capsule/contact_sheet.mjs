// node assets-src/workflows/capsule/contact_sheet.mjs  (repo root; needs docs/evidence/parallel-assets/capsule/v2 captures)
import { chromium } from '@playwright/test';
import { readFileSync } from 'node:fs';
const D = 'docs/evidence/parallel-assets/capsule/';
const V = D + 'v2/';
const uri = (p) => `data:image/png;base64,${readFileSync(p).toString('base64')}`;
const cell = (p, cap, w = 460) => `<figure style="margin:0"><img src="${uri(p)}" style="width:${w}px;display:block"><figcaption>${cap}</figcaption></figure>`;
const concept = 'Design/Object Designs/ChatGPT Image Oct 17, 2026, 10_46_31 PM.png';
const h = (n) => V + 'capsule_shell_remnant' + n;
const html = `<body style="margin:0;background:#1b1d22;color:#ccd;font:13px sans-serif;padding:14px;width:1920px">
<h2 style="margin:0 0 10px">Capsule family v2: concept | v1 | v2 hero</h2>
<div style="display:flex;gap:10px;align-items:flex-start">
 ${cell(concept, 'Concept board (source of truth)', 700)}
 ${cell(D + 'views/capsule_shell_remnant.glb-material-hero.png', 'v1 hero (tall, narrow, clean)', 560)}
 ${cell(h('.glb-material-hero.png'), 'v2 hero: wide/low, charred heat shield (3.95 x 4.24 x 2.85 m)', 560)}
</div>
<h3>v2 hero: views, clay, breach close-ups, Dimension lighting</h3>
<div style="display:flex;gap:10px;flex-wrap:wrap">
 ${cell(h('.glb-material-front.png'), 'front: main window, side windows, camera port')}
 ${cell(h('.glb-material-rear.png'), 'rear: engine bay, three nozzles, housings')}
 ${cell(h('.glb-clay-hero.png'), 'clay hero')}
 ${cell(h('.glb-material-mid.png'), 'medium distance')}
 ${cell(h('.glb-material-breach.png'), 'breach: peeled skin, MLI blanket, isogrid wall, interior')}
 ${cell(h('.glb-clay-breach.png'), 'clay breach: real edge thickness, curled petals')}
 ${cell(h('.glb-dimension-hero.png'), 'Dimension lighting')}
 ${cell(h('.glb-dimension-breach.png'), 'Dimension lighting, breach')}
</div>
<h3>LODs: LOD0 102k | LOD1 18k | LOD2 4.5k (+ clay)</h3>
<div style="display:flex;gap:10px;flex-wrap:wrap">
 ${cell(h('.glb-material-hero.png'), 'LOD0', 460)}${cell(h('_lod1.glb-material-hero.png'), 'LOD1', 460)}${cell(h('_lod2.glb-material-hero.png'), 'LOD2', 460)}${cell(h('_lod2.glb-clay-hero.png'), 'LOD2 clay', 460)}
</div>
<h3>Rebuilt components (material | clay)</h3>
<div style="display:flex;gap:10px;flex-wrap:wrap">
${['collar_ring', 'heatshield_panel', 'upper_shell_fragment', 'impact_fragment'].map((n) => cell(V + 'capsule_' + n + '.glb-material-hero.png', 'capsule_' + n, 460) + cell(V + 'capsule_' + n + '.glb-clay-hero.png', 'clay', 460)).join('')}
</div>
<p>Kept from v1 (unchanged): capsule_rcs_thruster, capsule_antenna_broken, capsule_instrument_unit.</p></body>`;
const b = await chromium.launch({ channel: 'chrome', headless: true });
const p = await b.newPage({ viewport: { width: 1948, height: 1200 } });
await p.setContent(html);
await p.waitForTimeout(800);
await p.screenshot({ path: D + 'contact-sheet-v2.png', fullPage: true });
await b.close();
