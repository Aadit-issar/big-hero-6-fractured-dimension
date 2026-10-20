import { useEffect, useMemo, useSyncExternalStore } from 'react';
import { createPortal, useFrame, useThree } from '@react-three/fiber';
import { BufferAttribute, BufferGeometry, Group, Mesh, Quaternion, Vector3 } from 'three';
import type { ShaderMaterial } from 'three';
import type { SimulationEngine } from '../../simulation/simulationEngine';
import type { Overlay } from '../gas/overlay';
import { useAssets } from '../assets/assetLoader';
import { getCameraPose } from '../../bridge/poseStore';
import { getActiveRoute, getNavVersion, subscribeNav } from '../../bridge/navStore';
import { plannedTargetAt } from '../../bridge/navCore';
import type { ActiveRoute } from '../../bridge/navCore';
import { moversFor } from '../../world/movers';
import type { RouteCommand, Vec3Tuple } from '../../shared/liveLink';
import { allocRibbon, fillRibbon, remainingTargetPath, ribbonVertexPosition, routePoints } from './routeGeometry';
import type { RibbonArrays } from './routeGeometry';
import { ROUTE_COLOR, TARGET_PATH_COLOR, ghostMaterial, nodeMaterial, ribbonMaterial, widthPx } from './routeShaders';

/** The 3D route and the rendezvous, drawn in world space from the active route (navStore) in the luminous overlay, so the dashed line stays
 * crisp over the gas (see routeShaders.ts). Pure display: nothing here moves Baymax, the target or the simulation.
 *   - dashed route from Baymax's current position through the remaining waypoints (straight legs, exactly as planned),
 *   - small waypoint nodes (passed ones dimmed), a restrained rendezvous reticle at the final waypoint,
 *   - for a moving target, a translucent copy of the SAME asset at the forecast position at the planned time and a faint dashed forecast path.
 * A new revision cross-fades from the old line to the new one. Visual motion uses engine.clock.time, so it freezes on pause. */

const MAX_SEGMENTS = 26, MAX_NODES = 26;
const FADE_SECONDS = 0.7;
const BODY_LEAD = 1.8;
const CORNERS: readonly (readonly [number, number])[] = [[-1, -1], [1, -1], [1, 1], [-1, 1]];

class Ribbon {
  readonly arrays: RibbonArrays = allocRibbon(MAX_SEGMENTS);
  readonly geometry = new BufferGeometry();
  readonly mesh: Mesh;
  constructor(readonly material: ShaderMaterial) {
    const g = this.geometry, a = this.arrays;
    g.setAttribute('position', new BufferAttribute(a.start, 3));
    g.setAttribute('aEnd', new BufferAttribute(a.end, 3));
    g.setAttribute('aCorner', new BufferAttribute(a.corner, 2));
    g.setAttribute('aU', new BufferAttribute(a.u, 2));
    g.setIndex(new BufferAttribute(a.index, 1));
    g.setDrawRange(0, 0);
    this.mesh = new Mesh(g, material);
    this.mesh.frustumCulled = false; this.mesh.renderOrder = 3; this.mesh.visible = false;
  }
  set(points: readonly Vec3Tuple[]): void {
    const n = fillRibbon(this.arrays, points);
    this.geometry.setDrawRange(0, n * 6);
    for (const name of ['position', 'aEnd', 'aCorner', 'aU']) (this.geometry.getAttribute(name) as BufferAttribute).needsUpdate = true;
    this.mesh.visible = n > 0;
  }
  dispose(): void { this.geometry.dispose(); this.material.dispose(); }
}

