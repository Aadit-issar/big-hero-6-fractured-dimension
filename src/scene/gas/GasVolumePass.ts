import { Data3DTexture, HalfFloatType, LinearFilter, LinearMipmapLinearFilter, Matrix4, RepeatWrapping, RGFormat, ShaderMaterial, UnsignedByteType, Vector2, Vector3, Vector4, WebGLRenderTarget } from 'three';
import type { PerspectiveCamera, WebGLRenderer } from 'three';
import { FullScreenQuad, Pass } from 'three/examples/jsm/postprocessing/Pass.js';

export const MAX_ISLANDS = 14;
export const MAX_FOLDS = 8;
export const MAX_HAZARDS = 4;
/** Spatial shears: 4 from real fold connections (entry↔exit), 2 from field strain. */
export const MAX_SHEARS = 6;

const VERTEX = /* glsl */`varying vec2 vUv; void main() { vUv = uv; gl_Position = vec4(position.xy, 0.0, 1.0); }`;

/** Cloud style. 'sky' (default): slow drift, coherent large forms with defined edges,
 * light-side self-shadowing, a lighter blur and a motion-safe interleave. 'legacy' is the
 * Phase 5 look, selected with ?clouds=legacy (numerically identical to the previous shaders). */
export const CLOUD_STYLE: 'sky' | 'legacy' = (() => {
  try { return new URLSearchParams(window.location.search).get('clouds') === 'legacy' ? 'legacy' : 'sky'; } catch { return 'sky'; }
})();
const STYLE_DEFINES: Record<string, string> = CLOUD_STYLE === 'sky' ? { SKY_CLOUDS: '' } : {};

/** Raymarched dimensional gas. Density = baked tileable Perlin–Worley noise,
 * domain-warped, twisted into a whirlpool around the vortex axis, folded into a
 * mirrored corridor, and carved by simulation state: clearings around the live
 * island transforms, passages around open fold endpoints, extra turbulence and
 * brightness at sampled hazard points, and spatial shears: across a plane through
 * each real fold endpoint the gas domain is displaced by the connection's own
 * exit − entry offset (an echo of the far side, tinted cool, bounded by a
 * luminous seam), and
 * at strained hazard sites by the sampled compression (no seam, so it never reads
 * as a connection). Self-luminous emission (no shadow rays)
 * plus a one-tap directional gradient for light-facing crests. */
