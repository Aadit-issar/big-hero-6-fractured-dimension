import { useEffect, useMemo } from 'react';
import { useFrame, useThree } from '@react-three/fiber';
import {
  AdditiveBlending, BufferAttribute, BufferGeometry, DynamicDrawUsage, Mesh, MeshBasicMaterial, Points, ShaderMaterial, DoubleSide,
} from 'three';
import type { PerspectiveCamera } from 'three';
import { deformPosition } from '../../simulation/deformation';
import type { SimulationEngine } from '../../simulation/simulationEngine';
import { disturbanceFrame, disturbanceIntensity, moversFor, MOVER_DEFS, newDisturbanceFrame } from '../../world/movers';
import { FLOW_LINES_PER_DISTURBANCE, FLOW_POINTS, flowScale, flowSeeds, traceFlowLine } from '../../world/flowLines';
import { TRAIL_CAPACITY } from '../../world/trail';

/** Readable physics (rendering only, restrained). Everything here is derived from the mover system's own state at the engine clock, so it
 * freezes on pause and replays exactly on reset:
 *  - TRAILS: a fading ribbon through each trailed mover's last 3.2 s of its own mapped positions (a bounded ring buffer in the mover system);
 *  - FLOW LINES: streamlines of every disturbance's own force field (src/world/flowLines.ts), pushed through the spatial map, with a travelling
 *    brightness pulse that shows the direction of the force and fades where the force fades;
 *  - GLOW: a soft sprite on any mover currently inside a disturbance or a fold funnel (its activity), and a faint core marker per disturbance.
 * Toggle with ?disable=trails,fieldlines,glow. */

/** Per-disturbance flow-line palette (index = position in DISTURBANCES). */
const PALETTE: ReadonlyArray<readonly [number, number, number]> = [[1.0, 0.45, 0.95], [0.4, 0.95, 1.0], [1.0, 0.72, 0.3], [0.65, 0.52, 1.0]];
const FOLD_COLOR: readonly [number, number, number] = [0.35, 1.0, 0.85];
const FAMILY_COLOR: Readonly<Record<string, readonly [number, number, number]>> = { baymax: [1.0, 0.45, 0.32], capsule: [1.0, 0.8, 0.4], industrial: [0.5, 0.75, 1.0], concrete: [0.85, 0.88, 0.95] };

const TRAILED = MOVER_DEFS.map((m, i) => ({ m, i })).filter(({ m }) => m.trail);
const POINTS_PER_TRAIL = TRAIL_CAPACITY + 1;