class Nodes {
  readonly geometry = new BufferGeometry();
  readonly mesh: Mesh;
  private readonly position = new Float32Array(MAX_NODES * 12);
  private readonly corner = new Float32Array(MAX_NODES * 8);
  private readonly info = new Float32Array(MAX_NODES * 16);
  constructor(readonly material: ShaderMaterial) {
    const index = new Uint32Array(MAX_NODES * 6);
    for (let i = 0; i < MAX_NODES; i += 1) { index.set([i * 4, i * 4 + 1, i * 4 + 2, i * 4, i * 4 + 2, i * 4 + 3], i * 6); CORNERS.forEach((c, k) => this.corner.set(c, (i * 4 + k) * 2)); }
    const g = this.geometry;
    g.setAttribute('position', new BufferAttribute(this.position, 3));
    g.setAttribute('aCorner', new BufferAttribute(this.corner, 2));
    g.setAttribute('aInfo', new BufferAttribute(this.info, 4));
    g.setIndex(new BufferAttribute(index, 1));
    g.setDrawRange(0, 0);
    this.mesh = new Mesh(g, material);
    this.mesh.frustumCulled = false; this.mesh.renderOrder = 4; this.mesh.visible = false;
  }
  /** One marker per waypoint: small dots, with the reticle (and, for a region goal, a soft ring of the arrival radius) at the final one. */
  set(route: RouteCommand, activeIndex: number): void {
    const wps = route.waypoints;
    let n = 0;
    const put = (p: Vec3Tuple, size: number, kind: number, state: number, radius: number) => {
      if (n >= MAX_NODES) return;
      for (let k = 0; k < 4; k += 1) { this.position.set(p, (n * 4 + k) * 3); this.info.set([size, kind, state, radius], (n * 4 + k) * 4); }
      n += 1;
    };
    wps.forEach((w, i) => {
      const last = i === wps.length - 1;
      const state = i < activeIndex ? 1 : i === activeIndex ? 2 : 0;
      if (!last) put(w.position, 7, 0, state, 0);
      else {
        put(w.position, 32, 2, state, 0);
        if (w.kind === 'approach' || w.kind === 'entrance') put(w.position, 34, 3, state, w.arrivalRadius);
      }
    });
    this.geometry.setDrawRange(0, n * 6);
    for (const name of ['position', 'aInfo']) (this.geometry.getAttribute(name) as BufferAttribute).needsUpdate = true;
    this.mesh.visible = n > 0;
  }
  dispose(): void { this.geometry.dispose(); this.material.dispose(); }
}

/** One complete drawing of one route revision; two of these cross-fade when a new revision arrives. */
class Layer {
  readonly ribbon: Ribbon;
  readonly nodes: Nodes;
  route: RouteCommand | null = null;
  activeIndex = 0;
  alpha = 0;
  constructor(shared: Overlay['uniforms']) {
    this.ribbon = new Ribbon(ribbonMaterial(shared, { color: ROUTE_COLOR, halfPx: widthPx.half }));
    this.nodes = new Nodes(nodeMaterial(shared));
  }
  draw(baymax: Vec3Tuple, time: number, px: number): void {
    const materials = [this.ribbon.material, this.nodes.material];
    for (const m of materials) { m.uniforms.uAlpha!.value = this.alpha; m.uniforms.uTime!.value = time; m.uniforms.uPx!.value = px; }
    const visible = !!this.route && this.alpha > 0.002;
    this.ribbon.mesh.visible = this.nodes.mesh.visible = visible;
    if (!this.route || !visible) return;
    const pts = routePoints(baymax, this.route, this.activeIndex);
    // The line leaves Baymax's body (about 1.8 m ahead of his centre) instead of passing through it; the legs themselves are unchanged.
    const next = pts[1];
    if (next) {
      const dx = next[0] - baymax[0], dy = next[1] - baymax[1], dz = next[2] - baymax[2], len = Math.hypot(dx, dy, dz);
      const lead = Math.min(BODY_LEAD, len * 0.5);
      if (len > 1e-6) pts[0] = [baymax[0] + dx / len * lead, baymax[1] + dy / len * lead, baymax[2] + dz / len * lead];
    }
    this.ribbon.set(pts);
    if (this.route && this.alpha > 0.5) drawn.ribbon = ribbonVertices(this.ribbon.arrays, pts.length - 1);
    this.nodes.set(this.route, this.activeIndex);
  }
  dispose(): void { this.ribbon.dispose(); this.nodes.dispose(); }
}

