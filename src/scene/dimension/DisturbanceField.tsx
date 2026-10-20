import { useEffect, useMemo, useRef } from 'react';
import { useFrame } from '@react-three/fiber';
import { AdditiveBlending, Color, DoubleSide, Group, IcosahedronGeometry, Mesh, MeshBasicMaterial, SphereGeometry, TorusGeometry } from 'three';
import type { SimulationEngine } from '../../simulation/simulationEngine';
import { DISTURBANCES, moversFor } from '../../world/movers';

/** The dimensional disturbance: a visible region of swirling displaced space where the movers' extra swirl force acts (src/world/movers.ts).
 * It follows its mapped position at the engine clock and its brightness follows the force's own modulation, so what you see is what
 * deflects the objects. It is decorative geometry only; the force itself lives in the simulation of the movers. */
export function DisturbanceField({ engine }: { readonly engine: SimulationEngine }) {
  const group = useRef<Group>(null);
  const parts = useMemo(() => {
    const core = new Mesh(new SphereGeometry(1, 28, 20), new MeshBasicMaterial({ color: new Color('#d238dc'), transparent: true, opacity: 0.06, depthWrite: false, blending: AdditiveBlending }));
    const lattice = new Mesh(new IcosahedronGeometry(1, 2), new MeshBasicMaterial({ color: new Color('#f0b4f4'), wireframe: true, transparent: true, opacity: 0.12, depthWrite: false, blending: AdditiveBlending }));
    const ringA = new Mesh(new TorusGeometry(1, 0.012, 8, 72), new MeshBasicMaterial({ color: new Color('#ffb35c'), transparent: true, opacity: 0.55, depthWrite: false, blending: AdditiveBlending, side: DoubleSide }));
    const ringB = ringA.clone();
    return { core, lattice, ringA, ringB };
  }, []);
  useEffect(() => () => { Object.values(parts).forEach(m => { m.geometry.dispose(); (m.material as MeshBasicMaterial).dispose(); }); }, [parts]);
  useFrame(() => {
    const g = group.current;
    if (!g) return;
    const d = moversFor(engine).disturbanceStates()[0];
    if (!d || DISTURBANCES.length === 0) { g.visible = false; return; }
    const t = engine.clock.time;
    g.visible = true;
    g.position.set(d.position[0], d.position[1], d.position[2]);
    g.scale.setScalar(d.radius * (0.92 + 0.08 * Math.sin(t * 0.9)));
    parts.lattice.rotation.set(t * 0.12, t * 0.2, 0);
    parts.ringA.rotation.set(Math.PI / 2 + Math.sin(t * 0.3) * 0.4, t * 0.5, 0);
    parts.ringB.rotation.set(0.6, -t * 0.4, Math.PI / 3);
    (parts.core.material as MeshBasicMaterial).opacity = 0.03 + 0.07 * d.intensity;
    (parts.ringA.material as MeshBasicMaterial).opacity = 0.2 + 0.5 * d.intensity;
    (parts.ringB.material as MeshBasicMaterial).opacity = 0.15 + 0.4 * d.intensity;
  });
  return <group ref={group} visible={false} name="dimensional-disturbance"><primitive object={parts.core} /><primitive object={parts.lattice} /><primitive object={parts.ringA} /><primitive object={parts.ringB} /></group>;
}
