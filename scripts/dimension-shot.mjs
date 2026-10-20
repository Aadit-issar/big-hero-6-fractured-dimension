// Screenshots the Dimension (optionally in Baymax view) after a short scripted flight. Usage:
//   node scripts/dimension-shot.mjs <url> <outDir> [name] [keysToHoldMs e.g. KeyW:2500,Space:800]
import { chromium } from '@playwright/test';
import { mkdir } from 'node:fs/promises';
import { join } from 'node:path';

const url = process.argv[2] ?? 'http://127.0.0.1:4183/?quality=performance&view=baymax';
const out = process.argv[3] ?? 'docs/evidence/dimension-shots';
const name = process.argv[4] ?? 'dimension';
const plan = (process.argv[5] ?? '').split(',').filter(Boolean).map(x => x.split(':'));
await mkdir(out, { recursive: true });
const browser = await chromium.launch({ channel: 'chrome', headless: true, args: ['--use-angle=d3d11', '--ignore-gpu-blocklist', '--enable-gpu-rasterization'] });
const page = await (await browser.newContext({ viewport: { width: 1280, height: 720 } })).newPage();
const errors = [];
page.on('pageerror', e => errors.push(e.message));
await page.goto(url);
await page.waitForFunction(() => !!window.__FRACTURED_DIAGNOSTICS__, null, { timeout: 120000 });
await page.waitForFunction(() => document.querySelector('[data-render-ready="true"]'), null, { timeout: 120000 }).catch(() => undefined);
await page.waitForTimeout(2500);
for (const [key, ms] of plan) { await page.keyboard.down(key); await page.waitForTimeout(Number(ms)); await page.keyboard.up(key); }
await page.waitForTimeout(800);
await page.screenshot({ path: join(out, `${name}.png`) });
console.log(errors.join('\n') || 'no page errors');
await browser.close();
