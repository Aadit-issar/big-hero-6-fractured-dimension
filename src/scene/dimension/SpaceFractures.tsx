import { useEffect, useMemo } from 'react';
import { createPortal, useFrame, useThree } from '@react-three/fiber';
import { AdditiveBlending, BufferAttribute, BufferGeometry, Points, ShaderMaterial, Mesh } from 'three';
import type { PerspectiveCamera } from 'three';
import { createSeededRandom } from '../../simulation/seededRandom';
import type { SimulationEngine } from '../../simulation/simulationEngine';
import { cachedPlacementInputs } from '../assets/DimensionAssets';
import { OVERLAY_FRAGMENT } from '../gas/overlay';
import type { Overlay } from '../gas/overlay';
import { layoutFractures } from './fractureLayout';
import type { Fracture } from './fractureLayout';

/** Cosmetic, non-traversable spatial fractures (see fractureLayout.ts for the
 * visual language and placement rules). One ribbon draw and one spark draw in the
 * luminous overlay; camera-facing ribbons with a minimum on-screen width, so thin
 * lines stay legible without aliasing. Motion (a slow breath and a travelling
 * glint, sparks drifting along the cracks) uses engine.clock.time only. */

const RIBBON_VERTEX = /* glsl */`
attribute vec3 aOther;
attribute vec4 aShape; // side (±1), core width, glow width, intensity
attribute vec3 aPath;  // along (0..1 within the network), phase, echo
uniform float uPixelAngle;
varying float vSide, vCoreFrac, vIntensity, vAlong, vPhase, vEcho, vViewDistance, vNear;
void main() {
  vec3 world = (modelMatrix * vec4(position, 1.0)).xyz;
  vec3 other = (modelMatrix * vec4(aOther, 1.0)).xyz;
  vec3 tangent = normalize(other - world);
  vec3 toCamera = cameraPosition - world;
  float dist = length(toCamera);
  vec3 across = normalize(cross(tangent, toCamera / max(dist, 1e-3)));
  float pixel = dist * uPixelAngle;
  // Tapered tears: widest mid-network, hairline at the tips.
  float taper = 0.3 + 0.7 * sin(3.14159 * clamp(aPath.x, 0.0, 1.0));
  float glow = max(aShape.z * taper * 1.6, 9.0 * pixel), core = max(aShape.y * taper * 1.4, 1.8 * pixel);
  vCoreFrac = min(1.0, core / glow);
  vSide = aShape.x;
  vIntensity = aShape.w;
  vAlong = aPath.x; vPhase = aPath.y; vEcho = aPath.z;
  vNear = smoothstep(1.5, 6.0, dist);
  vec4 mv = viewMatrix * vec4(world + across * aShape.x * glow * 0.5, 1.0);
  vViewDistance = -mv.z;
  gl_Position = projectionMatrix * mv;
}`;

const RIBBON_FRAGMENT = /* glsl */`
#include <packing>
${OVERLAY_FRAGMENT}
uniform float uTime;
varying float vSide, vCoreFrac, vIntensity, vAlong, vPhase, vEcho, vViewDistance, vNear;
void main() {
  float x = abs(vSide);
  float core = 1.0 - smoothstep(0.0, vCoreFrac, x);
  float glow = exp(-x * x * 6.0);
  // Slow breath (≈ 18 s) and a glint travelling along the crack (≈ 40 s per pass).
  float breath = 0.78 + 0.22 * sin(uTime * 0.35 + vPhase);
  float glint = exp(-pow(fract(vAlong * 0.8 - uTime * 0.025 + vPhase * 0.159) - 0.5, 2.0) * 90.0);
  vec3 hot = mix(vec3(1.0, 0.86, 1.0), vec3(0.62, 0.78, 1.25), vEcho);
  vec3 halo = mix(vec3(0.62, 0.22, 0.95), vec3(0.3, 0.42, 1.0), vEcho);
  vec3 col = hot * core * (0.6 + glint * 0.4) + halo * glow * 0.32;
  float k = vIntensity * breath * vNear * overlayVisibility(vViewDistance);
  gl_FragColor = vec4(col * k, 1.0);
}`;

const SPARK_VERTEX = /* glsl */`
attribute vec3 aDrift; // drift direction × speed (m/s)
attribute float aSeed;
uniform float uTime, uPixelAngle;
varying float vAlpha, vViewDistance;
void main() {
  // Sparks slide slowly along their crack and wrap within ± 1.5 m (no escape).
  float travel = mod(uTime * 0.06 + aSeed * 3.0, 3.0) - 1.5;
  vec3 world = (modelMatrix * vec4(position, 1.0)).xyz + aDrift * travel;
  vec4 mv = viewMatrix * vec4(world, 1.0);
  vViewDistance = -mv.z;
  vAlpha = (1.0 - abs(travel) / 1.5) * (0.55 + 0.45 * sin(uTime * 0.9 + aSeed * 40.0));
  gl_PointSize = clamp(0.09 / max(vViewDistance * uPixelAngle, 1e-4), 1.5, 6.0);
  gl_Position = projectionMatrix * mv;
}`;
const SPARK_FRAGMENT = /* glsl */`
#include <packing>
${OVERLAY_FRAGMENT}
varying float vAlpha, vViewDistance;
void main() {
  vec2 c = gl_PointCoord * 2.0 - 1.0;
  float a = exp(-dot(c, c) * 4.0) * vAlpha * overlayVisibility(vViewDistance);
  gl_FragColor = vec4(vec3(1.0, 0.8, 1.0) * a * 1.2, 1.0);
}`;

