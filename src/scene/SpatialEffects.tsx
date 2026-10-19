import { useEffect, useMemo, useRef, useState } from 'react';
import { createPortal, useFrame, useThree } from '@react-three/fiber';
import {
  AdditiveBlending, BufferAttribute, BufferGeometry, Color, DoubleSide, InstancedBufferAttribute, InstancedMesh,
  Object3D, PointLight, Quaternion, ShaderMaterial, Vector3,
} from 'three';
import type { MeshStandardMaterial } from 'three';
import type { FoldConnection } from '../simulation/fractures';
import type { SimulationEngine } from '../simulation/simulationEngine';
import { add, distance, multiply, normalize, scale } from '../simulation/linearAlgebra';
import { createSeededRandom } from '../simulation/seededRandom';
import type { Vec3 } from '../simulation/types';
import { useAssets } from './assets/assetLoader';
import { createAssetMaterial } from './assets/assetMaterial';
import type { SurfaceMaps } from './assets/assetMaterial';
import { shareGeometry } from './assets/DebrisField';
import type { AtmosphereUniforms } from './terrain/rockMaterial';
import { OVERLAY_FRAGMENT } from './gas/overlay';
import type { Overlay, OverlayUniforms } from './gas/overlay';

const Z_AXIS=new Vector3(0,0,1);
// State colours in the dimension palette: real, traversable folds glow Portal Amber when
// open (cosmetic rifts are violet-white with a dark void, so the two never read alike).
const FOLD_COLORS={inactive:'#6c5a92',forming:'#b33fc1',open:'#ffbf8f',unstable:'#ff9a62',closing:'#ff5f7a',closed:'#5c4a78'};
const EXIT_COLOR='#e692cb';

/** Shared model-time uniform: aperture shimmer freezes when the simulation pauses. */
const modelTime={value:0};

const GLOW_VERTEX=/* glsl */`varying vec2 vUv; varying float vViewDistance; void main(){ vUv=uv; vec4 mv=modelViewMatrix*vec4(position,1.0); vViewDistance=-mv.z; gl_Position=projectionMatrix*mv; }`;
/** Overlay visibility (scene-depth occlusion, gas attenuation) when drawn in the luminous overlay. */
const OVERLAY_HEAD=`#include <packing>
#ifdef OVERLAY
${OVERLAY_FRAGMENT}
#else
float overlayVisibility(float d){ return 1.0; }
#endif
varying float vViewDistance;
`;
// A luminous tear in space: a jagged lens-shaped slit (3.1 m tall, the
// traversable aperture) with a white-hot edge, a soft halo in the state colour
// and a faint shimmering interior. It widens as the connection opens.
const TEAR_FRAGMENT=/* glsl */`${OVERLAY_HEAD}
uniform vec3 uColor; uniform float uOpen, uTime;
varying vec2 vUv;
float h1(float x){ return fract(sin(x*127.1)*43758.5453); }
float n1(float x){ float i=floor(x), f=fract(x); f=f*f*(3.0-2.0*f); return mix(h1(i),h1(i+1.0),f); }
void main(){
  vec2 p=(vUv*2.0-1.0)*2.6;
  float y=clamp(p.y/1.55,-1.0,1.0);
  float halfWidth=mix(0.14,0.6,uOpen)*pow(max(0.0,1.0-y*y),0.9);
  halfWidth*=0.8+0.4*n1(p.y*5.0+uTime*0.35)+0.15*n1(p.y*17.0-uTime*0.9);
  float e=abs(p.x+0.12*(n1(p.y*2.3+3.0)-0.5))-halfWidth;
  e=max(e,abs(p.y)-1.55);
  float edge=exp(-pow(e/0.035,2.0));
  float halo=exp(-max(e,0.0)/0.34)*(0.24+0.36*uOpen);
  // A light-filled opening (the far side of the fold), slowly swirling; never banded.
  float sw=n1(p.y*3.1+p.x*4.0-uTime*0.45)*0.6+n1(p.y*7.3-p.x*5.0+uTime*0.3)*0.4;
  float core=exp(-pow(p.x/(halfWidth+0.02),2.0)*1.5);
  float inside=step(e,0.0)*(0.18+0.32*sw)*(0.5+0.5*core)*uOpen;
  vec3 deep=mix(uColor,vec3(1.0,0.9,0.84),0.22);
  vec3 col=mix(uColor,vec3(1.0),edge*0.75)*(edge*1.8+halo*1.15)+deep*inside*0.95;
  float a=clamp(edge+halo+inside,0.0,1.0)*(1.0-smoothstep(2.2,2.6,length(p)))*overlayVisibility(vViewDistance);
  gl_FragColor=vec4(col*a,a);
}`;

