// node assets-src/workflows/baymax/contact_sheet.mjs  (from the repo root; captures must exist in docs/evidence/parallel-assets/baymax/views)
import { chromium } from '@playwright/test';
import { readFileSync, writeFileSync } from 'node:fs';
const V = 'docs/evidence/parallel-assets/baymax/views/';
const uri = (p) => `data:image/png;base64,${readFileSync(p).toString('base64')}`;
const cell = (p, cap, w = 440) => `<figure style="margin:0"><img src="${uri(p)}" style="width:${w}px;display:block"><figcaption>${cap}</figcaption></figure>`;
const ref = 'Design/Object Designs/ChatGPT Image Oct 17, 2026, 10_46_34 PM.png';
const ids = ['shoulder_shell', 'forearm_shell', 'chest_armor', 'joint_shell', 'plating_shard'];
const g = (n, mode, view) => V + `baymax_${n}.glb-${mode}-${view}.png`;
const html = `<body style="margin:0;background:#1b1d22;color:#ccd;font:13px sans-serif;padding:14px;width:1900px">
<h2 style="margin:0 0 10px">Baymax armour family: reference, old placeholders, new candidates</h2>
<div style="display:flex;gap:10px;align-items:flex-start">
 <figure style="margin:0"><img src="${uri(ref)}" style="width:700px"><figcaption>Reference board</figcaption></figure>
 ${cell(V + 'baymax_shoulder_fragment.glb-material-hero.png', 'old baymax_shoulder_fragment', 380)}
 ${cell(V + 'baymax_forearm_fragment.glb-material-hero.png', 'old baymax_forearm_fragment', 380)}
</div>
<h3>Material, three-quarter, and opposite</h3>
<div style="display:flex;flex-wrap:wrap;gap:10px">
${ids.map((n) => cell(g(n, 'material', 'hero'), n) + cell(g(n, 'material', 'hero2'), n + ' (opposite)')).join('')}
</div>
<h3>Clay</h3>
<div style="display:flex;flex-wrap:wrap;gap:10px">
${ids.map((n) => cell(g(n, 'clay', 'hero'), 'clay ' + n, 360)).join('')}
</div>
<h3>Front and side (material)</h3>
<div style="display:flex;flex-wrap:wrap;gap:10px">
${ids.slice(0, 4).map((n) => cell(g(n, 'material', 'front'), 'front ' + n, 360) + cell(g(n, 'material', 'side'), 'side ' + n, 360)).join('')}
</div>
<h3>Close-ups</h3>
<div style="display:flex;flex-wrap:wrap;gap:10px">
${['shoulder_shell-material-close', 'chest_armor-material-close', 'forearm_shell-material-close'].map((n) => cell(V + `baymax_${n.split('-')[0]}.glb-material-close.png`, n.split('-')[0] + ' close-up', 600)).join('')}
</div></body>`;
const b = await chromium.launch({ channel: 'chrome', headless: true });
const p = await b.newPage({ viewport: { width: 1928, height: 1200 } });
await p.setContent(html);
await p.waitForTimeout(1000);
await p.screenshot({ path: 'docs/evidence/parallel-assets/baymax/contact-sheet.png', fullPage: true });
await b.close();