const MARCH = /* glsl */`
precision highp float;
precision highp sampler3D;
#include <packing>
uniform sampler2D tDepth;
uniform sampler3D uNoise;
uniform float uParity, uFullWidth;
uniform float cameraNear, cameraFar, uTime, uCoverage, uSigma, uScale, uMaxDistance, uJitter, uPixelAngle;
uniform mat4 uProjInv, uCamWorld;
uniform vec3 uCamPos, uVortex, uAxis, uLight, uFieldCentre;
uniform vec4 uIslands[${MAX_ISLANDS}];
uniform vec4 uFolds[${MAX_FOLDS}];
uniform vec4 uHazards[${MAX_HAZARDS}];
// Shear: A = centre xyz, weight; B = displacement xyz, radius; N = plane normal xyz, seam strength.
uniform vec4 uShearA[${MAX_SHEARS}], uShearB[${MAX_SHEARS}], uShearN[${MAX_SHEARS}];
varying vec2 vUv;

#ifdef SKY_CLOUDS
// Sky clouds: drift slowly (features no longer crawl several percent of their size per
// frame), wind up the whirlpool slowly, and carry more of their shape in the large scale.
#define WHIRL_RATE 0.012
#define WIND vec3(0.12, 0.02, 0.32)
#define BASE_W 0.8
#define EDGE 0.15
#define BASE_FREQ 0.34
#define DETAIL_FREQ 1.1
#else
#define WHIRL_RATE 0.035
#define WIND vec3(0.25, 0.05, 0.9)
#define BASE_W 0.58
#define EDGE 0.13
#define BASE_FREQ 0.42
#define DETAIL_FREQ 1.55
#endif

// Unstructured per-pixel dither (IGN's diagonal pattern showed through the
// half-resolution upsample); the composite tent filter blends it into grain.
float dither(vec2 p) { vec3 p3 = fract(vec3(p.xyx) * 0.1031); p3 += dot(p3, p3.yzx + 33.33); return fract((p3.x + p3.y) * p3.z); }

// Domain displacement of all shears at p. fold.x accumulates the luminous seam
// plane and fold.y the displaced (echo) half-space; both only for fold shears.
vec3 shear(vec3 p, inout vec2 fold) {
  vec3 o = vec3(0.0);
  for (int i = 0; i < ${MAX_SHEARS}; i++) {
    vec3 d = p - uShearA[i].xyz;
    float fall = uShearA[i].w * (1.0 - smoothstep(0.35, 1.0, length(d) / uShearB[i].w));
    if (fall <= 0.0) continue;
    float side = dot(d, uShearN[i].xyz);
    // A narrow transition: a clean cut rather than noise stretched along the offset.
    float displaced = smoothstep(-0.15, 0.15, side);
    o += uShearB[i].xyz * displaced * fall;
    // Seam σ ≈ 3 m: comparable to the march step at fold distances, so it is not skipped.
    fold += uShearN[i].w * fall * vec2(exp(-side * side * 0.055), displaced);
  }
  return o;
}

// Returns density; writes colour-shaping terms. Carving uses the true position p;
// the cloud structure is looked up at the sheared position.
float gas(vec3 p, float t, out float shade, out float crest, out float energy, out float passage, out vec2 fold) {
  fold = vec2(0.0);
  vec3 ps = p + shear(p, fold);
  vec3 rel = ps - uVortex;
  float along = dot(rel, uAxis);
  vec3 radial = rel - uAxis * along;
  float rr = length(radial);
  // Whirlpool: stronger twist near the vortex axis, slow model-time rotation.
  float ang = 2.1 * exp(-rr / 80.0) * exp(-abs(along) / 260.0) + uTime * WHIRL_RATE * exp(-length(rel) / 260.0);
  vec3 q = uVortex + uAxis * along + radial * cos(ang) + cross(uAxis, radial) * sin(ang);
  // Region B: the entrance corridor folds onto itself (mirrored cloud walls).
  float corridor = smoothstep(26.0, 46.0, q.z);
  q.x = mix(q.x, -3.0 + abs(q.x + 3.0) * 1.0, corridor);
  q.y = mix(q.y, 9.0 + abs(q.y - 9.0), corridor * 0.7);
  q += WIND * uTime;

  float turb = 0.0;
  energy = 0.0;
  passage = 0.0;
  vec3 tq = q * uScale;
  // Explicit LOD from ray distance: one march sample spans this many texels.
  // (Implicit derivatives are undefined inside the divergent march loop.)
  float footprint = max(t, 1.0) * uPixelAngle * 128.0 * uScale;
  float lodBig = log2(max(1.0, footprint * BASE_FREQ)), lodDetail = log2(max(1.0, footprint * DETAIL_FREQ));
  vec2 big = textureLod(uNoise, tq * BASE_FREQ, lodBig).rg;
  shade = big.g; crest = 0.0;
  // Early out: even full detail cannot lift this sample over the coverage threshold.
  if (big.r * BASE_W + (1.0 - BASE_W) < uCoverage) return 0.0;
  // Region C: hazard-driven turbulence (sampled simulation instability), only for
  // samples that survive the coverage early-out (identical result, less work).
  for (int i = 0; i < ${MAX_HAZARDS}; i++) {
    vec3 dh = p - uHazards[i].xyz;
    float k = uHazards[i].w * exp(-dot(dh, dh) / 2600.0);
    turb += k; energy += k * 0.6;
  }
  vec3 wq = tq * DETAIL_FREQ + (big.g - 0.5) * (0.35 + turb * 0.9) * vec3(1.0, 0.55, 1.25) + vec3(0.0, uTime * 0.0015, 0.0);
  float detail = textureLod(uNoise, wq, lodDetail).r;
  float shape = big.r * BASE_W + detail * (1.0 - BASE_W);
  float dens = smoothstep(uCoverage, uCoverage + EDGE, shape);
  if (dens <= 0.0) return 0.0;

  // Carve: camera bubble, islands (live transforms), open folds, vortex cavity.
  dens *= smoothstep(8.0, 36.0, length(p - uCamPos));
  for (int i = 0; i < ${MAX_ISLANDS}; i++) {
    float d = length(p - uIslands[i].xyz);
    dens *= smoothstep(uIslands[i].w + 2.0, uIslands[i].w + 20.0, d);
  }
  for (int i = 0; i < ${MAX_FOLDS}; i++) {
    float d = length(p - uFolds[i].xyz);
    // Region D: real open connections part the gas into a passage rimmed with light.
    dens *= mix(1.0, smoothstep(7.0, 30.0, d), uFolds[i].w);
    float pr = (d - 26.0) * 0.125;
    passage += uFolds[i].w * exp(-pr * pr);
  }
  vec3 seg = uVortex - uFieldCentre;
  float h = clamp(dot(p - uFieldCentre, seg) / dot(seg, seg), 0.0, 1.0);
  float cavity = length(p - uFieldCentre - seg * h);
  dens *= mix(0.12, 1.0, smoothstep(18.0, 70.0 + h * 40.0, cavity));
  // Light-facing crest (only for visible samples): density falls toward the light.
  if (dens > 0.002) {
#ifdef SKY_CLOUDS
    // Light the large forms: the base-scale gradient toward the light sets the bright
    // sunward side, detail adds only a little edge texture (a strong detail gradient
    // read as speckle), and more cloud toward the light shades the sample (self-shadow).
    float toward = textureLod(uNoise, tq * BASE_FREQ + uLight * 0.035, lodBig).r;
    float detailToward = textureLod(uNoise, wq + uLight * 0.03, lodDetail).r;
    crest = smoothstep(0.32, 0.95, 0.42 + (big.r - toward) * 4.0 + (detail - detailToward) * 1.2);
    crest *= mix(0.35, 1.0, exp(-max(0.0, toward - big.r) * 6.0));
#else
    float shifted = textureLod(uNoise, wq + uLight * 0.03, lodDetail).r * 0.42 + big.r * 0.58;
    crest = smoothstep(0.35, 0.95, 0.5 + (shape - shifted) * 7.0);
#endif
  }
  return dens;
}

void main() {
  // Interleaved columns: this half-width target holds full-resolution columns 2k + parity;
  // INTERLEAVE merges it with last frame's other half (see GasVolumePass.render).
  vec2 uvM = vec2((floor(gl_FragCoord.x) * 2.0 + uParity + 0.5) / uFullWidth, vUv.y);
  vec4 ndc = vec4(uvM * 2.0 - 1.0, 1.0, 1.0);
  vec4 view = uProjInv * ndc; view /= view.w;
  vec3 dirView = normalize(view.xyz);
  vec3 dir = normalize((uCamWorld * vec4(dirView, 0.0)).xyz);
  float depth = texture(tDepth, uvM).x;
  float sceneT = depth >= 1.0 ? 1e9 : (-perspectiveDepthToViewZ(depth, cameraNear, cameraFar)) / max(1e-4, -dirView.z);
  float tEnd = min(sceneT, uMaxDistance);
  float jitter = dither(gl_FragCoord.xy + uJitter);
  vec3 col = vec3(0.0);
  float T = 1.0;
  // Saturated, deliberately low-energy emission: richness over brightness.
#ifdef SKY_CLOUDS
  // Forward scattering: crests looking toward the light glow (silver lining).
  float phase = 0.8 + 0.7 * pow(max(dot(dir, uLight), 0.0), 6.0);
#else
  float phase = 1.0;
#endif
  vec3 indigo = vec3(0.02, 0.012, 0.11), cobalt = vec3(0.025, 0.07, 0.48), violet = vec3(0.26, 0.035, 0.58), magenta = vec3(0.6, 0.03, 0.46), pink = vec3(0.85, 0.16, 0.6), warm = vec3(0.9, 0.42, 0.3);
  for (int i = 0; i < STEPS; i++) {
    float f0 = (float(i) + jitter) / float(STEPS), f1 = (float(i) + 1.0 + jitter) / float(STEPS);
    float t = tEnd * f0 * f0, dt = tEnd * (f1 * f1 - f0 * f0);
    vec3 p = uCamPos + dir * t;
    float shade, crest, energy, passage;
    vec2 fold;
    float d = gas(p, t, shade, crest, energy, passage, fold);
    if (d > 0.002) {
      float vortexGlow = exp(-length(p - uVortex) / 110.0);
      vec3 body = mix(mix(indigo, cobalt, smoothstep(0.2, 0.5, shade)), violet, smoothstep(0.5, 0.75, shade));
      // Echoed gas across a fold shear reads cooler: displaced space, not new matter.
      body = mix(body, body * vec3(0.55, 0.95, 1.6) + vec3(0.0, 0.01, 0.05), min(fold.y, 1.0) * 0.7);
      // Peach/warm only near the vortex; elsewhere crests stay magenta to pink.
      vec3 lit = mix(mix(violet, magenta, crest), pink, crest * crest * crest);
      lit = mix(lit, warm, vortexGlow * crest);
      float edge = d * (1.0 - d) * 4.0;
      // Dark bodies, luminous light-facing crests and rims: contrast carries volume.
      // Simulation energy (hazard, open folds) brightens crests, never flat fog.
      float glowK = crest * phase * (1.0 + energy * 2.5);
      vec3 emit = body * (0.28 + 0.3 * d) + lit * glowK * (0.42 + 0.8 * edge) + warm * vortexGlow * (0.15 + 0.35 * crest)
        + vec3(0.42, 0.55, 1.0) * passage * (0.1 + 0.4 * crest) + vec3(0.75, 0.6, 1.0) * fold.x * (0.35 + 0.9 * crest);
      float a = 1.0 - exp(-d * uSigma * dt);
      col += T * a * emit;
      T *= 1.0 - a;
      if (T < 0.015) break;
    }
  }
  gl_FragColor = vec4(col, T);
}`;