function createTearMaterial(color:string,open:boolean,overlay?:OverlayUniforms) {
  return new ShaderMaterial({vertexShader:GLOW_VERTEX,fragmentShader:TEAR_FRAGMENT,transparent:true,depthWrite:false,blending:AdditiveBlending,side:DoubleSide,toneMapped:false,
    defines:overlay?{OVERLAY:1}:{},uniforms:{...(overlay??{}),uColor:{value:new Color(color)},uOpen:{value:open?1:0.25},uTime:modelTime}});
}

function Aperture({position,normal,color,open,overlay}:{position:Vec3;normal:Vec3;color:string;open:boolean;overlay?:OverlayUniforms|undefined}) {
  const rotation=useMemo(()=>new Quaternion().setFromUnitVectors(Z_AXIS,new Vector3(...normal)),[normal]);
  // Stable material (see GlowPoint): state changes update uniforms, never relink.
  const tear=useMemo(()=>createTearMaterial('#ffffff',false,overlay),[overlay]);
  useEffect(()=>()=>tear.dispose(),[tear]);
  (tear.uniforms.uColor!.value as Color).set(color);tear.uniforms.uOpen!.value=open?1:0.25;
  return <group position={position} quaternion={rotation}>
    <mesh name="aperture-tear" material={tear} renderOrder={3}><planeGeometry args={[5.2,5.2]}/></mesh>
  </group>;
}

const POINT_VERTEX=/* glsl */`uniform float uSize, uMinPx; varying float vViewDistance; void main(){ vec4 mv=modelViewMatrix*vec4(position,1.0); vViewDistance=-mv.z; gl_PointSize=clamp(uSize*300.0/-mv.z,uMinPx,48.0); gl_Position=projectionMatrix*mv; }`;
const POINT_FRAGMENT=/* glsl */`${OVERLAY_HEAD}uniform vec3 uColor; uniform float uStrength, uFlicker, uTime;
void main(){ vec2 c=gl_PointCoord*2.0-1.0; float a=exp(-dot(c,c)*5.0)*uStrength*(1.0-uFlicker*0.6*(0.5+0.5*sin(uTime*3.1)))*overlayVisibility(vViewDistance); gl_FragColor=vec4(uColor*a,a); }`;
const POINT_GEOMETRY=new BufferGeometry().setAttribute('position',new BufferAttribute(new Float32Array(3),3));

/** A soft luminous pinpoint (fold reference point, rejected candidate, hazard core). */
function GlowPoint({position,color,size,strength,flicker=0,minPx=2,overlay}:{position:Vec3;color:string;size:number;strength:number;flicker?:number;minPx?:number;overlay?:OverlayUniforms|undefined}) {
  // One material per mounted point; props only update uniforms. (Recreating it on every
  // 4 Hz state change disposed the last user of its program, forcing a shader relink
  // per tick: the periodic 70-80 ms main-thread stalls measured in Phase 5.)
  const material=useMemo(()=>new ShaderMaterial({vertexShader:POINT_VERTEX,fragmentShader:POINT_FRAGMENT,transparent:true,depthWrite:false,blending:AdditiveBlending,toneMapped:false,
    defines:overlay?{OVERLAY:1}:{},uniforms:{...(overlay??{}),uColor:{value:new Color()},uSize:{value:0},uMinPx:{value:0},uStrength:{value:0},uFlicker:{value:0},uTime:modelTime}}),[overlay]);
  useEffect(()=>()=>material.dispose(),[material]);
  const u=material.uniforms;
  (u.uColor!.value as Color).set(color);u.uSize!.value=size;u.uMinPx!.value=minPx;u.uStrength!.value=strength;u.uFlicker!.value=flicker;
  return <points position={position} geometry={POINT_GEOMETRY} material={material} frustumCulled={false}/>;
}

/** A real connection, drawn exactly at its simulated endpoints and normals in its
 * observed state. Valid connections also carry a soft state-coloured beacon with a
 * minimum on-screen size, so apertures stay discoverable at distance (presentation
 * only; position, tear size and state are the simulation's). */
