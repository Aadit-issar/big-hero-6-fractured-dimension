// Navigation / interception visual QA harness (test scaffolding only). Opens the Dimension from a stub "ATLAS" page (any loopback origin),
// performs the link handshake and posts crafted route messages. Nothing here steers the target: the pilot flies Baymax with real keyboard/mouse input.
//
//   node scripts/nav-qa.mjs <scenario> [outDir] [dimensionUrl] [atlasStubUrl]
// scenarios: probe | static | intercept | miss | island | fold
import { chromium } from '@playwright/test';
import { mkdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';

const scenario = process.argv[2] ?? 'probe';
const out = process.argv[3] ?? 'docs/evidence/overhaul/nav';
const DIM = process.argv[4] ?? 'http://127.0.0.1:4220/?quality=performance&view=baymax';
const STUB = process.argv[5] ?? 'http://127.0.0.1:5184/';
const CH = 'fractured-atlas-link';
await mkdir(out, { recursive: true });

const browser = await chromium.launch({ channel: 'chrome', headless: true, args: ['--use-angle=d3d11', '--ignore-gpu-blocklist', '--enable-gpu-rasterization'] });
const context = await browser.newContext({ viewport: { width: 1920, height: 1080 } });
const stub = await context.newPage();
const errors = [];
stub.on('pageerror', e => errors.push(`stub: ${e.message}`));
await stub.goto(STUB);
const [dim] = await Promise.all([stub.waitForEvent('popup'), stub.evaluate(url => {
  window.__acks = []; window.__last = null; window.__welcome = null;
  window.addEventListener('message', e => {
    const d = e.data; if (!d || d.channel !== 'fractured-atlas-link') return;
    if (d.type === 'frame') window.__last = d; else if (d.type === 'welcome') window.__welcome = d; else if (d.type === 'route-ack') window.__acks.push(d);
  });
  window.__dim = window.open(url, 'dimqa');
}, DIM)]);
dim.on('pageerror', e => errors.push(`dim: ${e.message}`));
dim.on('console', m => { if (m.type() === 'error') errors.push(`dim console: ${m.text().slice(0, 200)}`); });
await dim.setViewportSize({ width: 1920, height: 1080 });
await dim.waitForFunction(() => !!window.__FRACTURED_DIAGNOSTICS__, null, { timeout: 180000 });
await dim.waitForFunction(() => document.querySelector('[data-render-ready="true"]'), null, { timeout: 180000 }).catch(() => undefined);
const origin = new URL(DIM).origin;
for (let i = 0; i < 20; i += 1) {
  await stub.evaluate(({ origin, CH }) => window.__dim.postMessage({ channel: CH, v: 2, type: 'hello', atlasSession: 'qa-session' }, origin), { origin, CH });
  await stub.waitForTimeout(500);
  if (await stub.evaluate(() => !!window.__welcome)) break;
}
const session = await stub.evaluate(() => window.__welcome?.session);
if (!session) throw new Error('no welcome');
const sleep = ms => stub.waitForTimeout(ms);
// Keep the link alive like a real ATLAS page (a peer silent for 7 s counts as lost).
await stub.evaluate(({ origin, CH }) => { setInterval(() => window.__dim.postMessage({ channel: CH, v: 2, type: 'ping' }, origin), 1500); }, { origin, CH });
const dist = (a, b) => Math.hypot(a[0] - b[0], a[1] - b[1], a[2] - b[2]);
const diag = () => dim.evaluate(() => { const d = window.__FRACTURED_DIAGNOSTICS__.read(); return { t: d.time, p: d.cameraPosition, q: d.cameraQuaternion, movers: d.movers, connections: d.connections.map(c => ({ id: c.id, state: c.state, entry: c.entryWorldPosition })), islands: d.renderedIslands }; });
const frame = () => stub.evaluate(() => window.__last);
const body = async () => (await frame())?.pose?.position;
const capsule = async () => (await diag()).movers.find(m => m.id === 'capsule-abigail');
let seqRev = 0;
const send = async route => { seqRev += 1; const r = { ...route, revision: seqRev, atlasSession: 'qa-session', supersedes: seqRev > 1 ? seqRev - 1 : null }; await stub.evaluate(({ origin, CH, session, r }) => window.__dim.postMessage({ channel: CH, v: 2, type: 'route', session, route: r }, origin), { origin, CH, session, r }); return r; };
const shot = async name => { await dim.screenshot({ path: join(out, `${name}.png`) }); console.log('shot', name); };
const hud = () => dim.evaluate(() => ({ phase: document.querySelector('[data-testid="nav-hud"]')?.dataset.phase, card: document.querySelector('[data-testid="nav-card"]')?.innerText, end: document.querySelector('[data-testid="nav-end"]')?.innerText }));

// ---------- piloting by real input ----------
const toCam = (d, q) => { const [qx, qy, qz, qw] = [-q[0], -q[1], -q[2], q[3]]; const tx = 2 * (qy * d[2] - qz * d[1]), ty = 2 * (qz * d[0] - qx * d[2]), tz = 2 * (qx * d[1] - qy * d[0]); return [d[0] + qw * tx + (qy * tz - qz * ty), d[1] + qw * ty + (qz * tx - qx * tz), d[2] + qw * tz + (qx * ty - qy * tx)]; };
const held = new Set();
async function setKeys(want) {
  for (const k of [...held]) if (!want.has(k)) { await dim.keyboard.up(k); held.delete(k); }
  for (const k of want) if (!held.has(k)) { await dim.keyboard.down(k); held.add(k); }
}
async function look(dx, dy) {
  if (Math.abs(dx) < 1 && Math.abs(dy) < 1) return;
  await dim.mouse.move(960, 540); await dim.mouse.down();
  await dim.mouse.move(960 + dx, 540 + dy, { steps: 2 }); await dim.mouse.up();
}
/** One pilot step towards a world point; returns the range. */
async function steer(target, { stop = 3, boostAbove = 70 } = {}) {
  const d0 = await diag(); const pos = await body() ?? d0.p;
  const d = [target[0] - pos[0], target[1] - pos[1], target[2] - pos[2]]; const c = toCam(d, d0.q); const range = Math.hypot(...d);
  const yawErr = Math.atan2(c[0], -c[2]), pitchErr = Math.atan2(c[1], Math.hypot(c[0], c[2]));
  await look(Math.max(-220, Math.min(220, yawErr / 0.0025)), -Math.max(-220, Math.min(220, pitchErr / 0.0025)));
  const keys = new Set();
  if (range > stop && Math.abs(yawErr) < 0.9) { keys.add('KeyW'); if (range > boostAbove && Math.abs(yawErr) < 0.3) keys.add('ShiftLeft'); }
  await setKeys(keys);
  return range;
}
async function flyTo(getTarget, { stop = 3, timeoutMs = 60000, until } = {}) {
  const t0 = Date.now();
  while (Date.now() - t0 < timeoutMs) {
    if (until && await until()) break;
    const t = await getTarget(); if (!t) break;
    const range = await steer(t, { stop });
    if (range <= stop) break;
    await sleep(100);
  }
  await setKeys(new Set());
}

// ---------- forecast scaffolding: quadratic fit over a short window of the capsule's observed path ----------
function fitQuadratic(samples) { // samples: [{t, p}] -> function(t) -> p
  const t0 = samples.at(-1).t; const n = samples.length;
  const solve = axis => {
    // normal equations for p = a + b dt + c dt^2
    let S = [0, 0, 0, 0, 0], R = [0, 0, 0];
    for (const s of samples) { const x = s.t - t0, y = s.p[axis]; const pw = [1, x, x * x, x ** 3, x ** 4]; for (let k = 0; k < 5; k += 1) S[k] += pw[k]; R[0] += y; R[1] += y * x; R[2] += y * x * x; }
    const M = [[S[0], S[1], S[2], R[0]], [S[1], S[2], S[3], R[1]], [S[2], S[3], S[4], R[2]]];
    for (let i = 0; i < 3; i += 1) { let m = i; for (let r = i + 1; r < 3; r += 1) if (Math.abs(M[r][i]) > Math.abs(M[m][i])) m = r; [M[i], M[m]] = [M[m], M[i]]; for (let r = i + 1; r < 3; r += 1) { const f = M[r][i] / M[i][i]; for (let k = i; k < 4; k += 1) M[r][k] -= f * M[i][k]; } }
    const x = [0, 0, 0]; for (let i = 2; i >= 0; i -= 1) { x[i] = (M[i][3] - (i < 2 ? M[i][i + 1] * x[i + 1] : 0) - (i < 1 ? M[i][i + 2] * x[i + 2] : 0)) / M[i][i]; }
    return x;
  };
  const co = [0, 1, 2].map(solve);
  return t => { const x = t - t0; return co.map(c => c[0] + c[1] * x + c[2] * x * x); };
}
async function observeCapsule(seconds) {
  const samples = []; const start = Date.now();
  while (Date.now() - start < seconds * 1000) { const d = await diag(); samples.push({ t: d.t, p: d.movers.find(m => m.id === 'capsule-abigail').position }); await sleep(250); }
  return samples;
}
/** Builds an interception route from a forecast function (the same maths ATLAS uses, simplified). `bias` shifts the forecast to make a wrong prediction. */
function buildIntercept(from, now, predict, { speed = 12, bias = [0, 0, 0], leadLimited = false, standoff = 2.2, bend = 0.18 } = {}) {
  let T = 1;
  for (let i = 0; i < 60; i += 1) { const p = predict(now + T).map((v, k) => v + bias[k]); const nt = dist(p, from) / speed; if (Math.abs(nt - T) < 0.01) { T = nt; break; } T = 0.5 * T + 0.5 * nt; }
  const meet = predict(now + T).map((v, k) => v + bias[k]);
  const away = [from[0] - meet[0], from[1] - meet[1], from[2] - meet[2]]; const al = Math.hypot(...away);
  const end = meet.map((v, k) => v + away[k] / al * standoff);
  const mid = [0, 1, 2].map(k => from[k] + (end[k] - from[k]) * 0.45);
  const sideways = [-(end[2] - from[2]), 0, end[0] - from[0]]; const sl = Math.hypot(...sideways) || 1;
  const bent = mid.map((v, k) => v + sideways[k] / sl * dist(from, end) * bend);
  const path = []; for (let k = 0; k <= 20; k += 1) { const t = now + (T + 3) * k / 20; path.push({ simTime: t, position: predict(t).map((v, j) => v + bias[j]) }); }
  return {
    routeId: 'qa-route', goal: { id: 'capsule-abigail', label: "Abigail's Capsule", category: 'landmark', motion: 'moving', assetId: 'capsule_shell_remnant' }, mode: 'intercept', issuedSimTime: now, speed,
    waypoints: [
      { id: 'w1', position: bent, kind: 'path', arrivalRadius: 6, etaSimTime: now + T * 0.45 },
      { id: 'w2', position: end, kind: 'intercept', arrivalRadius: 4, etaSimTime: now + T },
    ],
    interception: { position: meet, simTime: now + T, targetNow: predict(now), targetObservedAt: now, uncertainty: 1.6, targetPath: path, ...(leadLimited ? { leadLimited: true } : {}), arrivalSimTime: now + T },
    reason: 'Interception recomputed from the observed motion of the capsule.', assumptions: [],
  };
}

/** Turn to face a world point without moving (what a player does on receiving a route). */
async function face(target, ms = 3000) { const t0 = Date.now(); while (Date.now() - t0 < ms) { await steer(target, { stop: Infinity }); await sleep(120); } await setKeys(new Set()); }
const results = { scenario, errors, notes: {} };
try {
  if (scenario === 'probe') {
    await sleep(1500);
    const d = await diag(); const b = await body();
    const c = d.movers.find(m => m.id === 'capsule-abigail');
    console.log(JSON.stringify({ sim: d.t, body: b, cam: d.p, capsule: c.position, range: dist(b ?? d.p, c.position), islands: d.islands.slice(0, 4), folds: d.connections.slice(0, 4) }));
    await shot('probe');
  }
  if (scenario === 'static') {
    // A crafted route straight ahead of Baymax with a bend, a moving-target forecast and a ghost, to judge the look without flying.
    await sleep(1500);
    const d = await diag(); const b = await body() ?? d.p;
    const c = d.movers.find(m => m.id === 'capsule-abigail').position;
    await flyTo(() => [c[0] + 70, c[1] + 12, c[2] + 55], { stop: 4, timeoutMs: 40000 });
    await sleep(500);
    const samples = await observeCapsule(5);
    const predict = fitQuadratic(samples.slice(-16));
    const now = (await diag()).t;
    const from = await body();
    const route = buildIntercept(from, now, predict);
    await send(route);
    await face(route.waypoints[0].position, 3000);
    await shot('01-route-sent-baymax-view');
    results.notes.hud = await hud();
    // Measurement: what is drawn (GPU vertex data) against what was transmitted, and where they project on screen.
    const nav = await dim.evaluate(() => window.__FRACTURED_NAV__.read());
    const cam = await diag();
    const last = route.waypoints.at(-1).position, T = route.interception.simTime;
    const ghostExpected = (() => { const p = route.interception.targetPath; for (let k = 1; k < p.length; k += 1) if (T <= p[k].simTime) { const f = (T - p[k - 1].simTime) / (p[k].simTime - p[k - 1].simTime); return p[k - 1].position.map((v, j) => v + (p[k].position[j] - v) * f); } return p.at(-1).position; })();
    const proj = (pt) => { const d = [pt[0] - cam.p[0], pt[1] - cam.p[1], pt[2] - cam.p[2]]; const c = toCam(d, cam.q); const f = 1 / Math.tan(56 * Math.PI / 360); return { x: (c[0] * f / (1920 / 1080) / -c[2] * 0.5 + 0.5) * 1920, y: (1 - (c[1] * f / -c[2] * 0.5 + 0.5)) * 1080 }; };
    results.notes.measure = {
      transmittedEnd: last, drawnEnd: nav.ribbon.at(-1), endError: dist(last, nav.ribbon.at(-1)),
      drawnWaypoints: nav.ribbon.slice(1), transmittedWaypoints: route.waypoints.map(w => w.position),
      ghostExpected, ghostDrawn: nav.ghost, ghostError: nav.ghost ? dist(ghostExpected, nav.ghost) : null,
      projectedEndPx: proj(last), projectedGhostPx: proj(ghostExpected), camera: cam.p,
    };
    console.log(JSON.stringify(results.notes.measure));
    console.log(JSON.stringify({ route: route.waypoints.map(w => w.position), meeting: route.interception.position, T: route.interception.simTime - now }));
  }
  if (scenario === 'intercept' || scenario === 'miss') {
    const miss = scenario === 'miss';
    await sleep(1000);
    const c0 = (await capsule()).position;
    await flyTo(() => [c0[0] + 70, c0[1] + 12, c0[2] + 55], { stop: 4, timeoutMs: 40000 });
    const samples = await observeCapsule(5);
    const predict = fitQuadratic(samples.slice(-16));
    const now = (await diag()).t;
    const from = await body();
    const route = buildIntercept(from, now, predict, { bias: miss ? [30, 12, -28] : [0, 0, 0] });
    await send(route);
    const plannedT = route.interception.simTime;
    await face(route.waypoints[0].position, 2500);
    await shot(`${scenario}-1-route-sent`);
    const log = []; let shotMid = false, shotNear = false, shotEnd = false; const t0 = Date.now();
    while (Date.now() - t0 < 70000) {
      const f = await frame(); const nav = f?.nav; const d = await diag();
      const cap = d.movers.find(m => m.id === 'capsule-abigail').position; const pos = await body();
      log.push({ t: +d.t.toFixed(1), range: +dist(pos, cap).toFixed(1), idx: nav?.activeIndex, status: nav?.status, closest: nav?.closestApproach });
      if (!nav && Date.now() - t0 < 6000) { await sleep(150); continue; }
      if (!nav || nav.status !== 'active') break;
      const wp = route.waypoints[Math.min(nav.activeIndex, route.waypoints.length - 1)].position;
      await steer(wp, { stop: 1.5 });
      if (!shotMid && nav.activeIndex === 1) { shotMid = true; await shot(`${scenario}-2-mid-flight`); }
      if (!shotNear && d.t >= plannedT - 3.5) { shotNear = true; await shot(`${scenario}-3-near-rendezvous`); }
      await sleep(80);
    }
    await setKeys(new Set());
    await sleep(1200);
    results.notes.log = log.filter((_, i) => i % 4 === 0);
    results.notes.final = (await frame())?.nav;
    results.notes.route = route;
    results.notes.hud = await hud();
    await shot(`${scenario}-4-result`);
    console.log(JSON.stringify({ final: results.notes.final, hud: results.notes.hud.card }));
  }
  if (scenario === 'island' || scenario === 'fold') {
    await sleep(1500);
    const d = await diag(); const from = await body() ?? d.p;
    let goal, end, mode, kind, radius;
    if (scenario === 'island') { const isl = d.islands.find(x => x.id === 'island-04'); goal = { id: 'island-04', label: 'Island 04', category: 'island', motion: 'static' }; end = [isl.position[0], isl.position[1] + 14, isl.position[2]]; mode = 'approach'; kind = 'approach'; radius = 8; }
    else { const f = d.connections.find(x => x.id === 'F03'); goal = { id: 'F03', label: 'Fold F03', category: 'fold', motion: 'static' }; end = f.entry; mode = 'entrance'; kind = 'entrance'; radius = 5; }
    const mid = [0, 1, 2].map(k => from[k] + (end[k] - from[k]) * 0.5 + (k === 1 ? 6 : 0));
    const route = { routeId: `qa-${scenario}`, goal, mode, issuedSimTime: d.t, speed: 12, waypoints: [{ id: 'w1', position: mid, kind: 'path', arrivalRadius: 6, etaSimTime: null }, { id: 'w2', position: end, kind, arrivalRadius: radius, etaSimTime: null }], interception: null, reason: scenario === 'island' ? 'Approach point above the island.' : 'Fold entrance as observed.', assumptions: [] };
    await send(route);
    await face(mid, 2500);
    await shot(`${scenario}-1-route-sent`);
    const t0 = Date.now();
    while (Date.now() - t0 < 60000) {
      const nav = (await frame())?.nav;
      if (!nav && Date.now() - t0 < 5000) { await sleep(150); continue; }
      if (!nav || nav.status !== 'active') break;
      await steer(route.waypoints[Math.min(nav.activeIndex, 1)].position, { stop: 1 }); await sleep(80);
    }
    await setKeys(new Set()); await sleep(1500);
    results.notes.final = (await frame())?.nav; results.notes.hud = await hud();
    await shot(`${scenario}-2-result`);
    console.log(JSON.stringify(results.notes.final));
  }
} finally {
  await setKeys(new Set()).catch(() => undefined);
  await writeFile(join(out, `${scenario}-results.json`), JSON.stringify(results, null, 1));
  console.log(errors.join('\n') || 'no page errors');
  await browser.close();
}