// Rebuilds the full-width gas frame from the two half-width column sets: this frame's
// (columns 2k + parity) and the previous frame's (the other parity).
const INTERLEAVE = /* glsl */`
uniform sampler2D tCur, tPrev;
uniform float uParity, uFullWidth, uHistoryValid;
varying vec2 vUv;
void main() {
  float x = floor(vUv.x * uFullWidth);
  vec2 uv = vec2((floor(x * 0.5) + 0.5) / (uFullWidth * 0.5), vUv.y);
  bool mine = mod(x, 2.0) == uParity || uHistoryValid < 0.5;
#ifdef SKY_CLOUDS
  if (mine) { gl_FragColor = texture2D(tCur, uv); return; }
  // History column: clamp to the range of its two current-frame neighbours, so camera
  // motion cannot leave a stale column (the comb that the blur turned into pulsing softness).
  float hw = uFullWidth * 0.5;
  vec4 l = texture2D(tCur, vec2((floor((x - 1.0) * 0.5) + 0.5) / hw, vUv.y));
  vec4 r = texture2D(tCur, vec2((floor((x + 1.0) * 0.5) + 0.5) / hw, vUv.y));
  vec4 lo = min(l, r), hi = max(l, r), pad = (hi - lo) * 0.25;
  gl_FragColor = clamp(texture2D(tPrev, uv), lo - pad, hi + pad);
#else
  gl_FragColor = mine ? texture2D(tCur, uv) : texture2D(tPrev, uv);
#endif
}`;

