import { useEffect, useMemo } from 'react';
import { createPortal, useFrame } from '@react-three/fiber';
import { BufferAttribute, BufferGeometry, CustomBlending, Mesh, OneFactor, OneMinusSrcAlphaFactor, ShaderMaterial, AddEquation } from 'three';
import type { SimulationEngine } from '../../simulation/simulationEngine';
import { cachedPlacementInputs } from '../assets/DimensionAssets';
import { OVERLAY_FRAGMENT } from '../gas/overlay';
import type { Overlay } from '../gas/overlay';
import { layoutTears } from './tearLayout';
import type { Tear } from './tearLayout';

/** Cosmetic spatial tears (see tearLayout.ts for the two classes and placement
 * rules). One draw in the luminous overlay: planar world-space quads (so they
 * parallax like real structure), shaded procedurally. Premultiplied blending lets a
 * rift's void darken what lies behind it while its lips and glow add light; a
 * shear shows the gas frame displaced across the band. Motion is slow (lip shimmer,
 * breathing width, drifting void streaks) and uses engine.clock.time only. */

const VERTEX = /* glsl */`
attribute vec2 aCorner;   // (-1..1 along, -1..1 across)
attribute vec3 aAxis, aNormal;
attribute vec4 aShape;    // half length, half width, seed, kind (0 rift, 1 shear)
attribute float aIntensity;
varying vec2 vUv;
varying float vSeed, vKind, vIntensity, vViewDistance, vFacing;
varying vec2 vShift;
const float SPAN = 2.6; // quad half-height in units of the slit half-width (room for glow)
void main() {
  vec3 across = normalize(cross(aNormal, aAxis));
  vec3 world = position + aAxis * aCorner.x * aShape.x * 1.06 + across * aCorner.y * aShape.y * SPAN;
  vUv = vec2(aCorner.x * 1.06, aCorner.y * SPAN);
  vSeed = aShape.z; vKind = aShape.w; vIntensity = aIntensity;
  vec3 toCamera = cameraPosition - world;
  vFacing = abs(dot(normalize(toCamera), aNormal));
  vec4 mv = viewMatrix * vec4(world, 1.0);
  vViewDistance = -mv.z;
  // Screen-space displacement direction for shears: across the band.
  vec4 a = projectionMatrix * viewMatrix * vec4(world, 1.0), b = projectionMatrix * viewMatrix * vec4(world + across, 1.0);
  vShift = normalize(b.xy / b.w - a.xy / a.w + 1e-5);
  gl_Position = projectionMatrix * mv;
}`;

const FRAGMENT = /* glsl */`
#include <packing>
${OVERLAY_FRAGMENT}
uniform float uTime;
varying vec2 vUv;
varying float vSeed, vKind, vIntensity, vViewDistance, vFacing;
varying vec2 vShift;
float tri(float x) { return abs(fract(x) - 0.5) * 4.0 - 1.0; }
float hash(vec2 p) { return fract(sin(dot(p, vec2(127.1, 311.7))) * 43758.5453); }
float h1(float n) { return fract(sin(n) * 43758.5453); }
// 1-D value noise in [-1, 1] with sharp (non-smooth) joints: broken, irregular edges.
float vnoise(float x) { float i = floor(x), f = fract(x); return mix(h1(i), h1(i + 1.0), f) * 2.0 - 1.0; }
void main() {
  float x = vUv.x, y = vUv.y, s = vSeed;
  float env = max(1.0 - x * x, 0.0);
  // Centre line: gentle bends and a few angular kinks (shattered, not organic, not periodic).
  float yc = (0.5 * sin(x * 1.9 + s) + 0.25 * sin(x * 4.3 + s * 1.7)) * 0.22 + vnoise(x * 3.0 + s) * 0.12 + vnoise(x * 8.0 + s * 3.1) * 0.035;
  // Lens taper with an irregular lip: wide, ragged belly; hairline tips.
  float rag = 0.62 + 0.26 * vnoise(x * 7.0 + s * 2.0) + 0.12 * vnoise(x * 23.0 + s * 5.0) + 0.04 * sin(x * 37.0 + uTime * 0.3 + s);
  float w = 0.78 * pow(env, 1.35) * rag * (0.97 + 0.03 * sin(uTime * 0.2 + s));
  // Each lip is ragged independently, so the opening is not symmetric.
  float side = y - yc;
  w *= 1.0 + 0.22 * vnoise(x * 11.0 + s * (side > 0.0 ? 7.0 : 13.0));
  float d = abs(side) - w;           // signed distance to the lip (slit half-width units)
  float inside = 1.0 - smoothstep(-0.03, 0.025, d);
  float tip = smoothstep(0.0, 0.25, env);
  float rim = exp(-abs(d) * 30.0) * tip * (0.65 + 0.35 * vnoise(x * 17.0 + s + uTime * 0.05));
  float glow = exp(-max(d, 0.0) * 1.6) * pow(env, 0.8) * (1.0 - inside * 0.7);
  float k = vIntensity * smoothstep(0.08, 0.35, vFacing);
  vec2 suv = gl_FragCoord.xy / uViewport;
  // Distant rifts keep a floor of visibility through the gas: landmarks, not detail.
  float T = texture2D(tGasFrame, suv).a;
  float occlusion = overlayVisibility(vViewDistance) / mix(1.0, max(T, 0.12), smoothstep(12.0, 170.0, vViewDistance));
  float vis = occlusion * mix(1.0, max(T, 0.45), smoothstep(30.0, 240.0, vViewDistance));
  vec3 hot = vec3(1.0, 0.88, 1.0), halo = vec3(0.72, 0.2, 0.92);
  vec3 col; float alpha;
  if (vKind < 0.5) {
    // Rift: a dark void with faint drifting streaks and a few cold points: space behind space.
    float streak = smoothstep(0.55, 1.0, sin((x * 6.0 + y * 1.5) + uTime * 0.03 + s) * 0.5 + 0.5) * smoothstep(0.0, -0.6, d);
    float star = step(0.993, hash(floor(vec2(x * 90.0, y * 24.0) + s)));
    vec3 voidCol = vec3(0.012, 0.004, 0.035) + vec3(0.16, 0.06, 0.32) * streak * 0.35 + vec3(0.6, 0.55, 1.0) * star * 0.5;
    col = voidCol * inside + hot * rim * 1.4 + halo * glow * 0.42;
    alpha = inside * 0.96;
  } else {
    // Shear: the gas behind, displaced across the band (a sheared layer of space).
    vec3 shifted = texture2D(tGasFrame, suv + vShift * 0.018 * sign(y - yc + 1e-4)).rgb;
    col = shifted * 1.15 * inside + hot * rim * 1.1 + halo * glow * 0.22;
    alpha = inside * 0.85;
  }
  gl_FragColor = vec4(col * k * vis, alpha * k * vis);
}`;

