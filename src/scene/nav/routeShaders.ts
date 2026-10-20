import { AddEquation, CustomBlending, DoubleSide, OneFactor, OneMinusSrcAlphaFactor, ShaderMaterial, Vector2, Vector3 } from 'three';
import type { OverlayUniforms } from '../gas/overlay';
import { DASH } from './routeGeometry';

/** Shaders for the 3D route, drawn in the luminous overlay (composited AFTER the raymarched gas, before bloom).
 *
 * Why the overlay layer: the gas pass multiplies the opaque scene by the transmittance of the whole ray, so an ordinary scene line is hazed
 * away exactly where it matters (far legs, routes through the nebula). The overlay is not hazed; it tests the scene depth itself so rock and
 * wreckage still hide the route (a hidden stretch stays faintly visible), and it takes on only a small share of the gas transmittance at range,
 * so the route reads as an instrument layered on the world rather than as part of it. Nothing here writes depth.
 *
 * Ribbon widening happens in the vertex shader in view space, so the line keeps a constant screen width (about 3 px core) at any distance,
 * while the dash phase is carried as a world-metre arc length attribute (see routeGeometry.ts) and never depends on the camera. */

const COMMON = /* glsl */`
uniform sampler2D tSceneDepth, tGasFrame;
uniform vec2 uViewport;
uniform float uNear, uFar, uManualDepth;
uniform float uAlpha, uTime, uPx;
// Depth test against the scene (soft edge), leaving a faint ghost of hidden stretches, plus a small share of the gas transmittance at range.
float routeVisibility(float viewDistance, float hiddenShare) {
  vec2 uv = gl_FragCoord.xy / uViewport;
  float visible = 1.0;
  if (uManualDepth > 0.5) {
    float d = texture2D(tSceneDepth, uv).x;
    float sceneDistance = d >= 1.0 ? 1e9 : -perspectiveDepthToViewZ(d, uNear, uFar);
    visible = smoothstep(-0.5, 0.5, sceneDistance - viewDistance);
  }
  float T = texture2D(tGasFrame, uv).a;
  float gas = mix(1.0, max(T, 0.62), smoothstep(40.0, 240.0, viewDistance));
  return mix(hiddenShare, 1.0, visible) * gas;
}`;

const RIBBON_VERTEX = /* glsl */`
attribute vec3 aEnd;
attribute vec2 aCorner;
attribute vec2 aU;
uniform vec2 uViewport;
uniform float uHalfPx, uPx;
varying float vU, vSide, vDist;
void main() {
  vec3 p = mix(position, aEnd, aCorner.x);
  vec3 dir = aEnd - position;
  vec3 side = cross(dir, p - cameraPosition);
  float sl = length(side);
  side = sl > 1e-6 ? side / sl : vec3(0.0, 1.0, 0.0);
  vec4 mv = viewMatrix * vec4(p, 1.0);
  float d = max(-mv.z, 0.05);
  float worldPerPx = d / (projectionMatrix[1][1] * uViewport.y * 0.5);
  p += side * aCorner.y * uHalfPx * uPx * worldPerPx;
  vU = mix(aU.x, aU.y, aCorner.x);
  vSide = aCorner.y; vDist = d;
  gl_Position = projectionMatrix * viewMatrix * vec4(p, 1.0);
}`;