// Separable 7-tap Gaussian (sigma ~1.6 texels) on the half-resolution gas frame: turns the
// march's per-pixel dither into smooth density instead of a visible halftone grain.
const BLUR = /* glsl */`
uniform sampler2D tGas;
uniform vec2 uStep;
varying vec2 vUv;
void main() {
#ifdef SKY_CLOUDS
  // Sky clouds: 5-tap, sigma ~1 texel. Removes the dither without smearing cloud edges.
  vec4 c = texture2D(tGas, vUv) * 0.4026;
  c += (texture2D(tGas, vUv + uStep) + texture2D(tGas, vUv - uStep)) * 0.2442;
  c += (texture2D(tGas, vUv + uStep * 2.0) + texture2D(tGas, vUv - uStep * 2.0)) * 0.0545;
#else
  vec4 c = texture2D(tGas, vUv) * 0.2486;
  c += (texture2D(tGas, vUv + uStep) + texture2D(tGas, vUv - uStep)) * 0.2101;
  c += (texture2D(tGas, vUv + uStep * 2.0) + texture2D(tGas, vUv - uStep * 2.0)) * 0.1281;
  c += (texture2D(tGas, vUv + uStep * 3.0) + texture2D(tGas, vUv - uStep * 3.0)) * 0.0375;
#endif
  gl_FragColor = c;
}`;

