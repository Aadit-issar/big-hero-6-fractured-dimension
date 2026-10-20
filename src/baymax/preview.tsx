import { StrictMode, useLayoutEffect, useMemo } from 'react';
import { createRoot } from 'react-dom/client';
import { Canvas, useFrame, useThree } from '@react-three/fiber';
import { PMREMGenerator } from 'three';
import { RoomEnvironment } from 'three/examples/jsm/environments/RoomEnvironment.js';
import { BaymaxHero } from './BaymaxHero';
import { createBaymaxGhost } from './glb';
import type { BaymaxHeroState } from './BaymaxHero';

// Dev-only deterministic preview: /baymax-preview.html?view=front|side|back|three|top&state=hover|accel|brake|turn|up|down|boost|waypoint
const params = new URLSearchParams(window.location.search);
const view = params.get('view') ?? 'three';
const stateName = params.get('state') ?? 'hover';
const lod = params.get('lod') === 'low' ? 'low' : 'high';
const showFx = params.get('fx') !== '0';

const base: BaymaxHeroState = { position: [0, 0, 0], quaternion: [0, 0, 0, 1], velocity: [0, 0, 0], acceleration: [0, 0, 0], yawRate: 0, boost: false };
const STATES: Record<string, BaymaxHeroState> = {
  hover: base,
  accel: { ...base, velocity: [0, 0, -8], acceleration: [0, 0, -6] },
  brake: { ...base, velocity: [0, 0, -8], acceleration: [0, 0, 7] },
  turn: { ...base, velocity: [0, 0, -6], yawRate: 1.3 },
  up: { ...base, velocity: [0, 3, 0], acceleration: [0, 3, 0] },
  down: { ...base, velocity: [0, -3, 0], acceleration: [0, -2, 0] },
  boost: { ...base, velocity: [0, 0, -14], acceleration: [0, 0, -9], boost: true },
  waypoint: { ...base, velocity: [0, 0, -3], acceleration: [0, 0, 0.8] },
  cruise: { ...base, velocity: [0, 0, -13], acceleration: [0, 0, 0] },
  climb: { ...base, velocity: [0, 5, -6], acceleration: [0, 3, -1] },
};
const state = STATES[stateName] ?? base;

const CAMERAS: Record<string, [number, number, number]> = {
  front: [0, 0.3, -6.4],
  ghost: [-8.5, 3.5, 5.5],
  back: [0, 0.45, 6.4],
  side: [6.4, 0.3, 0.4],
  three: [-4.4, 1.2, -4.9],
  ref3: [-3.0, 0.1, -5.6],
  rearthree: [4.2, 1.6, 5.0],
  top: [0, 8.2, 0.01],
};
const TARGET: [number, number, number] = [0, 0.05, 0.1];
const wingsParam = params.get('wings');
const wingOverride = wingsParam === null ? undefined : Math.max(0, Math.min(1, Number(wingsParam)));
const loadedFlag = (v: boolean): void => { (window as unknown as { __baymaxLoaded: boolean }).__baymaxLoaded = v; };

function Rig() {
  const { camera, gl, scene } = useThree();
  useLayoutEffect(() => {
    const pm = new PMREMGenerator(gl);
    const env = pm.fromScene(new RoomEnvironment(), 0.04).texture;
    scene.environment = env;
    scene.environmentIntensity = 0.55;
    return () => { scene.environment = null; env.dispose(); pm.dispose(); };
  }, [gl, scene]);
  useLayoutEffect(() => {
    const p = CAMERAS[view] ?? CAMERAS.three!;
    camera.position.set(...p);
    camera.lookAt(...TARGET);
    camera.updateProjectionMatrix();
  }, [camera]);
  let n = 0;
  useFrame(() => { if ((window as unknown as { __baymaxLoaded?: boolean }).__baymaxLoaded && ++n === 6) (window as unknown as { __baymaxReady: boolean }).__baymaxReady = true; });
  return null;
}

const ghostParam = params.get('ghost');

/** Dev check for createBaymaxGhost: three translucent copies ahead of the hero at falling opacity. */
function Ghosts() {
  const { scene } = useThree();
  useLayoutEffect(() => {
    let alive = true;
    const made: Array<{ dispose(): void }> = [];
    void Promise.all([0.7, 0.45, 0.25].map((o, i) => createBaymaxGhost('low').then((g) => {
      if (!alive) { g.dispose(); return; }
      g.setOpacity(o);
      g.root.position.set(0, 0.0, -2.6 * (i + 1));
      scene.add(g.root);
      made.push(g);
    })));
    return () => { alive = false; for (const g of made) g.dispose(); };
  }, [scene]);
  return null;
}

function Preview() {
  const bg = useMemo(() => 'radial-gradient(ellipse at 50% 40%, #241a4a 0%, #0c0a1e 70%)', []);
  return (
    <div style={{ position: 'fixed', inset: 0, background: bg }}>
      <Canvas gl={{ antialias: true, alpha: true, preserveDrawingBuffer: true }} camera={{ fov: 34, near: 0.1, far: 100 }} dpr={1}>
        <Rig />
        {ghostParam === '1' ? <Ghosts /> : null}
        <ambientLight intensity={0.35} color="#e8e0ff" />
        <directionalLight position={[-3, 5, -4]} intensity={2.6} color="#fff6ee" />
        <directionalLight position={[4, 2.5, 4]} intensity={1.5} color="#cdbbff" />
        <directionalLight position={[0, -3, -2]} intensity={0.6} color="#ff5cc8" />
        <BaymaxHero state={state} lod={lod} showFx={showFx} settle fixedTime={0.37} onReady={() => loadedFlag(true)} {...(wingOverride === undefined ? {} : { wingOverride })} />
      </Canvas>
      <div style={{ position: 'absolute', left: 14, bottom: 10, font: '12px monospace', color: '#8e86c8' }}>{`baymax-preview  view=${view}  state=${stateName}`}</div>
    </div>
  );
}

createRoot(document.getElementById('root')!).render(<StrictMode><Preview /></StrictMode>);
