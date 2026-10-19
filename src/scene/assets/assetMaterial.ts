import { MeshStandardMaterial, Vector3, Vector4 } from 'three';
import type { Texture } from 'three';
import type { AtmosphereUniforms } from '../terrain/rockMaterial';

/** Instanced asset shading: the GLB's own PBR material plus GPU motion driven by
 * model time (so it freezes on pause and replays after reset), object-space
 * weathering, and the same aerial haze as the rock, so objects sink into the
 * gas with distance.
 *
 * Motion is rigid per instance: world = R·(p − pivot) + pivot + offset, with the
 * normal rotated by R. Two modes:
 *  - 'drift'     (debris): slow spin about the piece's own centre plus a gentle
 *                bob; per-instance aBob (amplitude xyz, period) / aSpin (axis, rate) / aPhase.
 *  - 'formation' (microbots): the whole formation turns about its axis (with
 *                optional differential rotation), plus per-unit wobble or a
 *                travelling ripple along a chain; uniforms per formation. */
export type AssetMotion = 'drift' | 'formation';

export interface FormationUniforms {
  readonly uCentre: { value: Vector3 };
  readonly uAxis: { value: Vector3 };
  /** x angular speed (rad/s), y radius, z wobble amplitude (m), w ripple amplitude (m). */
  readonly uFormation: { value: Vector4 };
  /** x differential rotation (0 rigid, 1 faster at the core). */
  readonly uFormationMode: { value: Vector4 };
}

export function createFormationUniforms(): FormationUniforms {
  return { uCentre: { value: new Vector3() }, uAxis: { value: new Vector3(0, 1, 0) }, uFormation: { value: new Vector4() }, uFormationMode: { value: new Vector4() } };
}

/** Surface weathering class, from the glTF material name (see assets-src/library). */
export type AssetSurface = 'concrete' | 'metal' | 'paint' | 'clean';
export function surfaceFor(materialName: string): AssetSurface {
  if (/^microbot/.test(materialName)) return 'clean';
  if (/concrete|heatshield/.test(materialName)) return 'concrete';
  if (/steel|pipe|rebar|grating|alloy|mechanism|copper/.test(materialName)) return 'metal';
  return 'paint';
}
/** CC0 detail maps (Poly Haven rocks_ground_06: aggregate albedo and ARM). */
export interface SurfaceMaps { readonly albedo: Texture; readonly arm: Texture }
const SURFACE_DEFINES: Record<AssetSurface, number> = { clean: 0, concrete: 1, metal: 2, paint: 3 };

const ROTATION = /* glsl */`
mat3 assetAxisAngle(vec3 a, float t) {
  float c = cos(t), s = sin(t), k = 1.0 - c;
  return mat3(c + a.x * a.x * k, a.y * a.x * k + a.z * s, a.z * a.x * k - a.y * s,
              a.x * a.y * k - a.z * s, c + a.y * a.y * k, a.z * a.y * k + a.x * s,
              a.x * a.z * k + a.y * s, a.y * a.z * k - a.x * s, c + a.z * a.z * k);
}`;

const MOTION: Record<AssetMotion, string> = {
  drift: /* glsl */`
attribute vec4 aBob;
attribute vec4 aSpin;
attribute float aPhase;
#ifdef ASSET_FADE
attribute float aFade;
varying float vAssetFade;
#endif
void assetMotion(vec3 origin, out mat3 R, out vec3 pivot, out vec3 offset) {
  #ifdef ASSET_FADE
  vAssetFade = aFade;
  #endif
  R = assetAxisAngle(aSpin.xyz, aSpin.w * uTime);
  pivot = origin;
  offset = aBob.xyz * sin(6.2831853 * uTime / aBob.w + aPhase);
}`,
  formation: /* glsl */`
attribute float aPhase;
uniform vec3 uCentre, uAxis;
uniform vec4 uFormation, uFormationMode;
void assetMotion(vec3 origin, out mat3 R, out vec3 pivot, out vec3 offset) {
  vec3 rel = origin - uCentre;
  float radial = length(rel - uAxis * dot(rel, uAxis));
  float rate = mix(1.0, 1.0 / (0.45 + radial / max(uFormation.y, 1e-3)), uFormationMode.x);
  R = assetAxisAngle(uAxis, uFormation.x * rate * uTime);
  pivot = uCentre;
  vec3 wobble = vec3(sin(uTime * 0.83 + aPhase), sin(uTime * 0.71 + aPhase * 1.3), cos(uTime * 0.67 + aPhase * 0.7));
  vec3 rippleDir = normalize(cross(uAxis, vec3(0.31, 0.95, 0.17)));
  offset = wobble * uFormation.z + rippleDir * sin(uTime * 0.9 - aPhase * 1.5) * uFormation.w;
}`,
};