const COMPOSITE = /* glsl */`
uniform sampler2D tScene, tGas;
varying vec2 vUv;
void main() {
  vec4 scene = texture2D(tScene, vUv);
  // The gas frame arrives blurred (BLUR); a bilinear upsample suffices.
  vec4 gas = texture2D(tGas, vUv);
  vec3 c = scene.rgb * gas.a + gas.rgb;
  // Linear-light saturation lift toward the references' vivid violet/magenta
  // (before bloom and the single Neutral tone-mapping transform).
  float luma = dot(c, vec3(0.2126, 0.7152, 0.0722));
  c = max(vec3(0.0), vec3(luma) + (c - vec3(luma)) * 1.45);
  gl_FragColor = vec4(c, 1.0);
}`;

export interface GasSettings { readonly resolutionScale: number; readonly steps: number }

export class GasVolumePass extends Pass {
  readonly march: ShaderMaterial;
  private readonly composite: ShaderMaterial;
  private readonly raw: [WebGLRenderTarget, WebGLRenderTarget];
  private readonly target: WebGLRenderTarget;
  private readonly blurTarget: WebGLRenderTarget;
  private readonly interleave: ShaderMaterial;
  private readonly full: WebGLRenderTarget;
  private parity = 0;
  private historyValid = false;
  private readonly blur: ShaderMaterial;
  private readonly quad = new FullScreenQuad();
  private readonly scale: number;
  private readonly texel = new Vector2(1, 1);

  constructor(private readonly camera: PerspectiveCamera, noise: Data3DTexture, settings: GasSettings) {
    super();
    this.scale = settings.resolutionScale;
    this.raw = [new WebGLRenderTarget(1, 1, { type: HalfFloatType, depthBuffer: false }), new WebGLRenderTarget(1, 1, { type: HalfFloatType, depthBuffer: false })];
    this.full = new WebGLRenderTarget(1, 1, { type: HalfFloatType, depthBuffer: false });
    this.interleave = new ShaderMaterial({ vertexShader: VERTEX, fragmentShader: INTERLEAVE, defines: STYLE_DEFINES, depthTest: false, depthWrite: false, uniforms: { tCur: { value: null }, tPrev: { value: null }, uParity: { value: 0 }, uFullWidth: { value: 2 }, uHistoryValid: { value: 0 } } });
    this.target = new WebGLRenderTarget(1, 1, { type: HalfFloatType, depthBuffer: false });
    this.blurTarget = new WebGLRenderTarget(1, 1, { type: HalfFloatType, depthBuffer: false });
    this.blur = new ShaderMaterial({ vertexShader: VERTEX, fragmentShader: BLUR, defines: STYLE_DEFINES, depthTest: false, depthWrite: false, uniforms: { tGas: { value: null }, uStep: { value: new Vector2() } } });
    this.march = new ShaderMaterial({
      vertexShader: VERTEX, fragmentShader: MARCH, depthTest: false, depthWrite: false,
      defines: { STEPS: settings.steps, ...STYLE_DEFINES },
      uniforms: {
        tDepth: { value: null }, uParity: { value: 0 }, uFullWidth: { value: 2 }, uNoise: { value: noise }, cameraNear: { value: 0.1 }, cameraFar: { value: 1000 },
        uTime: { value: 0 }, uCoverage: { value: 0.54 }, uSigma: { value: 0.1 }, uScale: { value: 1 / 150 }, uMaxDistance: { value: 380 }, uJitter: { value: 0 }, uPixelAngle: { value: 0.002 },
        uProjInv: { value: new Matrix4() }, uCamWorld: { value: new Matrix4() }, uCamPos: { value: new Vector3() },
        uVortex: { value: new Vector3() }, uAxis: { value: new Vector3(0, 0, -1) }, uLight: { value: new Vector3(0, 1, 0) }, uFieldCentre: { value: new Vector3() },
        uIslands: { value: Array.from({ length: MAX_ISLANDS }, () => new Vector4(0, -1e5, 0, 0)) },
        uFolds: { value: Array.from({ length: MAX_FOLDS }, () => new Vector4(0, -1e5, 0, 0)) },
        uHazards: { value: Array.from({ length: MAX_HAZARDS }, () => new Vector4(0, -1e5, 0, 0)) },
        uShearA: { value: Array.from({ length: MAX_SHEARS }, () => new Vector4(0, -1e5, 0, 0)) },
        uShearB: { value: Array.from({ length: MAX_SHEARS }, () => new Vector4(0, 0, 0, 1)) },
        uShearN: { value: Array.from({ length: MAX_SHEARS }, () => new Vector4(0, 1, 0, 0)) },
      },
    });
    this.composite = new ShaderMaterial({ vertexShader: VERTEX, fragmentShader: COMPOSITE, depthTest: false, depthWrite: false, uniforms: { tScene: { value: null }, tGas: { value: null } } });
  }