function buildGeometry(tears: readonly Tear[]): BufferGeometry {
  const n = tears.length, corners = [[-1, -1], [1, -1], [1, 1], [-1, 1]];
  const position = new Float32Array(n * 12), corner = new Float32Array(n * 8), axis = new Float32Array(n * 12), normal = new Float32Array(n * 12), shape = new Float32Array(n * 16), intensity = new Float32Array(n * 4);
  const index = new Uint32Array(n * 6);
  tears.forEach((t, i) => {
    corners.forEach((c, k) => {
      const j = i * 4 + k;
      position.set(t.centre, j * 3); corner.set(c, j * 2); axis.set(t.axis, j * 3); normal.set(t.normal, j * 3);
      shape.set([t.halfLength, t.halfWidth, t.seed, t.kind === 'rift' ? 0 : 1], j * 4); intensity[j] = t.intensity;
    });
    index.set([i * 4, i * 4 + 1, i * 4 + 2, i * 4, i * 4 + 2, i * 4 + 3], i * 6);
  });
  const g = new BufferGeometry();
  g.setAttribute('position', new BufferAttribute(position, 3));
  g.setAttribute('aCorner', new BufferAttribute(corner, 2));
  g.setAttribute('aAxis', new BufferAttribute(axis, 3));
  g.setAttribute('aNormal', new BufferAttribute(normal, 3));
  g.setAttribute('aShape', new BufferAttribute(shape, 4));
  g.setAttribute('aIntensity', new BufferAttribute(intensity, 1));
  g.setIndex(new BufferAttribute(index, 1));
  return g;
}

const tearCache = new WeakMap<SimulationEngine, Tear[]>();
/** The deterministic tear layout for an engine (seeded; independent of quality). */
export function cachedTears(engine: SimulationEngine): Tear[] {
  let t = tearCache.get(engine);
  if (!t) { t = layoutTears(engine.seed, cachedPlacementInputs(engine)); tearCache.set(engine, t); }
  return t;
}

export function SpatialTears({ engine, overlay }: { readonly engine: SimulationEngine; readonly overlay: Overlay }) {
  const built = useMemo(() => {
    const time = { value: 0 };
    const material = new ShaderMaterial({
      vertexShader: VERTEX, fragmentShader: FRAGMENT, transparent: true, depthWrite: false, depthTest: true, toneMapped: false,
      blending: CustomBlending, blendEquation: AddEquation, blendSrc: OneFactor, blendDst: OneMinusSrcAlphaFactor,
      uniforms: { ...overlay.uniforms, uTime: time },
    });
    const mesh = new Mesh(buildGeometry(cachedTears(engine)), material);
    mesh.name = 'cosmetic-tears'; mesh.frustumCulled = false; mesh.renderOrder = 1;
    return { mesh, material, time };
  }, [engine, overlay]);
  useEffect(() => () => { built.mesh.geometry.dispose(); built.material.dispose(); }, [built]);
  useFrame(() => { built.time.value = engine.clock.time; });
  return createPortal(<primitive object={built.mesh} />, overlay.scene);
}