// Object-space weathering, so detail sticks to each piece: concrete takes a
// desaturated triplanar aggregate (luminance and AO); metal and paint get
// value-noise grime, scuffs and (metal) rust patches. At most 6 taps, no loops.
const SURFACE_FRAGMENT = /* glsl */`
varying vec3 vAssetObj, vAssetObjN;
#ifdef ASSET_FADE
varying float vAssetFade;
#endif
uniform sampler2D tDetailA, tDetailR;
float assetHash(vec3 p) { p = fract(p * 0.3183099 + 0.1); p *= 17.0; return fract(p.x * p.y * p.z * (p.x + p.y + p.z)); }
float assetNoise(vec3 x) {
  vec3 i = floor(x), f = fract(x); f = f * f * (3.0 - 2.0 * f);
  return mix(mix(mix(assetHash(i), assetHash(i + vec3(1, 0, 0)), f.x), mix(assetHash(i + vec3(0, 1, 0)), assetHash(i + vec3(1, 1, 0)), f.x), f.y),
             mix(mix(assetHash(i + vec3(0, 0, 1)), assetHash(i + vec3(1, 0, 1)), f.x), mix(assetHash(i + vec3(0, 1, 1)), assetHash(i + vec3(1, 1, 1)), f.x), f.y), f.z);
}
vec3 assetTriplanar(sampler2D t, vec3 p, vec3 w) {
  return texture2D(t, p.zy).rgb * w.x + texture2D(t, p.xz).rgb * w.y + texture2D(t, p.xy).rgb * w.z;
}`;

const COLOR_FRAGMENT = /* glsl */`
  #include <color_fragment>
  #ifdef ASSET_FADE
  // Dithered LOD cross-fade and far fade-out (no popping). f in [0,1]: keep where the
  // fixed per-pixel threshold is below f; f in (1,2]: the complementary set.
  float assetN = fract(52.9829189 * fract(dot(gl_FragCoord.xy, vec2(0.06711056, 0.00583715))));
  if (vAssetFade <= 1.0 ? assetN >= vAssetFade : assetN < vAssetFade - 1.0) discard;
  #endif
  float assetAO = 1.0, grime = 0.5, rust = 0.0, scuff = 0.5;
  #if ASSET_SURFACE == 1
  vec3 tw = pow(abs(normalize(vAssetObjN)), vec3(4.0)); tw /= tw.x + tw.y + tw.z;
  // Two incommensurate scales so the aggregate never tiles visibly.
  float lum = dot(assetTriplanar(tDetailA, vAssetObj * 1.3, tw) * 0.55 + assetTriplanar(tDetailA, vAssetObj.zxy * 3.1 + 0.37, tw.zxy) * 0.45, vec3(0.299, 0.587, 0.114));
  float stain = assetNoise(vAssetObj * 1.7) * 0.6 + assetNoise(vAssetObj * 5.3) * 0.4;
  diffuseColor.rgb *= mix(0.55, 1.35, smoothstep(0.08, 0.6, lum)) * mix(0.72, 1.05, stain);
  assetAO = mix(1.0, assetTriplanar(tDetailR, vAssetObj * 1.3, tw).r, 0.7);
  #elif ASSET_SURFACE == 2
  grime = assetNoise(vAssetObj * 2.6) * 0.65 + assetNoise(vAssetObj * 9.0) * 0.35;
  rust = smoothstep(0.58, 0.8, assetNoise(vAssetObj * 1.3 + 7.0) * 0.7 + grime * 0.3);
  diffuseColor.rgb = mix(diffuseColor.rgb * mix(0.7, 1.08, grime), vec3(0.2, 0.09, 0.045), rust * 0.75);
  #elif ASSET_SURFACE == 3
  scuff = assetNoise(vAssetObj * 3.1) * 0.6 + assetNoise(vAssetObj * 11.0) * 0.4;
  diffuseColor.rgb *= mix(0.68, 1.0, scuff) * mix(1.0, 0.8, smoothstep(0.6, 0.85, assetNoise(vAssetObj * 0.9 + 3.0)));
  #endif`;

const ROUGHNESS_FRAGMENT = /* glsl */`
  #include <roughnessmap_fragment>
  #if ASSET_SURFACE == 2
  // Weathered, not polished: wreckage metal never drops below 0.48.
  roughnessFactor = clamp(max(roughnessFactor, 0.48) + (grime - 0.5) * 0.3 + rust * 0.35, 0.05, 1.0);
  #elif ASSET_SURFACE == 3
  roughnessFactor = clamp(roughnessFactor + (0.5 - scuff) * 0.25, 0.05, 1.0);
  #endif`;

const HAZE_FRAGMENT = /* glsl */`
  vec3 atmoRay = vAssetWorld - cameraPosition;
  float atmoDist = length(atmoRay);
  float haze = 1.0 - exp(-uHazeDensity * uHazeDensity * atmoDist * atmoDist);
  float low = clamp((uHazeFloor - vAssetWorld.y) / 30.0, 0.0, 1.0);
  haze = clamp(haze + low * low * 0.55 * (1.0 - exp(-atmoDist * 0.012)), 0.0, 1.0);
  gl_FragColor.rgb = mix(gl_FragColor.rgb, textureLod(uSkyHaze, normalize(atmoRay), uHazeMip).rgb * uHazeTint, haze);
  #include <tonemapping_fragment>`;

