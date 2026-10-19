import { useEffect, useMemo } from 'react';
import { useFrame, useThree } from '@react-three/fiber';
import { BufferAttribute, BufferGeometry, Color, CubeTexture, DoubleSide, Matrix3, ShaderMaterial } from 'three';
import { MIRROR_Y } from './layout';

const VERTEX = /* glsl */`
attribute vec3 bary;
varying vec3 vWorld, vNormalW, vBary;
void main() {
  vec4 w = modelMatrix * vec4(position, 1.0);
  vWorld = w.xyz; vNormalW = normalize(mat3(modelMatrix) * normal); vBary = bary;
  gl_Position = projectionMatrix * viewMatrix * w;
}`;

// The floor samples the gaseous sky along the reflected ray. (uDisplace and the
// seam terms date from the removed panes; the floor uses identity and no seam.)
const FRAGMENT = /* glsl */`
uniform samplerCube uSky;
uniform mat3 uDisplace;
uniform vec3 uSeam;
uniform float uOpacity, uEdge, uFloor;
varying vec3 vWorld, vNormalW, vBary;
void main() {
  vec3 view = normalize(vWorld - cameraPosition);
  vec3 n = normalize(vNormalW);
  vec3 sky = textureCube(uSky, uDisplace * reflect(view, n)).rgb;
  // Soft-compress bright eddies so displaced views never become white sheets.
  sky = sky / (1.0 + sky * 1.2);
  float fres = pow(1.0 - abs(dot(view, n)), 3.0);
  float e = min(vBary.x, min(vBary.y, vBary.z));
  float seam = (1.0 - smoothstep(0.0, uEdge, e)) * (1.0 - uFloor);
  // The floor reflects at reduced, deepened intensity so it never forms a white sheet.
  vec3 col = sky * mix(0.6 + 0.25 * fres, 0.45 + 0.25 * fres, uFloor) * mix(vec3(1.0), vec3(0.7, 0.62, 1.0), uFloor) + uSeam * seam * 2.0;
  // The floor dissolves into the gas with distance and at grazing angles, so it never reads as a slab with a horizon edge.
  float fade = uFloor > 0.5 ? (1.0 - smoothstep(55.0, 230.0, length(vWorld.xz - vec2(0.0, -55.0)))) * smoothstep(0.03, 0.32, abs(view.y)) : 1.0;
  // Fully dissolved floor must not write depth either, or the gas march stops at an
  // invisible plane and the quad's straight edge shows through the gas from above.
  if (fade < 0.02) discard;
  gl_FragColor = vec4(col, (uOpacity + seam * 0.4) * fade);
}`;

function createFloorMaterial(displace: Matrix3, opacity: number, floor: boolean): ShaderMaterial {
  return new ShaderMaterial({
    vertexShader: VERTEX, fragmentShader: FRAGMENT, transparent: true, depthWrite: true, side: DoubleSide,
    uniforms: { uSky: { value: null }, uDisplace: { value: displace }, uSeam: { value: new Color('#ff8fe6') }, uOpacity: { value: opacity }, uEdge: { value: 0.004 }, uFloor: { value: floor ? 1 : 0 } },
  });
}

/** The reflective floor mirroring the gaseous sky. The giant displaced-space
 * panes that used to share this shader were removed: real fold connections now
 * shear the gas itself (GasVolumePass `shear`), so no surface fakes a fold. */
export function MirrorFloor() {
  const { scene } = useThree();
  // The floor mirrors the sky vertically (y flipped by the reflection itself).
  const floor = useMemo(() => createFloorMaterial(new Matrix3(), 0.9, true), []);
  const floorGeometry = useMemo(() => {
    const g = new BufferGeometry();
    g.setAttribute('position', new BufferAttribute(new Float32Array([-350, -350, 0, 350, -350, 0, 350, 350, 0, -350, -350, 0, 350, 350, 0, -350, 350, 0]), 3));
    g.setAttribute('bary', new BufferAttribute(new Float32Array(18).fill(1), 3));
    g.computeVertexNormals();
    return g;
  }, []);
  useEffect(() => () => { floor.dispose(); floorGeometry.dispose(); }, [floor, floorGeometry]);
  useFrame(() => {
    if (!(scene.background instanceof CubeTexture)) return;
    floor.uniforms.uSky!.value = scene.background;
  });
  return <mesh name="mirror-floor" geometry={floorGeometry} material={floor} position={[0, MIRROR_Y, -55]} rotation={[-Math.PI / 2, 0, 0]} />;
}