/** Read-only engineering readout of what is actually drawn (geometry uploaded to the GPU), for the QA harness: window.__FRACTURED_NAV__.read(). */
const drawn: { ribbon: Vec3Tuple[]; ghost: Vec3Tuple | null; forecastEnd: Vec3Tuple | null } = { ribbon: [], ghost: null, forecastEnd: null };
if (typeof window !== 'undefined') (window as unknown as { __FRACTURED_NAV__?: unknown }).__FRACTURED_NAV__ = { read: () => ({ ribbon: drawn.ribbon.map(p => [...p]), ghost: drawn.ghost && [...drawn.ghost], forecastEnd: drawn.forecastEnd && [...drawn.forecastEnd] }) };

/** The polyline as stored in the ribbon vertex buffers: segment starts followed by the final end vertex. */
function ribbonVertices(a: RibbonArrays, legs: number): Vec3Tuple[] {
  const out: Vec3Tuple[] = [];
  let n = 0;
  for (let s = 0; s < legs && s * 4 < a.start.length / 3; s += 1) { out.push(ribbonVertexPosition(a, s * 4)); n = s; }
  if (out.length) out.push(ribbonVertexPosition(a, n * 4 + 3));
  return out;
}

const approach = (value: number, target: number, step: number) => (value < target ? Math.min(target, value + step) : Math.max(target, value - step));
const routeKey = (a: ActiveRoute | null) => (a ? `${a.route.routeId}:${a.route.revision}` : '');

function RouteLayers({ engine, overlay }: { readonly engine: SimulationEngine; readonly overlay: Overlay }) {
  const gl = useThree(s => s.gl);
  const built = useMemo(() => {
    const layers = [new Layer(overlay.uniforms), new Layer(overlay.uniforms)] as const;
    const forecast = new Ribbon(ribbonMaterial(overlay.uniforms, { color: TARGET_PATH_COLOR, halfPx: 3.2, dash: [0.9, 1.5], pulseGain: 0.25, fadeNear: 12 }));
    forecast.mesh.renderOrder = 2;
    const group = new Group();
    group.name = 'nav-route';
    group.add(forecast.mesh, ...layers.flatMap(l => [l.ribbon.mesh, l.nodes.mesh]));
    return { layers, forecast, group, state: { current: 0, key: '', forecastAlpha: 0 } };
  }, [overlay]);
  useEffect(() => () => { built.layers.forEach(l => l.dispose()); built.forecast.dispose(); }, [built]);

  useFrame((_, delta) => {
    const a = getActiveRoute();
    const pose = getCameraPose();
    const { layers, forecast, state } = built;
    const step = Math.min(delta, 0.1) / FADE_SECONDS;
    const live = !!a && !!pose && a.phase === 'active';
    const key = routeKey(a);
    if (live && key !== state.key) {
      // A new revision: the idle layer takes it and fades in while the previous one fades out (no pop). The first route simply fades in.
      state.current = 1 - state.current;
      const next = layers[state.current]!;
      next.route = a.route; next.activeIndex = a.activeIndex; next.alpha = 0;
      state.key = key;
    }
    const cur = layers[state.current]!, old = layers[1 - state.current]!;
    if (live) { cur.activeIndex = a.activeIndex; if (cur.route === null) cur.route = a.route; }
    cur.alpha = approach(cur.alpha, live ? 1 : 0, step);
    if (!live && cur.alpha === 0) state.key = '';
    old.alpha = approach(old.alpha, 0, step);
    const baymax = pose?.position ?? [0, 0, 0] as Vec3Tuple;
    const px = gl.getPixelRatio();
    const time = engine.clock.time;
    cur.draw(baymax, time, px);
    old.draw(baymax, time, px);
    // Forecast path of the target (display data from ATLAS): from the target's forecast position now onward.
    const i = live ? a.route.interception : null;
    state.forecastAlpha = approach(state.forecastAlpha, i?.targetPath ? 0.75 : 0, step);
    const fm = forecast.material;
    fm.uniforms.uAlpha!.value = state.forecastAlpha; fm.uniforms.uTime!.value = time; fm.uniforms.uPx!.value = px;
    if (i?.targetPath && state.forecastAlpha > 0.002) {
      const pts = remainingTargetPath(i.targetPath, time, t => plannedTargetAt(i, t));
      forecast.set(pts.length ? pts : [i.position, i.position]);
    } else forecast.mesh.visible = false;
  });
  return createPortal(<primitive object={built.group} />, overlay.scene);
}