function FoldIndicator({connection:c,overlay}:{connection:FoldConnection;overlay?:OverlayUniforms|undefined}) {
  const color=FOLD_COLORS[c.state];
  // A rejected candidate: a dim, flickering pinpoint (no aperture, no tear).
  if(!c.valid&&c.state!=='closed')return <GlowPoint position={c.worldPosition} color="#7183a8" size={0.5} strength={0.45} flicker={1} overlay={overlay}/>;
  return <group>
    <Aperture position={c.entryWorldPosition} normal={c.entryNormal} color={color} open={c.open} overlay={overlay}/>
    <Aperture position={c.exitWorldPosition} normal={c.exitNormal} color={c.open?EXIT_COLOR:color} open={c.open} overlay={overlay}/>
    <GlowPoint position={c.worldPosition} color={color} size={0.35} strength={0.8} overlay={overlay}/>
    {c.valid&&<GlowPoint position={c.entryWorldPosition} color={color} size={1.1} strength={c.open?0.5:0.22} minPx={c.open?7:4} overlay={overlay}/>}
  </group>;
}

const SHELL_VERTEX=/* glsl */`varying vec3 vN; varying vec3 vV; void main(){ vec4 mv=modelViewMatrix*vec4(position,1.0); vN=normalize(normalMatrix*normal); vV=normalize(-mv.xyz); gl_Position=projectionMatrix*mv; }`;
const SHELL_FRAGMENT=/* glsl */`uniform vec3 uColor; uniform float uHazard; varying vec3 vN; varying vec3 vV;
void main(){ float f=pow(1.0-abs(dot(normalize(vN),normalize(vV))),3.0); float a=f*(0.05+uHazard*0.42); gl_FragColor=vec4(uColor*a,a); }`;

/** Sampled instability as a soft fresnel shell (front faces only, so it
 * vanishes rather than cluttering the view when the camera is inside). */
function HazardShell({position,hazard}:{position:Vec3;hazard:number}) {
  const material=useMemo(()=>new ShaderMaterial({vertexShader:SHELL_VERTEX,fragmentShader:SHELL_FRAGMENT,transparent:true,depthWrite:false,blending:AdditiveBlending,toneMapped:false,
    uniforms:{uColor:{value:new Color('#f0a65c')},uHazard:{value:0}}}),[]);
  useEffect(()=>()=>material.dispose(),[material]);
  material.uniforms.uHazard!.value=hazard;
  material.uniforms.uColor!.value.set(hazard>.55?'#ff8563':'#f0a65c');
  return <group position={position}>
    <mesh scale={1+hazard*3.5} material={material}><sphereGeometry args={[1,32,16]}/></mesh>
    <GlowPoint position={[0,0,0]} color={hazard>.55?'#ff8563':'#edb56e'} size={0.4+hazard*0.5} strength={0.3+hazard}/>
  </group>;
}

/** The simulated gravity probes (engine.debris) rendered as real concrete chunks
 * at their simulated positions, each with its mapped gravity direction. Fixed
 * seeded orientation per probe; only the simulation moves them. */
// A compact faceted chunk (concrete candidate family); textures shared with the debris.
const PROBE_ASSET='concrete_chunk_a';
function GravityProbes({engine,atmosphere,maps}:{engine:SimulationEngine;atmosphere:AtmosphereUniforms;maps:SurfaceMaps}) {
  const assets=useAssets([PROBE_ASSET]);
  const count=engine.debris.states.length;
  const built=useMemo(()=>{
    const asset=assets?.[PROBE_ASSET];
    if(!asset)return null;
    // Motionless drift attributes (unit period, unit axis, zero rate): the chunk sits where the simulation puts it.
    const still={aBob:new InstancedBufferAttribute(new Float32Array(count*4).map((_,i)=>i%4===3?1:0),4),aSpin:new InstancedBufferAttribute(new Float32Array(count*4).map((_,i)=>i%4===1?1:0),4),aPhase:new InstancedBufferAttribute(new Float32Array(count),1)};
    return asset.parts.map(part=>{
      const geometry=shareGeometry(part.geometry);
      for(const [name,attribute] of Object.entries(still))geometry.setAttribute(name,attribute);
      const material=createAssetMaterial(part.material,atmosphere,'drift',undefined,maps);
      const mesh=new InstancedMesh(geometry,material,count);mesh.name='gravity-probes';mesh.frustumCulled=false;mesh.receiveShadow=true;
      return {mesh,geometry,material:material as MeshStandardMaterial};
    });
  },[assets,atmosphere,maps,count]);
  const object=useMemo(()=>new Object3D(),[]);
  const lines=useMemo(()=>{
    const geometry=new BufferGeometry();geometry.setAttribute('position',new BufferAttribute(new Float32Array(24),3));return geometry;
  },[]);
  useEffect(()=>()=>{lines.dispose();},[lines]);
  useEffect(()=>()=>{built?.forEach(b=>{b.mesh.dispose();b.geometry.dispose();b.material.dispose();});},[built]);
  const rotation=useMemo(()=>{const r=createSeededRandom(0x9b0be);return Array.from({length:count},()=>[r()*6.3,r()*6.3,r()*6.3] as const);},[count]);
  useFrame(()=>{
    const positions=lines.getAttribute('position');
    engine.debris.states.forEach((state,i)=>{
      const s=engine.sampleField(state.referencePosition,engine.clock.time);
      if(built){
        object.position.set(...s.worldPosition);object.rotation.set(...rotation[i]!);object.scale.setScalar(.85+(i%3)*.1);object.updateMatrix();
        for(const b of built)b.mesh.setMatrixAt(i,object.matrix);
      }
      if(i<4) {
        const direction=scale(normalize(multiply(s.jacobian,s.gravity)),1.8);
        positions.setXYZ(i*2,...s.worldPosition);positions.setXYZ(i*2+1,...add(s.worldPosition,direction));
      }
    });
    positions.needsUpdate=true;
    for(const b of built??[]){b.mesh.instanceMatrix.needsUpdate=true;(b.material.userData.uTime as {value:number}).value=engine.clock.time;}
  });
  return <>
    {built?.map(b=><primitive key={b.mesh.uuid} object={b.mesh}/>)}
    <lineSegments geometry={lines} frustumCulled={false}><lineBasicMaterial color="#ffc584" transparent opacity={.35}/></lineSegments>
  </>;
}