const RIBBON_FRAGMENT = /* glsl */`
#include <packing>
${COMMON}
uniform vec3 uColor;
uniform vec2 uDash;       // dash length, gap length: world metres
uniform float uPulseSpeed, uPulseLength, uPulseGain, uFadeNear;
varying float vU, vSide, vDist;
void main() {
  float period = uDash.x + uDash.y;
  float fw = max(fwidth(vU), 1e-4);
  float m = mod(vU, period);
  float aa = min(fw * 1.2, uDash.x * 0.35);
  float on = smoothstep(0.0, aa, m) * (1.0 - smoothstep(uDash.x - aa, uDash.x, m));
  // Past the point where a dash is only a couple of pixels long the pattern would alias: fade towards a continuous line.
  on = mix(0.5, on, smoothstep(2.0, 5.0, period / fw));
  float s = abs(vSide);
  float core = 1.0 - smoothstep(0.30, 0.42, s);
  // Dark violet keyline around the bright core: the line stays legible over pale nebula as well as over dark space.
  float rim = smoothstep(0.30, 0.42, s) * (1.0 - smoothstep(0.7, 1.0, s));
  float halo = exp(-s * s * 5.0);
  // A soft pulse travelling in the direction of flight (arc length u decreases along the flight).
  float ph = fract((vU + uTime * uPulseSpeed) / uPulseLength);
  float pulse = smoothstep(0.0, 0.04, ph) * exp(-ph * 7.0);
  float nearFade = smoothstep(uFadeNear * 0.25, uFadeNear, vDist);
  float k = on * uAlpha * nearFade * routeVisibility(vDist, 0.2);
  vec3 bright = uColor * (1.0 + uPulseGain * pulse) + vec3(0.25);
  float aCore = core * k, aRim = rim * 0.62 * k;
  vec3 rgb = bright * aCore + vec3(0.03, 0.0, 0.1) * aRim + uColor * halo * 0.22 * k;
  gl_FragColor = vec4(rgb, aCore + aRim);
}`;

const NODE_VERTEX = /* glsl */`
attribute vec2 aCorner;
attribute vec4 aInfo;     // half size (px), kind (0 dot, 2 rendezvous reticle, 3 region ring), state (0 ahead, 1 passed, 2 next), world radius
uniform vec2 uViewport;
uniform float uPx;
varying vec2 vUv;
varying float vKind, vState, vDist;
void main() {
  vec4 c = projectionMatrix * viewMatrix * vec4(position, 1.0);
  float size = aInfo.x;
  if (aInfo.y > 2.5) size = clamp(aInfo.w * projectionMatrix[1][1] * uViewport.y * 0.5 / max(c.w, 0.1) / uPx, aInfo.x, 150.0);
  c.xy += aCorner * size * uPx * 2.0 / uViewport * c.w;
  vUv = aCorner; vKind = aInfo.y; vState = aInfo.z; vDist = c.w;
  gl_Position = c;
}`;

const NODE_FRAGMENT = /* glsl */`
#include <packing>
${COMMON}
uniform vec3 uColor;
varying vec2 vUv;
varying float vKind, vState, vDist;
float band(float r, float c, float w) { float x = (r - c) / w; return exp(-x * x); }
void main() {
  float r = length(vUv);
  if (r > 1.0) discard;
  float a = 0.0;
  float pulse = 0.5 + 0.5 * sin(uTime * 3.0);
  if (vKind < 1.0) {
    float dot = 1.0 - smoothstep(0.26, 0.36, r);
    float ring = band(r, 0.66, 0.07) * (vState > 1.5 ? 0.55 + 0.45 * pulse : 0.0);
    a = dot * (vState > 0.5 && vState < 1.5 ? 0.3 : 0.9) + ring;
  } else if (vKind < 2.5) {
    float ang = uTime * 0.22;
    vec2 q = mat2(cos(ang), -sin(ang), sin(ang), cos(ang)) * vUv;
    float ring = band(r, 0.6, 0.045);
    float tick = max(smoothstep(0.045, 0.0, abs(q.x)) * step(0.7, abs(q.y)) * step(abs(q.y), 0.95), smoothstep(0.045, 0.0, abs(q.y)) * step(0.7, abs(q.x)) * step(abs(q.x), 0.95));
    float halo = exp(-r * 3.2) * (0.16 + 0.1 * pulse);
    float centre = 1.0 - smoothstep(0.045, 0.085, r);
    a = ring * 0.85 + tick * 0.95 + halo + centre * 0.9;
  } else {
    float ang = atan(vUv.y, vUv.x);
    float dashes = smoothstep(0.42, 0.5, abs(fract(ang * 1.9099 + uTime * 0.02) - 0.5) * 2.0);
    a = band(r, 0.9, 0.03) * dashes * 0.55 + exp(-r * r * 3.0) * 0.035;
  }
  float vis = uAlpha * routeVisibility(vDist, 0.25);
  a = min(a, 1.0) * vis;
  float back = vKind < 1.0 ? (1.0 - smoothstep(0.45, 0.8, r)) * 0.5 * vis : 0.0;
  gl_FragColor = vec4(uColor * a * 1.15 + vec3(0.03, 0.0, 0.1) * back, a + back * (1.0 - a));
}`;