function MoverTrails({ engine }: { readonly engine: SimulationEngine }) {
  const built = useMemo(() => {
    const verts = TRAILED.length * POINTS_PER_TRAIL * 2;
    const geometry = new BufferGeometry();
    const position = new BufferAttribute(new Float32Array(verts * 3), 3).setUsage(DynamicDrawUsage);
    const color = new BufferAttribute(new Float32Array(verts * 3), 3).setUsage(DynamicDrawUsage);
    const indices: number[] = [];
    for (let j = 0; j < TRAILED.length; j += 1) for (let k = 0; k < POINTS_PER_TRAIL - 1; k += 1) {
      const a = (j * POINTS_PER_TRAIL + k) * 2;
      indices.push(a, a + 1, a + 2, a + 1, a + 3, a + 2);
    }
    geometry.setAttribute('position', position); geometry.setAttribute('color', color); geometry.setIndex(indices);
    const material = new MeshBasicMaterial({ vertexColors: true, transparent: true, blending: AdditiveBlending, depthWrite: false, side: DoubleSide, toneMapped: false });
    const mesh = new Mesh(geometry, material);
    mesh.frustumCulled = false; mesh.name = 'mover-trails';
    return { mesh, geometry, material, position, color, pts: new Float64Array(POINTS_PER_TRAIL * 3) };
  }, []);
  useEffect(() => () => { built.geometry.dispose(); built.material.dispose(); }, [built]);
  useFrame(({ camera }) => {
    const system = moversFor(engine), states = system.states(), D = Math.max(1, system.disturbances.length);
    const pos = built.position.array as Float32Array, col = built.color.array as Float32Array, pts = built.pts, cx = camera.position.x, cy = camera.position.y, cz = camera.position.z;
    TRAILED.forEach(({ m, i }, j) => {
      const trail = system.trailOf(m.id), head = states[i]!.position;
      const base = FAMILY_COLOR[m.family] ?? FAMILY_COLOR.concrete!;
      let act = system.foldActivity[i]!;
      for (let d = 0; d < system.disturbances.length; d += 1) act += system.influence[i * D + d]!;
      act = Math.min(1, act);
      const gain = 0.5 + 1.1 * act;
      let n = 0;
      pts[0] = head[0]; pts[1] = head[1]; pts[2] = head[2]; n = 1;
      if (trail) for (let age = 0; age < trail.length; age += 1) { trail.read(age, pts, n * 3); n += 1; }
      // Skip a first sample that coincides with the head (stride tick == current tick).
      const o0 = j * POINTS_PER_TRAIL * 2;
      for (let k = 0; k < POINTS_PER_TRAIL; k += 1) {
        const kk = Math.min(k, n - 1), o = (o0 + k * 2) * 3;
        const px = pts[kk * 3]!, py = pts[kk * 3 + 1]!, pz = pts[kk * 3 + 2]!;
        const a = Math.max(0, kk - 1), b = Math.min(n - 1, kk + 1);
        let tx = pts[a * 3]! - pts[b * 3]!, ty = pts[a * 3 + 1]! - pts[b * 3 + 1]!, tz = pts[a * 3 + 2]! - pts[b * 3 + 2]!;
        const vx = cx - px, vy = cy - py, vz = cz - pz;
        let sx = ty * vz - tz * vy, sy = tz * vx - tx * vz, sz = tx * vy - ty * vx;
        const sl = Math.hypot(sx, sy, sz) || 1; sx /= sl; sy /= sl; sz /= sl;
        const dcam = Math.hypot(vx, vy, vz);
        const life = k < n ? 1 - kk / Math.max(1, n - 1) : 0;
        const w = Math.max(0.05 + 0.06 * m.radius, dcam * 0.0028) * Math.pow(life, 0.7);
        const fade = Math.pow(life, 1.7) * gain * 1.5;
        // Brighten toward the dominant effect colour while influenced.
        const r = base[0] * (1 - 0.4 * act) + 1.0 * 0.4 * act, g = base[1] * (1 - 0.4 * act) + 0.55 * 0.4 * act, bl = base[2] * (1 - 0.4 * act) + 1.0 * 0.4 * act;
        pos[o] = px + sx * w; pos[o + 1] = py + sy * w; pos[o + 2] = pz + sz * w;
        pos[o + 3] = px - sx * w; pos[o + 4] = py - sy * w; pos[o + 5] = pz - sz * w;
        col[o] = col[o + 3] = r * fade; col[o + 1] = col[o + 4] = g * fade; col[o + 2] = col[o + 5] = bl * fade;
      }
    });
    built.position.needsUpdate = true; built.color.needsUpdate = true;
  });
  return <primitive object={built.mesh} />;
}