  setSize(width: number, height: number): void {
    const half = Math.max(1, Math.ceil(width * this.scale * 0.5)), w = half * 2, h = Math.max(1, Math.floor(height * this.scale));
    this.raw[0].setSize(half, h); this.raw[1].setSize(half, h);
    this.full.setSize(w, h);
    this.march.uniforms.uFullWidth!.value = w; this.interleave.uniforms.uFullWidth!.value = w;
    this.target.setSize(w, h);
    this.blurTarget.setSize(w, h);
    this.historyValid = false;
    this.texel.set(1 / w, 1 / h);
  }

  render(renderer: WebGLRenderer, writeBuffer: WebGLRenderTarget, readBuffer: WebGLRenderTarget): void {
    const u = this.march.uniforms;
    u.tDepth!.value = readBuffer.depthTexture;
    u.cameraNear!.value = this.camera.near; u.cameraFar!.value = this.camera.far;
    u.uPixelAngle!.value = 2 * Math.tan((this.camera.fov * Math.PI) / 360) / Math.max(1, this.target.height);
    (u.uProjInv!.value as Matrix4).copy(this.camera.projectionMatrixInverse);
    (u.uCamWorld!.value as Matrix4).copy(this.camera.matrixWorld);
    (u.uCamPos!.value as Vector3).setFromMatrixPosition(this.camera.matrixWorld);
    // March half the columns (this frame's parity) into a half-width target, then
    // interleave with the previous frame's other half: half the march cost per frame.
    this.parity ^= 1;
    const write = this.raw[this.parity]!, history = this.raw[this.parity ^ 1]!;
    u.uParity!.value = this.parity;
    renderer.setRenderTarget(write);
    this.quad.material = this.march;
    this.quad.render(renderer);
    const il = this.interleave.uniforms;
    il.tCur!.value = write.texture; il.tPrev!.value = history.texture; il.uParity!.value = this.parity; il.uHistoryValid!.value = this.historyValid ? 1 : 0;
    renderer.setRenderTarget(this.full);
    this.quad.material = this.interleave;
    this.quad.render(renderer);
    this.historyValid = true;
    // Blur horizontally into blurTarget, then vertically into target (the gas frame).
    const b = this.blur.uniforms;
    this.quad.material = this.blur;
    b.tGas!.value = this.full.texture; (b.uStep!.value as Vector2).set(this.texel.x, 0);
    renderer.setRenderTarget(this.blurTarget); this.quad.render(renderer);
    b.tGas!.value = this.blurTarget.texture; (b.uStep!.value as Vector2).set(0, this.texel.y);
    renderer.setRenderTarget(this.target); this.quad.render(renderer);
    this.composite.uniforms.tScene!.value = readBuffer.texture;
    this.composite.uniforms.tGas!.value = this.target.texture;
    renderer.setRenderTarget(this.renderToScreen ? null : writeBuffer);
    this.quad.material = this.composite;
    this.quad.render(renderer);
  }

  /** The gas frame (rgb emission, a = transmittance), read by the luminous overlay. */
  get frame(): WebGLRenderTarget['texture'] { return this.target.texture; }

  dispose(): void { this.raw[0].dispose(); this.raw[1].dispose(); this.full.dispose(); this.interleave.dispose(); this.target.dispose(); this.blurTarget.dispose(); this.blur.dispose(); this.march.dispose(); this.composite.dispose(); this.quad.dispose(); }
}

export function createGasTexture(data: Uint8Array, size: number): Data3DTexture {
  const texture = new Data3DTexture(data, size, size, size);
  texture.format = RGFormat; texture.type = UnsignedByteType;
  texture.minFilter = LinearMipmapLinearFilter; texture.magFilter = LinearFilter; texture.generateMipmaps = true;
  texture.wrapS = texture.wrapT = texture.wrapR = RepeatWrapping;
  texture.unpackAlignment = 1;
  texture.needsUpdate = true;
  return texture;
}