/** Two pooled point lights follow the nearest open aperture pair so fold light
 * falls on surrounding rock. A fixed light count avoids shader recompiles. */
function ApertureLights({connections}:{connections:readonly FoldConnection[]}) {
  const entry=useRef<PointLight>(null), exit=useRef<PointLight>(null);
  const open=connections.find(c=>c.valid&&c.open);
  useEffect(()=>{
    for(const [light,position,color] of [[entry.current,open?.entryWorldPosition,open?FOLD_COLORS[open.state]:null],[exit.current,open?.exitWorldPosition,EXIT_COLOR]] as const) {
      if(!light)continue;
      if(!position||!color){light.intensity=0;continue;}
      light.position.set(...position);light.color.set(color);light.intensity=open!.state==='unstable'?26:34;
    }
  },[open]);
  return <><pointLight ref={entry} intensity={0} distance={22} decay={1.6}/><pointLight ref={exit} intensity={0} distance={22} decay={1.6}/></>;
}

/** Connections drawn at once (all eight current connections fit). */
const MAX_INDICATORS=8;

export function SpatialEffects({engine,atmosphere,maps,overlay}:{engine:SimulationEngine;atmosphere:AtmosphereUniforms;maps:SurfaceMaps;overlay?:Overlay|null}) {
  const {camera}=useThree();
  const [connections,setConnections]=useState(()=>engine.network.getConnections(0).filter(c=>c.valid).slice(0,MAX_INDICATORS));
  const [hazards,setHazards]=useState<{position:Vec3;hazard:number}[]>([]);
  const tick=useRef(-1);
  const selectedAt=useRef<Vec3>([Infinity,Infinity,Infinity]);
  useFrame(()=>{
    modelTime.value=engine.clock.time;
    const next=Math.floor(engine.clock.time*4),timeChanged=next!==tick.current;
    const position:Vec3=[camera.position.x,camera.position.y,camera.position.z];
    if(!timeChanged&&distance(position,selectedAt.current)<4)return;
    tick.current=next;selectedAt.current=position;
    setConnections([...engine.network.getConnections(engine.clock.time)].filter(c=>c.valid||c.state==='closed'||c.minSingularValue<.3)
      .sort((a,b)=>distance(position,a.worldPosition)-distance(position,b.worldPosition)).slice(0,MAX_INDICATORS));
    if(timeChanged)setHazards([1,2,4,6].map(i=>{
      const q=add(engine.world.islands[i]!.referencePosition,[0,1.1,0]);const s=engine.sampleField(q,engine.clock.time);
      return {position:s.worldPosition,hazard:s.hazard};
    }));
  });
  return <>
    {overlay?createPortal(<>{connections.map(c=><FoldIndicator key={c.id} connection={c} overlay={overlay.uniforms}/>)}</>,overlay.scene):connections.map(c=><FoldIndicator key={c.id} connection={c}/>)}
    <ApertureLights connections={connections}/>
    {hazards.map((h,i)=><HazardShell key={i} position={h.position} hazard={h.hazard}/>)}
    <GravityProbes engine={engine} atmosphere={atmosphere} maps={maps}/>
  </>;
}
