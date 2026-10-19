import { DataTexture, RGBAFormat, Scene, UnsignedByteType, Vector2 } from 'three';
import type { Camera, Texture, WebGLRenderer, WebGLRenderTarget } from 'three';
import { Pass } from 'three/examples/jsm/postprocessing/Pass.js';

/** Luminous overlay layer (rendering only): additive effects composited AFTER the
 * raymarched gas, so that a thin luminous line is not dimmed by gas that lies
 * behind it (the gas composite multiplies the opaque scene by the whole ray's
 * transmittance). Overlay materials test against the scene depth themselves and
 * attenuate with distance toward the gas transmittance of their pixel, so effects
 * deep in the cloud still sink into it. Real fold apertures and cosmetic
 * fractures render here; nothing in this layer writes depth. */
export interface OverlayUniforms {
  readonly tSceneDepth: { value: Texture | null };
  readonly tGasFrame: { value: Texture | null };
  readonly uManualDepth: { value: number };
  readonly uViewport: { value: Vector2 };
  readonly uNear: { value: number };
  readonly uFar: { value: number };
}
export interface Overlay { readonly scene: Scene; readonly uniforms: OverlayUniforms }

const WHITE = new DataTexture(new Uint8Array([255, 255, 255, 255]), 1, 1, RGBAFormat, UnsignedByteType);
WHITE.needsUpdate = true;

export function createOverlay(): Overlay {
  const scene = new Scene();
  scene.name = 'luminous-overlay';
  return { scene, uniforms: { tSceneDepth: { value: null }, tGasFrame: { value: WHITE }, uManualDepth: { value: 0 }, uViewport: { value: new Vector2(1, 1) }, uNear: { value: 0.1 }, uFar: { value: 1000 } } };
}

/** GLSL: declarations + overlayVisibility(viewDistance). Needs <packing>. */
export const OVERLAY_FRAGMENT = /* glsl */`
uniform sampler2D tSceneDepth, tGasFrame;
uniform vec2 uViewport;
uniform float uNear, uFar, uManualDepth;
float overlayVisibility(float viewDistance) {
  vec2 uv = gl_FragCoord.xy / uViewport;
  float visible = 1.0;
  if (uManualDepth > 0.5) {
    float d = texture2D(tSceneDepth, uv).x;
    float sceneDistance = d >= 1.0 ? 1e9 : -perspectiveDepthToViewZ(d, uNear, uFar);
    visible = smoothstep(-0.4, 0.4, sceneDistance - viewDistance);
  }
  // Near effects stay crisp; far ones take on the cloud's transmittance.
  float T = texture2D(tGasFrame, uv).a;
  return visible * mix(1.0, max(T, 0.12), smoothstep(12.0, 170.0, viewDistance));
}`;

/** Renders the overlay scene into the frame (needsSwap = false). With the gas pass
 * before it, the scene depth lives in the write buffer (the previous read target);
 * without gas the read buffer still holds the scene depth, so the hardware depth
 * test is used instead of sampling (no feedback loop). */
export class OverlayPass extends Pass {
  gasFrame: Texture | null = null;
  constructor(private readonly overlay: Overlay, private readonly camera: Camera, private readonly afterGas: boolean) {
    super();
    this.needsSwap = false;
  }

  render(renderer: WebGLRenderer, writeBuffer: WebGLRenderTarget, readBuffer: WebGLRenderTarget): void {
    if (this.overlay.scene.children.length === 0) return;
    const u = this.overlay.uniforms;
    const manual = this.afterGas && !!writeBuffer.depthTexture;
    u.uManualDepth.value = manual ? 1 : 0;
    u.tSceneDepth.value = manual ? writeBuffer.depthTexture : WHITE;
    u.tGasFrame.value = this.afterGas && this.gasFrame ? this.gasFrame : WHITE;
    u.uViewport.value.set(readBuffer.width, readBuffer.height);
    const cam = this.camera as Camera & { near?: number; far?: number };
    u.uNear.value = cam.near ?? 0.1; u.uFar.value = cam.far ?? 1000;
    const autoClear = renderer.autoClear;
    renderer.autoClear = false;
    renderer.setRenderTarget(this.renderToScreen ? null : readBuffer);
    // The gas target's depth was cleared by the gas quad: clear it explicitly so the
    // hardware test (if any) passes, and rely on the manual scene-depth test.
    if (manual) renderer.clearDepth();
    renderer.render(this.overlay.scene, this.camera);
    renderer.autoClear = autoClear;
  }
}