/** `fade`: per-instance dithered fade (aFade attribute; debris LOD transitions). */
export function createAssetMaterial(source: MeshStandardMaterial, atmosphere: AtmosphereUniforms, motion: AssetMotion, formation?: FormationUniforms, maps?: SurfaceMaps, fade = false): MeshStandardMaterial {
  const material = source.clone();
  material.fog = false;
  // Baked PBR candidates (they carry a base-colour map) keep their reviewed surface:
  // object-space weathering only dresses untextured materials.
  const wreck = !!maps && !/^microbot/.test(source.name);
  const surface = maps && !source.map ? surfaceFor(source.name) : 'clean';
  // Baked candidates keep full sky light so their reviewed grey concrete, paint and
  // armour read under the violet gas; untextured wreckage sits with the darker rock.
  if (wreck) material.envMapIntensity = source.map ? 1.0 : 0.55;
  const time = { value: 0 };
  material.userData.uTime = time;
  material.onBeforeCompile = (shader) => {
    Object.assign(shader.uniforms, atmosphere, { uTime: time, tDetailA: { value: maps?.albedo ?? null }, tDetailR: { value: maps?.arm ?? null } }, formation ?? {});
    shader.defines = { ...shader.defines, ASSET_SURFACE: SURFACE_DEFINES[surface], ASSET_WRECK: wreck ? 1 : 0, ...(fade ? { ASSET_FADE: 1 } : {}) };
    shader.vertexShader = `uniform float uTime;\nvarying vec3 vAssetWorld, vAssetObj, vAssetObjN;\nmat3 assetR; vec3 assetPivot, assetOffset;\n${ROTATION}\n${MOTION[motion]}\n` + shader.vertexShader
      .replace('#include <begin_vertex>', '#include <begin_vertex>\n  vAssetObj = position; vAssetObjN = normal;')
      .replace('#include <beginnormal_vertex>', /* glsl */`
  #ifdef USE_INSTANCING
  assetMotion(instanceMatrix[3].xyz, assetR, assetPivot, assetOffset);
  #else
  assetMotion(vec3(0.0), assetR, assetPivot, assetOffset);
  #endif
  #include <beginnormal_vertex>`)
      // Meshes sit at the world origin, so normalMatrix is the (orthonormal) view rotation.
      .replace('#include <defaultnormal_vertex>', '#include <defaultnormal_vertex>\n  transformedNormal = normalMatrix * (assetR * (transpose(normalMatrix) * transformedNormal));')
      .replace('#include <project_vertex>', /* glsl */`
  vec4 mvPosition = vec4(transformed, 1.0);
  #ifdef USE_INSTANCING
  mvPosition = instanceMatrix * mvPosition;
  #endif
  vec3 assetWorld = assetR * (mvPosition.xyz - assetPivot) + assetPivot + assetOffset;
  vAssetWorld = (modelMatrix * vec4(assetWorld, 1.0)).xyz;
  mvPosition = modelViewMatrix * vec4(assetWorld, 1.0);
  gl_Position = projectionMatrix * mvPosition;`);
    shader.fragmentShader = `varying vec3 vAssetWorld;\nuniform float uHazeDensity, uHazeFloor, uHazeMip;\nuniform vec3 uHazeTint;\nuniform samplerCube uSkyHaze;\n${SURFACE_FRAGMENT}\n` + shader.fragmentShader
      .replace('#include <color_fragment>', COLOR_FRAGMENT)
      .replace('#include <roughnessmap_fragment>', ROUGHNESS_FRAGMENT)
      // The baked sky holds the HDR vortex core; clamp its mirror image on weathered
      // surfaces so a pipe never blooms like a light source.
      .replace('#include <aomap_fragment>', '#include <aomap_fragment>\n  reflectedLight.indirectDiffuse *= assetAO; reflectedLight.indirectSpecular *= assetAO;\n  #if ASSET_SURFACE > 0 || ASSET_WRECK == 1\n  reflectedLight.indirectSpecular = min(reflectedLight.indirectSpecular, vec3(0.6));\n  #endif\n  #if ASSET_WRECK == 1\n  // Soft lavender bounce: shadowed sides keep their material colour instead of going black.\n  reflectedLight.indirectDiffuse += diffuseColor.rgb * vec3(0.34, 0.29, 0.44) * assetAO;\n  #endif')
      .replace('#include <tonemapping_fragment>', HAZE_FRAGMENT);
  };
  material.customProgramCacheKey = () => `fractured-asset-${motion}-${surface}-${wreck ? 1 : 0}-${fade ? 1 : 0}`;
  return material;
}