const scratchQ = new Quaternion();
/** The translucent projected target: the SAME asset (registry id from the route) at ATLAS's forecast position at the planned time. */
function ProjectedTarget({ engine, overlay, assetId }: { readonly engine: SimulationEngine; readonly overlay: Overlay; readonly assetId: string }) {
  const assets = useAssets([assetId]);
  const asset = assets?.[assetId] ?? null;
  const gl = useThree(s => s.gl);
  const built = useMemo(() => {
    if (!asset) return null;
    const material = ghostMaterial(overlay.uniforms);
    const group = new Group();
    group.name = 'nav-projected-target';
    group.visible = false;
    const level = asset.levels[Math.min(1, asset.levels.length - 1)]!;
    for (const part of level.parts) { const mesh = new Mesh(part.geometry, material); mesh.frustumCulled = false; mesh.renderOrder = 2; group.add(mesh); }
    return { group, material, alpha: 0, placed: false, position: new Vector3() };
  }, [asset, overlay]);
  useEffect(() => () => { built?.material.dispose(); }, [built]);

  useFrame((_, delta) => {
    if (!built) return;
    const a = getActiveRoute();
    const i = a && a.phase === 'active' ? a.route.interception : null;
    const step = Math.min(delta, 0.1) / FADE_SECONDS;
    built.alpha = approach(built.alpha, i ? 1 : 0, step);
    built.group.visible = built.alpha > 0.002;
    if (!i || !a) return;
    const target = plannedTargetAt(i, i.simTime);
    // A revised forecast glides to its new position instead of popping.
    if (!built.placed) { built.position.set(...target); built.placed = true; }
    else built.position.lerp(scratchV.set(...target), 1 - Math.exp(-Math.min(delta, 0.1) * 6));
    built.group.position.copy(built.position);
    drawn.ghost = [built.position.x, built.position.y, built.position.z];
    // The attitude is the object's current attitude (what a scan reports); only the position is a forecast.
    const state = moversFor(engine).states().find(s => s.id === a.route.goal.id);
    if (state) built.group.quaternion.copy(scratchQ.set(...state.quaternion)); else built.group.quaternion.identity();
    const u = built.material.uniforms;
    u.uAlpha!.value = built.alpha; u.uTime!.value = engine.clock.time; u.uPx!.value = gl.getPixelRatio();
  });
  return built ? createPortal(<primitive object={built.group} />, overlay.scene) : null;
}
const scratchV = new Vector3();

export function RouteScene({ engine, overlay }: { readonly engine: SimulationEngine; readonly overlay: Overlay | null }) {
  useSyncExternalStore(subscribeNav, getNavVersion);
  const assetId = getActiveRoute()?.route.goal.assetId;
  const moving = getActiveRoute()?.route.interception != null;
  if (!overlay) return null;
  return (
    <>
      <RouteLayers engine={engine} overlay={overlay} />
      {assetId && moving && <ProjectedTarget key={assetId} engine={engine} overlay={overlay} assetId={assetId} />}
    </>
  );
}
