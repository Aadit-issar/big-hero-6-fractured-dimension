import { chromium } from '@playwright/test';
import { renameSync, readdirSync, mkdirSync } from 'node:fs';

// Real browser walkthrough recording (Playwright video, WebM) of the running app:
// opening view, flight, viewpoints, a fold approach and the vortex. No editing.
// Usage: node scripts/walkthrough.mjs [url] [outDir] [quality]
const [url = 'http://127.0.0.1:4174', out = 'docs/evidence/phase5-final/walkthrough', quality = 'performance'] = process.argv.slice(2);
mkdirSync(out, { recursive: true });
const browser = await chromium.launch({ channel: 'chrome', headless: true, args: ['--use-angle=d3d11', '--enable-gpu-rasterization', '--ignore-gpu-blocklist'] });
const context = await browser.newContext({ viewport: { width: 1280, height: 720 }, recordVideo: { dir: out, size: { width: 1280, height: 720 } } });
const page = await context.newPage();
await page.goto(`${url}/?quality=${quality}&hud=0`);
await page.waitForSelector('[data-render-ready="true"]', { timeout: 180_000 });
await page.locator('canvas').click({ position: { x: 640, y: 360 } });
const hold = async (key, ms) => { await page.keyboard.down(key); await page.waitForTimeout(ms); await page.keyboard.up(key); };
const look = async (dx, dy, steps = 40) => { await page.mouse.move(640, 360); await page.mouse.down(); await page.mouse.move(640 + dx, 360 + dy, { steps }); await page.mouse.up(); };
await page.waitForTimeout(2500);                 // opening view
await hold('KeyW', 3500);                        // fly forward into the chamber
await look(-260, 30);                            // turn toward the debris field
await hold('KeyW', 2000);
await page.keyboard.press('Shift+Digit3'); await page.waitForTimeout(3000); // capsule / wreck framing
await page.keyboard.press('Digit2'); await page.waitForTimeout(2500);       // island
await page.keyboard.press('Digit9'); await page.waitForTimeout(2500);       // rift close-up
await page.keyboard.press('KeyR'); await page.waitForTimeout(1200);         // reset view
await hold('KeyW', 4000);                        // approach the nearest real fold
await page.keyboard.press('Digit5'); await page.waitForTimeout(3500);       // vortex
await page.keyboard.press('Digit1'); await page.waitForTimeout(3000);       // closing wide
await context.close(); await browser.close();
const file = readdirSync(out).filter((f) => f.endsWith('.webm')).map((f) => `${out}/${f}`).at(-1);
if (file) renameSync(file, `${out}/dimension-walkthrough-${quality}.webm`);
console.log('saved', `${out}/dimension-walkthrough-${quality}.webm`);