function buildRibbons(fractures: readonly Fracture[]): BufferGeometry {
  const n = fractures.reduce((k, f) => k + f.segments.length, 0);
  const position = new Float32Array(n * 12), other = new Float32Array(n * 12), shape = new Float32Array(n * 16), path = new Float32Array(n * 12);
  const index = new Uint32Array(n * 6);
  let s = 0;
  for (const f of fractures) for (const seg of f.segments) {
    // Four vertices: (a,-), (a,+), (b,-), (b,+); each knows the opposite endpoint.
    const verts: Array<[readonly number[], readonly number[], number, number]> = [[seg.a, seg.b, -1, seg.s0], [seg.a, seg.b, 1, seg.s0], [seg.b, seg.a, 1, seg.s1], [seg.b, seg.a, -1, seg.s1]];
    verts.forEach(([p, o, side, along], k) => {
      const i = s * 4 + k;
      position.set(p, i * 3); other.set(o, i * 3);
      shape.set([side, seg.core, seg.glow, seg.intensity], i * 4);
      path.set([along, f.phase, seg.echo ? 1 : 0], i * 3);
    });
    index.set([s * 4, s * 4 + 1, s * 4 + 2, s * 4, s * 4 + 2, s * 4 + 3], s * 6);
    s += 1;
  }
  const g = new BufferGeometry();
  g.setAttribute('position', new BufferAttribute(position, 3));
  g.setAttribute('aOther', new BufferAttribute(other, 3));
  g.setAttribute('aShape', new BufferAttribute(shape, 4));
  g.setAttribute('aPath', new BufferAttribute(path, 3));
  g.setIndex(new BufferAttribute(index, 1));
  g.computeBoundingSphere();
  return g;
}

function buildSparks(fractures: readonly Fracture[], seed: number): BufferGeometry {
  const r = createSeededRandom(seed ^ 0x5a4c5);
  const pos: number[] = [], drift: number[] = [], seeds: number[] = [];
  for (const f of fractures) for (const seg of f.segments) {
    if (seg.echo) continue;
    const dx = seg.b[0] - seg.a[0], dy = seg.b[1] - seg.a[1], dz = seg.b[2] - seg.a[2], len = Math.hypot(dx, dy, dz);
    const count = Math.min(24, Math.round(len / (2.5 * Math.max(1, seg.glow))));
    for (let k = 0; k < count; k += 1) {
      const t = r(), off = seg.glow * 0.6;
      pos.push(seg.a[0] + dx * t + (r() - 0.5) * off, seg.a[1] + dy * t + (r() - 0.5) * off, seg.a[2] + dz * t + (r() - 0.5) * off);
      const dir = r() < 0.5 ? -1 : 1;
      drift.push((dx / len) * dir, (dy / len) * dir, (dz / len) * dir);
      seeds.push(r());
    }
  }
  const g = new BufferGeometry();
  g.setAttribute('position', new BufferAttribute(new Float32Array(pos), 3));
  g.setAttribute('aDrift', new BufferAttribute(new Float32Array(drift), 3));
  g.setAttribute('aSeed', new BufferAttribute(new Float32Array(seeds), 1));
  g.computeBoundingSphere();
  return g;
}

const fractureCache = new WeakMap<SimulationEngine, Fracture[]>();
/** The deterministic fracture layout for an engine (seeded; independent of quality). */
export function cachedFractures(engine: SimulationEngine): Fracture[] {
  let f = fractureCache.get(engine);
  if (!f) { f = layoutFractures(engine.seed, cachedPlacementInputs(engine)); fractureCache.set(engine, f); }
  return f;
}

export function SpaceFractures({ engine, overlay }: { readonly engine: SimulationEngine; readonly overlay: Overlay }) {
  const { camera, size } = useThree();
  const built = useMemo(() => {
    const fractures = cachedFractures(engine);
    const time = { value: 0 }, pixel = { value: 0.002 };
    const common = { transparent: true, depthWrite: false, depthTest: true, blending: AdditiveBlending, toneMapped: false };
    const ribbonMaterial = new ShaderMaterial({ ...common, vertexShader: RIBBON_VERTEX, fragmentShader: RIBBON_FRAGMENT, uniforms: { ...overlay.uniforms, uTime: time, uPixelAngle: pixel } });
    const sparkMaterial = new ShaderMaterial({ ...common, vertexShader: SPARK_VERTEX, fragmentShader: SPARK_FRAGMENT, uniforms: { ...overlay.uniforms, uTime: time, uPixelAngle: pixel } });
    const ribbons = new Mesh(buildRibbons(fractures), ribbonMaterial);
    ribbons.name = 'cosmetic-fractures'; ribbons.frustumCulled = false; ribbons.renderOrder = 2;
    const sparks = new Points(buildSparks(fractures, engine.seed), sparkMaterial);
    sparks.name = 'fracture-sparks'; sparks.frustumCulled = false; sparks.renderOrder = 2;
    return { ribbons, sparks, time, pixel, materials: [ribbonMaterial, sparkMaterial] };
  }, [engine, overlay]);
  useEffect(() => () => {
    built.ribbons.geometry.dispose(); built.sparks.geometry.dispose();
    built.materials.forEach((m) => m.dispose());
  }, [built]);
  useFrame(() => {
    built.time.value = engine.clock.time;
    const fov = (camera as PerspectiveCamera).fov ?? 56;
    built.pixel.value = 2 * Math.tan((fov * Math.PI) / 360) / Math.max(1, size.height);
  });
  return createPortal(<><primitive object={built.ribbons} /><primitive object={built.sparks} /></>, overlay.scene);
}
