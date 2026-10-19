import { useEffect } from 'react';
import { useThree } from '@react-three/fiber';
import type { Vec3 } from '../../simulation/types';
import { assetStats } from './assetStats';

/** Evidence hook (rendering only, opt-in with `?probe=1`): lets the placement
 * capture script frame fixed free-flight poses, exactly like the 1–9 viewpoint
 * keys do (an ordinary camera jump; nothing reaches the simulation), and read
 * the renderer's deterministic counters for the last frame. */
export function PlacementProbe() {
  const { camera, gl } = useThree();
  useEffect(() => {
    let enabled = false;
    try { enabled = new URLSearchParams(window.location.search).get('probe') === '1'; } catch { /* no window */ }
    if (!enabled) return;
    const api = {
      frame(position: Vec3, target: Vec3) {
        camera.position.set(...position);
        camera.lookAt(...target);
      },
      counters: () => ({
        drawCalls: gl.info.render.calls, triangles: gl.info.render.triangles, geometries: gl.info.memory.geometries, textures: gl.info.memory.textures,
        debrisInstances: assetStats.debrisInstances, debrisVisible: [...assetStats.debrisVisible], debrisTriangles: assetStats.debrisTriangles,
        microbotsVisible: [...assetStats.microbotsVisible], microbotTriangles: assetStats.microbotTriangles,
      }),
    };
    (window as unknown as { __FRACTURED_PLACEMENT__?: typeof api }).__FRACTURED_PLACEMENT__ = api;
    return () => { delete (window as unknown as { __FRACTURED_PLACEMENT__?: typeof api }).__FRACTURED_PLACEMENT__; };
  }, [camera, gl]);
  return null;
}