function FlowLines({ engine }: { readonly engine: SimulationEngine }) {
  const D = moversFor(engine).disturbances.length;
  const built = useMemo(() => {
    const per = FLOW_LINES_PER_DISTURBANCE * FLOW_POINTS, verts = D * per * 2;
    const geometry = new BufferGeometry();
    const position = new BufferAttribute(new Float32Array(verts * 3), 3).setUsage(DynamicDrawUsage);
    const color = new BufferAttribute(new Float32Array(verts * 3), 3).setUsage(DynamicDrawUsage);
    const indices: number[] = [];
    for (let d = 0; d < D; d += 1) for (let line = 0; line < FLOW_LINES_PER_DISTURBANCE; line += 1) for (let k = 0; k < FLOW_POINTS - 1; k += 1) {
      const a = ((d * FLOW_LINES_PER_DISTURBANCE + line) * FLOW_POINTS + k) * 2;
      indices.push(a, a + 1, a + 2, a + 1, a + 3, a + 2);
    }
    geometry.setAttribute('position', position); geometry.setAttribute('color', color); geometry.setIndex(indices);
    const material = new MeshBasicMaterial({ vertexColors: true, transparent: true, blending: AdditiveBlending, depthWrite: false, side: DoubleSide, toneMapped: false });
    const mesh = new Mesh(geometry, material);
    mesh.frustumCulled = false; mesh.name = 'flow-lines';
    return {
      mesh, geometry, material, position, color, lastTick: new Array<number>(D).fill(-1e9), frame: newDisturbanceFrame(),
      seeds: new Float64Array(FLOW_LINES_PER_DISTURBANCE * 3), ref: new Float64Array(per * 3), mag: new Float64Array(per), scratch: new Float64Array(3),
      worlds: Array.from({ length: D }, () => new Float32Array(per * 3)), mags: Array.from({ length: D }, () => new Float32Array(per)),
    };
  }, [D]);
  useEffect(() => () => { built.geometry.dispose(); built.material.dispose(); }, [built]);
  useFrame(({ camera }) => {
    const system = moversFor(engine), t = system.time, field = system.field, mapping = system.mapping, tick = system.tick;
    // One disturbance is re-traced per frame (the stalest, at most every 4 ticks), which bounds the CPU cost; the others keep their last lines.
    let pick = -1, stale = 3;
    for (let d = 0; d < D; d += 1) if (tick - built.lastTick[d]! > stale || tick < built.lastTick[d]!) { stale = tick - built.lastTick[d]!; pick = d; }
    if (pick >= 0) {
      const def = system.disturbances[pick]!;
      flowSeeds(def, t, built.seeds);
      disturbanceFrame(def, t, built.frame);
      const scale = flowScale(def);
      for (let i = 0; i < FLOW_LINES_PER_DISTURBANCE; i += 1) traceFlowLine(built.frame, scale, built.seeds[i * 3]!, built.seeds[i * 3 + 1]!, built.seeds[i * 3 + 2]!, built.ref, built.mag, i * FLOW_POINTS, built.scratch);
      // Map the reference-space points through the unchanged spatial law.
      const tmp: [number, number, number] = [0, 0, 0], world = built.worlds[pick]!, mags = built.mags[pick]!;
      for (let k = 0; k < FLOW_LINES_PER_DISTURBANCE * FLOW_POINTS; k += 1) {
        tmp[0] = built.ref[k * 3]!; tmp[1] = built.ref[k * 3 + 1]!; tmp[2] = built.ref[k * 3 + 2]!;
        const p = deformPosition(tmp, t, field, mapping);
        world[k * 3] = p[0]; world[k * 3 + 1] = p[1]; world[k * 3 + 2] = p[2];
        mags[k] = built.mag[k]!;
      }
      built.lastTick[pick] = tick;
    }
    const pos = built.position.array as Float32Array, col = built.color.array as Float32Array, cx = camera.position.x, cy = camera.position.y, cz = camera.position.z;
    for (let d = 0; d < D; d += 1) {
      if (built.lastTick[d]! < -1e8) continue;
      const world = built.worlds[d]!, mags = built.mags[d]!, c = PALETTE[d % PALETTE.length]!, intensity = disturbanceIntensity(system.disturbances[d]!, t);
      for (let line = 0; line < FLOW_LINES_PER_DISTURBANCE; line += 1) for (let k = 0; k < FLOW_POINTS; k += 1) {
        const idx = line * FLOW_POINTS + k, o = ((d * FLOW_LINES_PER_DISTURBANCE * FLOW_POINTS) + idx) * 6;
        const a = idx - (k > 0 ? 1 : 0), b = idx + (k < FLOW_POINTS - 1 ? 1 : 0);
        const px = world[idx * 3]!, py = world[idx * 3 + 1]!, pz = world[idx * 3 + 2]!;
        const tx = world[b * 3]! - world[a * 3]!, ty = world[b * 3 + 1]! - world[a * 3 + 1]!, tz = world[b * 3 + 2]! - world[a * 3 + 2]!;
        const vx = cx - px, vy = cy - py, vz = cz - pz;
        let sx = ty * vz - tz * vy, sy = tz * vx - tx * vz, sz = tx * vy - ty * vx;
        const sl = Math.hypot(sx, sy, sz) || 1, dcam = Math.hypot(vx, vy, vz);
        const u = k / (FLOW_POINTS - 1), ends = Math.pow(Math.sin(Math.PI * u), 0.6);
        const w = Math.max(0.05, dcam * 0.0026) * (0.5 + 0.5 * ends) / sl;
        sx *= w; sy *= w; sz *= w;
        const m = Math.min(1, mags[idx]!);
        const pulse = 0.4 + 0.6 * Math.pow(0.5 + 0.5 * Math.sin(6.2832 * (u * 1.4 - t * 0.35 + line * 0.173)), 3);
        const v = Math.pow(m, 0.75) * ends * pulse * (0.4 + 0.6 * intensity) * 1.6;
        pos[o] = px + sx; pos[o + 1] = py + sy; pos[o + 2] = pz + sz; pos[o + 3] = px - sx; pos[o + 4] = py - sy; pos[o + 5] = pz - sz;
        col[o] = col[o + 3] = c[0] * v; col[o + 1] = col[o + 4] = c[1] * v; col[o + 2] = col[o + 5] = c[2] * v;
      }
    }
    built.position.needsUpdate = true; built.color.needsUpdate = true;
  });
  return <primitive object={built.mesh} />;
}