const GHOST_VERTEX = /* glsl */`
varying vec3 vNormalV, vViewDir;
varying float vDist;
void main() {
  vec4 mv = modelViewMatrix * vec4(position, 1.0);
  vNormalV = normalize(normalMatrix * normal);
  vViewDir = normalize(-mv.xyz);
  vDist = -mv.z;
  gl_Position = projectionMatrix * mv;
}`;

const GHOST_FRAGMENT = /* glsl */`
#include <packing>
${COMMON}
uniform vec3 uColor;
varying vec3 vNormalV, vViewDir;
varying float vDist;
void main() {
  float fres = pow(1.0 - clamp(abs(dot(normalize(vNormalV), normalize(vViewDir))), 0.0, 1.0), 2.2);
  // Translucent hologram: a faint body that gains edge light, a slow travelling band so it never reads as the solid object.
  float band = 0.5 + 0.5 * sin(vDist * 0.0 + gl_FragCoord.y * 0.35 - uTime * 1.5);
  float a = (0.2 + 0.55 * fres + 0.05 * band) * uAlpha * routeVisibility(vDist, 0.35);
  gl_FragColor = vec4(uColor * (0.8 + 0.6 * fres) * a, a);
}`;

type Shared = Pick<OverlayUniforms, 'tSceneDepth' | 'tGasFrame' | 'uManualDepth' | 'uViewport' | 'uNear' | 'uFar'>;
const blend = { side: DoubleSide, transparent: true, depthWrite: false, depthTest: false, toneMapped: false, blending: CustomBlending, blendEquation: AddEquation, blendSrc: OneFactor, blendDst: OneMinusSrcAlphaFactor } as const;

/** Colours: luminous lavender / off-white, matching the Dimension's violet nebula rather than a warning colour. */
export const ROUTE_COLOR = new Vector3(0.82, 0.72, 1.0);
export const TARGET_PATH_COLOR = new Vector3(0.6, 0.62, 1.0);

export const widthPx = { core: 3.2, half: 5.0 } as const;
export const viewportOf = (u: Shared) => u.uViewport.value as Vector2;

export function ribbonMaterial(shared: Shared, opts: { color: Vector3; halfPx: number; dash?: readonly [number, number]; pulseGain?: number; fadeNear?: number }): ShaderMaterial {
  return new ShaderMaterial({
    vertexShader: RIBBON_VERTEX, fragmentShader: RIBBON_FRAGMENT, ...blend,
    uniforms: {
      ...shared, uAlpha: { value: 0 }, uTime: { value: 0 }, uPx: { value: 1 }, uColor: { value: opts.color.clone() }, uHalfPx: { value: opts.halfPx },
      uDash: { value: new Vector2(opts.dash?.[0] ?? DASH.on, opts.dash?.[1] ?? DASH.off) }, uPulseSpeed: { value: 14 }, uPulseLength: { value: 26 },
      uPulseGain: { value: opts.pulseGain ?? 0.9 }, uFadeNear: { value: opts.fadeNear ?? 9 },
    },
  });
}
export function nodeMaterial(shared: Shared): ShaderMaterial {
  return new ShaderMaterial({ vertexShader: NODE_VERTEX, fragmentShader: NODE_FRAGMENT, ...blend, uniforms: { ...shared, uAlpha: { value: 0 }, uTime: { value: 0 }, uPx: { value: 1 }, uColor: { value: ROUTE_COLOR.clone() } } });
}
export function ghostMaterial(shared: Shared): ShaderMaterial {
  return new ShaderMaterial({ vertexShader: GHOST_VERTEX, fragmentShader: GHOST_FRAGMENT, ...blend, uniforms: { ...shared, uAlpha: { value: 0 }, uTime: { value: 0 }, uPx: { value: 1 }, uColor: { value: new Vector3(0.72, 0.66, 1.0) } } });
}