const glowVertex = /* glsl */ `
attribute vec3 aColor; attribute float aSize;
uniform float uScale; varying vec3 vColor;
void main() {
  vec4 mv = modelViewMatrix * vec4(position, 1.0);
  gl_Position = projectionMatrix * mv;
  gl_PointSize = clamp(aSize * uScale / max(0.1, -mv.z), 0.0, 220.0);
  vColor = aColor;
}`;
const glowFragment = /* glsl */ `
varying vec3 vColor;
void main() {
  float r = length(gl_PointCoord - 0.5) * 2.0;
  float a = pow(max(0.0, 1.0 - r), 2.2);
  gl_FragColor = vec4(vColor * a, 1.0);
}`;

const GLOW_COUNT = MOVER_DEFS.length;

function CrossingGlow({ engine }: { readonly engine: SimulationEngine }) {
  const { size, gl } = useThree();
  const D = moversFor(engine).disturbances.length;
  const built = useMemo(() => {
    const n = GLOW_COUNT + D;
    const geometry = new BufferGeometry();
    const position = new BufferAttribute(new Float32Array(n * 3), 3).setUsage(DynamicDrawUsage);
    const color = new BufferAttribute(new Float32Array(n * 3), 3).setUsage(DynamicDrawUsage);
    const sizes = new BufferAttribute(new Float32Array(n), 1).setUsage(DynamicDrawUsage);
    geometry.setAttribute('position', position); geometry.setAttribute('aColor', color); geometry.setAttribute('aSize', sizes);
    const material = new ShaderMaterial({ vertexShader: glowVertex, fragmentShader: glowFragment, uniforms: { uScale: { value: 500 } }, transparent: true, blending: AdditiveBlending, depthWrite: false, toneMapped: false });
    const points = new Points(geometry, material);
    points.frustumCulled = false; points.name = 'crossing-glow';
    return { points, geometry, material, position, color, sizes };
  }, [D]);
  useEffect(() => () => { built.geometry.dispose(); built.material.dispose(); }, [built]);
  useFrame(({ camera }) => {
    const system = moversFor(engine), states = system.states(), dstates = system.disturbanceStates();
    built.material.uniforms.uScale!.value = (size.height * gl.getPixelRatio()) / (2 * Math.tan((((camera as PerspectiveCamera).fov ?? 60) * Math.PI) / 360));
    const pos = built.position.array as Float32Array, col = built.color.array as Float32Array, sz = built.sizes.array as Float32Array;
    states.forEach((s, i) => {
      let best = -1, bestV = 0, total = 0;
      for (let d = 0; d < D; d += 1) { const v = system.influence[i * D + d]!; total += v; if (v > bestV) { bestV = v; best = d; } }
      const fold = system.foldActivity[i]!, act = Math.min(1, total * 1.4 + fold * 0.8);
      const c = fold > bestV ? FOLD_COLOR : PALETTE[Math.max(0, best) % PALETTE.length]!;
      pos[i * 3] = s.position[0]; pos[i * 3 + 1] = s.position[1]; pos[i * 3 + 2] = s.position[2];
      const k = act * 1.1;
      col[i * 3] = c[0] * k; col[i * 3 + 1] = c[1] * k; col[i * 3 + 2] = c[2] * k;
      sz[i] = act > 0.03 ? MOVER_DEFS[i]!.radius * (2.6 + 1.6 * act) : 0;
    });
    dstates.forEach((d, j) => {
      const o = (GLOW_COUNT + j) * 3, c = PALETTE[j % PALETTE.length]!, k = 0.3 + 0.5 * d.intensity;
      pos[o] = d.position[0]; pos[o + 1] = d.position[1]; pos[o + 2] = d.position[2];
      col[o] = c[0] * k; col[o + 1] = c[1] * k; col[o + 2] = c[2] * k;
      sz[GLOW_COUNT + j] = d.radius * 1.3;
    });
    built.position.needsUpdate = true; built.color.needsUpdate = true; built.sizes.needsUpdate = true;
  });
  return <primitive object={built.points} />;
}

/** Mounts the physics-readability layers. `?disable=trails,fieldlines,glow` removes them individually. */
export function PhysicsVisuals({ engine, trails, fieldLines, glow }: { readonly engine: SimulationEngine; readonly trails: boolean; readonly fieldLines: boolean; readonly glow: boolean }) {
  return <>{trails && <MoverTrails engine={engine} />}{fieldLines && <FlowLines engine={engine} />}{glow && <CrossingGlow engine={engine} />}</>;
}
