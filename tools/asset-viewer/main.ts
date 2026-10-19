import {
  ACESFilmicToneMapping, BackSide, Box3, BufferAttribute, BufferGeometry, Color, DirectionalLight, GridHelper, Group, HemisphereLight, InstancedBufferAttribute,
  InstancedMesh, Matrix4, Mesh, MeshStandardMaterial, NeutralToneMapping, PCFShadowMap, PerspectiveCamera, PlaneGeometry, PMREMGenerator,
  Quaternion, Scene, ShaderMaterial, ShadowMaterial, SphereGeometry, SRGBColorSpace, Vector2, Vector3, Vector4, WebGLRenderer,
} from 'three';
import type { Material, Object3D } from 'three';
import { OrbitControls } from 'three/examples/jsm/controls/OrbitControls.js';
import { GLTFLoader } from 'three/examples/jsm/loaders/GLTFLoader.js';
import type { GLTF } from 'three/examples/jsm/loaders/GLTFLoader.js';
import { RoomEnvironment } from 'three/examples/jsm/environments/RoomEnvironment.js';
import { SimulationEngine } from '../../src/simulation/simulationEngine';
import { createAssetMaterial, createFormationUniforms, surfaceFor } from '../../src/scene/assets/assetMaterial';
import { ASSET_SIZES } from '../../src/scene/assets/assetSizes';
import { layoutDimension, placementInputs } from '../../src/scene/assets/placement';
import type { DimensionLayout, FormationKind } from '../../src/scene/assets/placement';
import { createAtmosphereUniforms, createRockMaterial, loadRockTextures } from '../../src/scene/terrain/rockMaterial';
import { cellSizeFor, generateTerrain, TERRAIN_RESOLUTIONS } from '../../src/scene/terrain/terrainGenerator';
import { buildCatalogue, GROUPS, pretty, referencesFor } from './catalog';
import type { CandidateConfig, Entry, Manifest, ReferenceConfig } from './catalog';

/** Asset Inspection Gallery. Renders exactly the exported GLB files, the dimension's
 * real layout data and its live procedural geology; nothing is substituted or
 * restyled for the gallery. Legacy single-model URL: ?model=/assets/models/x.glb
 * (&view=hero|hero2|front|side|top|rear&mode=material|clay|wire|dimension&capture=1). */
const params = new URLSearchParams(location.search);
if (params.get('capture') === '1') document.body.classList.add('capture');
const $ = <T extends HTMLElement = HTMLElement>(id: string) => document.getElementById(id) as T;

// ---------- renderer, studio and dimension light rigs ----------
const stage = $('stage'), status = $('status');
const renderer = new WebGLRenderer({ antialias: true, preserveDrawingBuffer: true });
renderer.setPixelRatio(Math.min(devicePixelRatio, 2));
renderer.outputColorSpace = SRGBColorSpace;
renderer.shadowMap.enabled = true;
renderer.shadowMap.type = PCFShadowMap;
stage.appendChild(renderer.domElement);
const scene = new Scene();
const camera = new PerspectiveCamera(30, 1, 0.001, 100);
const controls = new OrbitControls(camera, renderer.domElement);
controls.enableDamping = true;
controls.screenSpacePanning = true;

const pmrem = new PMREMGenerator(renderer);
const studioEnv = pmrem.fromScene(new RoomEnvironment(), 0.04).texture;
/** Approximation of the dimension's baked nebula (violet zenith, magenta band, indigo
 * floor) used only as the environment for Dimension mode; the lights are the game's. */
const dimensionEnv = (() => {
  const s = new Scene();
  s.add(new Mesh(new SphereGeometry(10, 48, 24), new ShaderMaterial({
    side: BackSide, vertexShader: 'varying vec3 vP; void main(){ vP = position; gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0); }',
    fragmentShader: 'varying vec3 vP; void main(){ float y = normalize(vP).y; vec3 c = mix(vec3(0.05,0.02,0.16), vec3(0.42,0.16,0.78), smoothstep(-0.4, 0.7, y)); c += vec3(0.7,0.18,0.55) * exp(-pow((y-0.08)/0.16, 2.0)) * 0.6; gl_FragColor = vec4(c, 1.0); }',
  })));
  return pmrem.fromScene(s, 0.02).texture;
})();
const key = new DirectionalLight('#fff4e8', 2.6);
key.castShadow = true; key.shadow.mapSize.set(2048, 2048); key.shadow.radius = 6;
const fill = new DirectionalLight('#cfdcff', 0.8), rim = new DirectionalLight('#ffffff', 1.6);
const studioHemi = new HemisphereLight('#bfc6d6', '#2a2c31', 0.35);
// The Lighting.tsx rig: violet hemisphere and a warm 5.2 key.
const dimHemi = new HemisphereLight('#6c43d6', '#160b34', 0.75);
scene.add(key, key.target, fill, rim, studioHemi, dimHemi);
const ground = new Mesh(new PlaneGeometry(1, 1), new ShadowMaterial({ opacity: 0.28 }));
ground.rotation.x = -Math.PI / 2; ground.receiveShadow = true;
scene.add(ground);
let grid: GridHelper | null = null;

const atmosphere = createAtmosphereUniforms();
const rockTextures = loadRockTextures(renderer, 8);
const surfaceMaps = { albedo: rockTextures.maps.top.albedo, arm: rockTextures.maps.top.arm };
const clay = new MeshStandardMaterial({ color: '#9a9ea6', roughness: 0.62, metalness: 0 });
const wire = new MeshStandardMaterial({ color: '#c8d4ff', roughness: 0.5, metalness: 0, wireframe: true });

type Mode = 'material' | 'clay' | 'wire' | 'dimension';
let mode: Mode = (params.get('mode') as Mode) || 'material';
function applyLighting(): void {
  const dim = mode === 'dimension';
  renderer.toneMapping = dim ? NeutralToneMapping : ACESFilmicToneMapping;
  scene.environment = dim ? dimensionEnv : studioEnv;
  scene.environmentIntensity = dim ? 1.3 : 0.55;
  scene.background = new Color(dim ? '#140a2a' : '#2b2d33');
  key.color.set(dim ? '#ffd9ad' : '#fff4e8'); key.intensity = dim ? 5.2 : 2.6;
  fill.visible = rim.visible = studioHemi.visible = !dim; dimHemi.visible = dim;
  scene.traverse((o) => { if (o instanceof Mesh) for (const m of ([] as Material[]).concat(o.material)) m.needsUpdate = true; });
}

// ---------- display objects ----------
interface Part { readonly mesh: Mesh; readonly original: Material; readonly dimension: Material; readonly component: string }
interface Display {
  readonly root: Group;
  readonly parts: Part[];
  readonly stats: Array<[string, string]>;
  readonly materials: MeshStandardMaterial[];
  readonly labels: Array<{ text: string; at: Vector3 }>;
  readonly timed: Material[];
  readonly modeNote: string;
  readonly textures: string;
  readonly lodChoice?: (lod: number) => void;
}

const loader = new GLTFLoader();
let bust = '';
const gltfCache = new Map<string, Promise<GLTF>>();
const loadGltf = (file: string) => {
  let p = gltfCache.get(file);
  if (!p) { p = loader.loadAsync(`${file}${bust}`); gltfCache.set(file, p); }
  return p;
};
async function glbParts(file: string): Promise<Array<{ geometry: BufferGeometry; material: MeshStandardMaterial }>> {
  const gltf = await loadGltf(file);
  gltf.scene.updateMatrixWorld(true);
  const out: Array<{ geometry: BufferGeometry; material: MeshStandardMaterial }> = [];
  gltf.scene.traverse((o) => { if (o instanceof Mesh) out.push({ geometry: (o.geometry as BufferGeometry).clone().applyMatrix4(o.matrixWorld), material: o.material as MeshStandardMaterial }); });
  return out;
}
function share(source: BufferGeometry, attributes: Record<string, BufferAttribute | InstancedBufferAttribute>): BufferGeometry {
  const g = new BufferGeometry();
  g.setIndex(source.index);
  for (const [n, a] of Object.entries(source.attributes)) g.setAttribute(n, a);
  for (const [n, a] of Object.entries(attributes)) g.setAttribute(n, a);
  return g;
}
/** Motionless drift attributes: the in-game asset shader with no spin or bob. */
const still = (n: number) => ({
  aBob: new InstancedBufferAttribute(new Float32Array(n * 4).map((_, i) => (i % 4 === 3 ? 1 : 0)), 4),
  aSpin: new InstancedBufferAttribute(new Float32Array(n * 4).map((_, i) => (i % 4 === 1 ? 1 : 0)), 4),
  aPhase: new InstancedBufferAttribute(new Float32Array(n), 1),
});
const triangles = (g: BufferGeometry) => (g.index ? g.index.count : g.getAttribute('position').count) / 3;
const fmtLen = (m: number) => (m < 0.1 ? `${(m * 1000).toFixed(1)} mm` : m < 1 ? `${(m * 100).toFixed(1)} cm` : `${m.toFixed(2)} m`);
const fmtSize = (s: Vector3) => `${fmtLen(s.x)} × ${fmtLen(s.y)} × ${fmtLen(s.z)}`;

async function glbDisplay(entry: Entry): Promise<Display> {
  const parts = await glbParts(entry.file!);
  const root = new Group();
  const out: Part[] = [];
  for (const p of parts) {
    const mesh = new InstancedMesh(share(p.geometry, still(1)), p.material, 1);
    mesh.setMatrixAt(0, new Matrix4()); mesh.castShadow = true; mesh.receiveShadow = true;
    root.add(mesh);
    out.push({ mesh, original: p.material, dimension: createAssetMaterial(p.material, atmosphere, 'drift', undefined, surfaceMaps), component: p.material.name || 'unnamed' });
  }
  const box = new Box3(); for (const p of parts) { p.geometry.computeBoundingBox(); box.union(p.geometry.boundingBox!); }
  const size = box.getSize(new Vector3());
  const tris = parts.reduce((s, p) => s + triangles(p.geometry), 0), verts = parts.reduce((s, p) => s + p.geometry.getAttribute('position').count, 0);
  const vc = parts.some((p) => p.geometry.getAttribute('color'));
  return {
    root, parts: out, materials: parts.map((p) => p.material), labels: [], timed: out.map((p) => p.dimension),
    stats: [['Kind', 'GLB model'], ['Meshes (draws)', String(parts.length)], ['Materials', String(new Set(parts.map((p) => p.material.name)).size)], ['Triangles', tris.toLocaleString()], ['Vertices', verts.toLocaleString()],
      ['Size (metres)', fmtSize(size)], ['Size (world units)', `${size.x.toFixed(4)} × ${size.y.toFixed(4)} × ${size.z.toFixed(4)} u`], ['Largest dimension', fmtLen(Math.max(size.x, size.y, size.z))],
      ['File size', entry.manifest ? `${(entry.manifest.bytes / 1024).toFixed(0)} KB` : '—'], ['Vertex colours', vc ? 'Yes (COLOR_0 wear tint)' : 'No']],
    modeNote: 'Dimension: in-game asset shader (object-space weathering, haze) under the game light rig.',
    textures: `None embedded (PBR factors${vc ? ' + vertex colour' : ''}). In the dimension: rocks_ground_06 triplanar for ${[...new Set(parts.map((p) => surfaceFor(p.material.name)))].join(', ')} surfaces.`,
  };
}

const MICROBOT_LODS = ['microbot', 'microbot_lod1', 'microbot_lod2'];
const MOTION: Record<FormationKind, readonly [number, number, number]> = { swarm: [1, 0.03, 0], chain: [0, 0, 0.06], cluster: [0, 0.004, 0], inactive: [0, 0, 0] };
async function formationDisplay(entry: Entry): Promise<Display> {
  const f = entry.formation!;
  const root = new Group();
  root.position.set(-f.centre[0], -f.centre[1], -f.centre[2]);
  const holder = new Group(); holder.add(root);
  const n = f.units.length;
  const phase = new InstancedBufferAttribute(new Float32Array(f.units.map((u) => u.phase)), 1);
  const m = new Matrix4(), q = new Quaternion(), one = new Vector3(1, 1, 1);
  const uniforms = createFormationUniforms();
  const [differential, wobble, ripple] = MOTION[f.kind];
  uniforms.uCentre.value.set(...f.centre); uniforms.uAxis.value.set(...f.axis).normalize();
  uniforms.uFormation.value.set(f.omega, f.radius, wobble * f.radius, ripple); uniforms.uFormationMode.value = new Vector4(differential, 0, 0, 0);
  const levels = await Promise.all(MICROBOT_LODS.map((id) => glbParts(ASSETS_FILE(id))));
  const parts: Part[] = [], groups: Group[] = [];
  levels.forEach((lod, k) => {
    const g = new Group(); g.visible = k === 0; groups.push(g); root.add(g);
    for (const p of lod) {
      const mesh = new InstancedMesh(share(p.geometry, { aPhase: phase }), p.material, n);
      f.units.forEach((u, i) => mesh.setMatrixAt(i, m.compose(new Vector3(...u.position), q.set(...u.quaternion), one)));
      mesh.frustumCulled = false; g.add(mesh);
      parts.push({ mesh, original: p.material, dimension: createAssetMaterial(p.material, atmosphere, 'formation', uniforms), component: `LOD${k} ${p.material.name}` });
    }
  });
  const tris = levels.map((l) => l.reduce((s, p) => s + triangles(p.geometry), 0));
  const box = new Box3(); for (const u of f.units) box.expandByPoint(new Vector3(...u.position));
  const size = box.getSize(new Vector3());
  return {
    root: holder, parts, materials: levels[0]!.map((p) => p.material), labels: [], timed: parts.map((p) => p.dimension),
    stats: [['Kind', `Microbot ${f.kind} (dimension layout)`], ['Units', n.toLocaleString()], ['Unit model', 'microbot.glb (approved) / LOD1 / LOD2'],
      ['Triangles (all units, LOD0/1/2)', tris.map((t) => (t * n).toLocaleString()).join(' / ')], ['Formation extent', fmtSize(size)], ['Formation radius', fmtLen(f.radius)],
      ['Unit size', '38.8 mm (never scaled)'], ['Swirl', `${f.omega.toFixed(3)} rad/s about (${f.axis.map((a) => a.toFixed(2)).join(', ')})`]],
    modeNote: 'Dimension: in-game formation shader; Motion runs the model-time swirl, wobble and ripple.',
    textures: 'None (microbot surfaces are clean PBR, as approved).',
    lodChoice: (lod) => groups.forEach((g, k) => { g.visible = k === lod; }),
  };
}
const ASSETS_FILE = (id: string) => catalogue.find((e) => e.id === id)?.file ?? `/assets/models/${id}.glb`;

async function clusterDisplay(entry: Entry): Promise<Display> {
  const list = entry.cluster!;
  const centre = list.reduce((s, d) => s.add(new Vector3(...d.position)), new Vector3()).divideScalar(list.length);
  const holder = new Group(), root = new Group(); root.position.copy(centre).negate(); holder.add(root);
  const byAsset = new Map<string, typeof list[number][]>();
  for (const d of list) byAsset.set(d.asset, [...(byAsset.get(d.asset) ?? []), d]);
  const parts: Part[] = [], materials: MeshStandardMaterial[] = [];
  let tris = 0;
  const m = new Matrix4(), q = new Quaternion(), s = new Vector3(), p = new Vector3();
  for (const [asset, ds] of byAsset) {
    const glb = await glbParts(ASSETS_FILE(asset));
    const attrs = {
      aBob: new InstancedBufferAttribute(new Float32Array(ds.flatMap((d) => [...d.drift.amplitude, d.drift.period])), 4),
      aSpin: new InstancedBufferAttribute(new Float32Array(ds.flatMap((d) => [...d.drift.spinAxis, d.drift.spinRate])), 4),
      aPhase: new InstancedBufferAttribute(new Float32Array(ds.map((d) => d.drift.phase)), 1),
    };
    for (const part of glb) {
      const mesh = new InstancedMesh(share(part.geometry, attrs), part.material, ds.length);
      ds.forEach((d, i) => mesh.setMatrixAt(i, m.compose(p.set(...d.position), q.set(...d.quaternion), s.setScalar(d.scale))));
      mesh.castShadow = mesh.receiveShadow = true; mesh.frustumCulled = false; root.add(mesh);
      parts.push({ mesh, original: part.material, dimension: createAssetMaterial(part.material, atmosphere, 'drift', undefined, surfaceMaps), component: `${pretty(asset)} ×${ds.length}` });
      materials.push(part.material);
      tris += triangles(part.geometry) * ds.length;
    }
  }
  const box = new Box3(); for (const d of list) box.expandByPoint(new Vector3(...d.position).sub(centre));
  return {
    root: holder, parts, materials, labels: [], timed: parts.map((x) => x.dimension),
    stats: [['Kind', 'Debris cluster (dimension layout)'], ['Pieces', String(list.length)], ['Distinct models', String(byAsset.size)], ['Triangles (total)', tris.toLocaleString()],
      ['Cluster extent (centres)', fmtSize(box.getSize(new Vector3()))], ['Scales used', `${Math.min(...list.map((d) => d.scale)).toFixed(2)}–${Math.max(...list.map((d) => d.scale)).toFixed(2)}`]],
    modeNote: 'Dimension: in-game asset shader; Motion runs the model-time drift and spin.',
    textures: 'rocks_ground_06 triplanar on concrete in Dimension mode; otherwise PBR factors.',
  };
}

let engine: SimulationEngine | null = null;
const world = () => (engine ??= new SimulationEngine());
async function terrainDisplay(entry: Entry): Promise<Display> {
  status.textContent = 'Generating island geology…';
  await new Promise((r) => setTimeout(r, 30));
  const island = world().world.islands[entry.islandIndex!]!;
  const data = generateTerrain({ island, index: entry.islandIndex!, cellSize: cellSizeFor(island, entry.islandIndex!, TERRAIN_RESOLUTIONS.performance) });
  const g = new BufferGeometry();
  g.setAttribute('position', new BufferAttribute(data.positions, 3));
  g.setAttribute('normal', new BufferAttribute(data.normals, 3));
  g.setAttribute('terrain', new BufferAttribute(data.terrain, 4, true));
  g.setIndex(new BufferAttribute(data.indices, 1));
  const rock = createRockMaterial({ textures: rockTextures, atmosphere, rim: 0.8 });
  const mesh = new Mesh(g, rock); mesh.castShadow = mesh.receiveShadow = true;
  const root = new Group(); root.add(mesh);
  g.computeBoundingBox(); const size = g.boundingBox!.getSize(new Vector3());
  return {
    root, parts: [{ mesh, original: rock, dimension: rock, component: `${data.archetype} geology` }], materials: [], labels: [], timed: [],
    stats: [['Kind', 'Procedural geology (SDF → surface nets)'], ['Archetype', data.archetype], ['Triangles', (data.indices.length / 3).toLocaleString()], ['Vertices', (data.positions.length / 3).toLocaleString()],
      ['Size (island-local = world units ≈ m)', fmtSize(size)], ['Island radius / height', `${island.radius.toFixed(2)} / ${island.height.toFixed(2)} u`], ['Cell size', `${data.cellSize.toFixed(3)} u (performance)`], ['Generated in', `${data.milliseconds.toFixed(0)} ms`]],
    modeNote: 'Material and Dimension both use the real rock shader; in the dimension a bounded strain (≤ 1.18) is applied by the island transform.',
    textures: 'cliff_side 2K, rocks_ground_06 1K, lichen_rock 1K (CC0 Poly Haven; triplanar).',
  };
}

async function lineupDisplay(entry: Entry): Promise<Display> {
  const root = new Group();
  const parts: Part[] = [], labels: Display['labels'] = [];
  const ids = [...entry.lineup!].sort((a, b) => Math.max(...(ASSET_SIZES[a]?.size ?? [0])) - Math.max(...(ASSET_SIZES[b]?.size ?? [0])));
  let x = 0;
  for (const id of ids) {
    const glb = await glbParts(ASSETS_FILE(id));
    const box = new Box3(); for (const p of glb) { p.geometry.computeBoundingBox(); box.union(p.geometry.boundingBox!); }
    const size = box.getSize(new Vector3()), c = box.getCenter(new Vector3());
    const gap = Math.max(0.02, size.x * 0.25);
    x += size.x / 2;
    const g = new Group(); g.position.set(x - c.x, -box.min.y, -c.z); root.add(g);
    for (const p of glb) {
      const mesh = new InstancedMesh(share(p.geometry, still(1)), p.material, 1);
      mesh.setMatrixAt(0, new Matrix4()); mesh.castShadow = true; g.add(mesh);
      parts.push({ mesh, original: p.material, dimension: createAssetMaterial(p.material, atmosphere, 'drift', undefined, surfaceMaps), component: pretty(id) });
    }
    labels.push({ text: `${pretty(id)} · ${fmtLen(Math.max(size.x, size.y, size.z))}`, at: new Vector3(x, size.y * 1.08 + 0.01, 0) });
    x += size.x / 2 + gap;
  }
  return {
    root, parts, materials: [], labels, timed: parts.map((p) => p.dimension),
    stats: [['Kind', 'True-scale lineup'], ['Models', String(ids.length)], ['Row length', fmtLen(x)], ['Scale', '1 : 1 (metres); camera framing only']],
    modeNote: 'Every model at its exported size; nothing rescaled.', textures: '—',
  };
}

// ---------- selection, views and modes ----------
let catalogue: Entry[] = [];
let refsConfig: ReferenceConfig = { sheets: [], planned: [] };
let refFiles: string[] = [];
let layout: DimensionLayout | null = null;
let current: { entry: Entry; display: Display } | null = null;
let radius = 1;
const centre = new Vector3();
let selectToken = 0;

type ViewName = 'hero' | 'hero2' | 'front' | 'side' | 'top' | 'rear';
const VIEWS: Record<ViewName, { label: string; dir: [number, number, number] }> = {
  hero: { label: '¾', dir: [0.62, 0.32, 0.72] }, front: { label: 'Front', dir: [0, 0.0001, 1] }, side: { label: 'Side', dir: [1, 0.0001, 0.0001] },
  top: { label: 'Top', dir: [0.0001, 1, 0.0001] }, rear: { label: 'Rear', dir: [0, 0.0001, -1] }, hero2: { label: '¾ opposite', dir: [-0.6, 0.28, -0.75] },
};
let view: ViewName = (params.get('view') as ViewName) || 'hero';
function setView(name: ViewName): void {
  view = name;
  const dir = new Vector3(...VIEWS[name].dir).normalize();
  // Fit the bounding sphere to the narrower of the vertical and horizontal fields of view.
  const half = Math.min((camera.fov * Math.PI) / 360, Math.atan(Math.tan((camera.fov * Math.PI) / 360) * camera.aspect));
  const dist = (radius / Math.sin(half)) * 1.02;
  camera.near = Math.max(radius * 0.002, 1e-4); camera.far = radius * 400 + 10; camera.updateProjectionMatrix();
  camera.position.copy(centre).addScaledVector(dir, dist);
  camera.up.set(0, name === 'top' ? 0 : 1, name === 'top' ? -1 : 0);
  controls.target.copy(centre); camera.lookAt(centre);
  controls.minDistance = radius * 0.05; controls.maxDistance = radius * 30;
  controls.update();
  document.querySelectorAll<HTMLButtonElement>('[data-view]').forEach((b) => b.setAttribute('aria-pressed', String(b.dataset.view === name)));
}
function setMode(next: Mode): void {
  mode = next;
  for (const p of current?.display.parts ?? []) p.mesh.material = mode === 'material' ? p.original : mode === 'clay' ? clay : mode === 'wire' ? wire : p.dimension;
  applyLighting();
  document.querySelectorAll<HTMLButtonElement>('[data-mode]').forEach((b) => b.setAttribute('aria-pressed', String(b.dataset.mode === mode)));
  $('modenote').textContent = mode === 'dimension' ? `${current?.display.modeNote ?? ''} Sky environment approximated; lights match src/scene/Lighting.tsx.` : '';
}

function frame(display: Display): void {
  display.root.updateMatrixWorld(true);
  const box = new Box3();
  display.root.traverse((o: Object3D) => {
    if (o instanceof InstancedMesh) { o.computeBoundingBox(); box.union(o.boundingBox!.clone().applyMatrix4(o.matrixWorld)); }
    else if (o instanceof Mesh) { o.geometry.computeBoundingBox(); box.union(o.geometry.boundingBox!.clone().applyMatrix4(o.matrixWorld)); }
  });
  const size = box.getSize(new Vector3());
  box.getCenter(centre);
  radius = Math.max(size.length() / 2, 0.005);
  ground.position.y = box.min.y - size.y * 0.01; ground.scale.setScalar(radius * 14);
  key.position.copy(centre).add(new Vector3(radius * 3, radius * 6, radius * 4)); key.target.position.copy(centre);
  const sc = key.shadow.camera; sc.left = sc.bottom = -radius * 2; sc.right = sc.top = radius * 2; sc.near = radius * 0.5; sc.far = radius * 20; sc.updateProjectionMatrix();
  fill.position.copy(centre).add(new Vector3(-radius * 5, radius * 2, radius * 3)); rim.position.copy(centre).add(new Vector3(-radius * 2, radius * 3, -radius * 6));
  if (grid) { scene.remove(grid); grid.dispose(); }
  const step = 10 ** Math.floor(Math.log10(Math.max(size.x, size.z, 1e-3) / 2));
  grid = new GridHelper(step * 40, 40, '#5a6070', '#3a3e48'); grid.position.set(centre.x, ground.position.y + step * 0.001, centre.z);
  grid.visible = $('grid').getAttribute('aria-pressed') === 'true';
  scene.add(grid);
  $('hud').innerHTML = `Grid square <b>${fmtLen(step)}</b> · 1 world unit = 1 m · drag orbit · right-drag pan · scroll zoom`;
}

function badge(el: HTMLElement, s: Entry['status']): void {
  const text: Record<Entry['status'], string> = { candidate: 'Candidate: not approved', approved: 'Approved', wip: 'Work in progress', missing: 'Missing', unregistered: 'Unregistered', layout: 'Dimension layout', procedural: 'Procedural', shader: 'Shader effect', notplanned: 'Not planned', failed: 'Load failed' };
  el.className = `badge ${s}`; el.textContent = text[s];
}

function disposeDisplay(d: Display): void {
  scene.remove(d.root);
  d.root.traverse((o) => { if (o instanceof Mesh) o.geometry.dispose(); if (o instanceof InstancedMesh) o.dispose(); });
  for (const p of d.parts) if (p.dimension !== p.original) p.dimension.dispose();
}

async function select(id: string): Promise<boolean> {
  const entry = catalogue.find((e) => e.id === id);
  if (!entry) return false;
  const token = ++selectToken;
  document.querySelectorAll<HTMLElement>('.item').forEach((el) => el.setAttribute('aria-selected', String(el.dataset.id === id)));
  badge($('badge'), entry.status); $('title').textContent = entry.label; $('file').textContent = entry.file ?? entry.note ?? '';
  history.replaceState(null, '', `?asset=${encodeURIComponent(id)}${mode !== 'material' ? `&mode=${mode}` : ''}`);
  if (current) { disposeDisplay(current.display); current = null; }
  $('labels').innerHTML = ''; labelEls.length = 0;
  status.classList.remove('error');
  renderInspector(entry, null);
  if (entry.kind === 'planned' || (entry.kind === 'glb' && !entry.manifest && entry.status === 'missing')) {
    status.textContent = `${entry.status === 'shader' ? 'Shader effect — no mesh to inspect' : entry.status === 'notplanned' ? 'Deliberately not modelled' : 'Missing — no exported model'}\n${entry.note ?? ''}`;
    publish(entry, null); return true;
  }
  status.textContent = 'Loading…';
  try {
    const display = entry.kind === 'glb' ? await glbDisplay(entry) : entry.kind === 'formation' ? await formationDisplay(entry)
      : entry.kind === 'cluster' ? await clusterDisplay(entry) : entry.kind === 'terrain' ? await terrainDisplay(entry) : await lineupDisplay(entry);
    if (token !== selectToken) { disposeDisplay(display); return false; }
    scene.add(display.root);
    current = { entry, display };
    frame(display); setView(view); setMode(mode);
    status.textContent = '';
    renderInspector(entry, display);
    publish(entry, display);
    return true;
  } catch (error) {
    if (token !== selectToken) return false;
    entry.status = 'failed'; badge($('badge'), 'failed'); renderCatalogue();
    status.textContent = `Could not load ${entry.file ?? entry.id}: ${error instanceof Error ? error.message : String(error)}`;
    status.classList.add('error');
    publish(entry, null, String(error));
    return false;
  }
}

function renderInspector(entry: Entry, d: Display | null): void {
  const dl = (rows: Array<[string, string]>) => rows.map(([k, v]) => `<dt>${k}</dt><dd>${v}</dd>`).join('');
  $('stats').innerHTML = dl(d ? [...d.stats, ['Textures', d.textures]] : [['Status', entry.note ?? '—']]);
  if (d && entry.note) $('stats').innerHTML += dl([['Note', entry.note]]);
  const hex = (c: Color) => `#${c.getHexString()}`;
  $('materials').innerHTML = d && d.materials.length ? [...new Map(d.materials.map((m) => [m.name, m])).values()].map((m) =>
    `<div class="mat"><span class="swatch" style="background:${hex(m.color)}"></span><span>${m.name || 'unnamed'} · metal ${m.metalness.toFixed(2)} · rough ${m.roughness.toFixed(2)}${m.vertexColors ? ' · vertex colour' : ''}</span></div>`).join('') : '<div class="note">—</div>';
  const comps = $('components'); comps.innerHTML = '';
  if (d?.lodChoice) {
    const row = document.createElement('div'); row.className = 'row';
    ['LOD0 (approved)', 'LOD1', 'LOD2'].forEach((label, k) => {
      const b = document.createElement('button'); b.type = 'button'; b.textContent = label; b.setAttribute('aria-pressed', String(k === 0));
      b.onclick = () => { d.lodChoice!(k); row.querySelectorAll('button').forEach((x, j) => x.setAttribute('aria-pressed', String(j === k))); };
      row.appendChild(b);
    });
    comps.appendChild(row);
  } else if (d) {
    const names = [...new Set(d.parts.map((p) => p.component))];
    for (const name of names) {
      const id = `c-${Math.random().toString(36).slice(2)}`;
      const div = document.createElement('div'); div.className = 'comp';
      div.innerHTML = `<input type="checkbox" id="${id}" checked><label for="${id}">${name}</label><button type="button">Solo</button>`;
      const box = div.querySelector('input')!;
      box.onchange = () => d.parts.filter((p) => p.component === name).forEach((p) => { p.mesh.visible = box.checked; });
      div.querySelector('button')!.onclick = () => comps.querySelectorAll<HTMLDivElement>('.comp').forEach((c) => {
        const solo = c === div; const cb = c.querySelector('input')!; cb.checked = solo; cb.dispatchEvent(new Event('change'));
      });
      comps.appendChild(div);
    }
  }
  void fetchValidation(entry);
  const spec = entry.spec;
  const largest = entry.manifest ? Math.max(...entry.manifest.size) : null;
  $('registry').innerHTML = spec ? dl([['Category', spec.category], ['Intended size', `${spec.intendedLength[0]}–${spec.intendedLength[1]} m (largest dim.)`],
    ['Measured', largest === null ? '—' : `${fmtLen(largest)} ${largest >= spec.intendedLength[0] && largest <= spec.intendedLength[1] ? '✓ within range' : '✗ outside range'}`],
    ['Scale variation', spec.scaleVariation[0] === spec.scaleVariation[1] ? 'fixed (1.0)' : `${spec.scaleVariation[0]}–${spec.scaleVariation[1]}`], ['Source', spec.scaleSource]]) : '<dt>—</dt><dd>Not a single registry asset</dd>';
  const refs = referencesFor(entry, refsConfig, refFiles);
  $('refs').innerHTML = refs.length ? refs.map((r, i) => `<img src="/design-refs/${encodeURIComponent(r.file)}" alt="${r.title}" title="${r.title}" data-ref="${i}" loading="lazy">`).join('') : '<div class="note">No reference sheet mapped</div>';
  $('refs').querySelectorAll<HTMLImageElement>('img').forEach((img) => { img.onclick = () => openReference(refs, Number(img.dataset.ref)); });
  currentRefs = refs;
}

async function fetchValidation(entry: Entry): Promise<void> {
  const el = $('validation');
  if (entry.kind !== 'glb' || !entry.manifest) { el.innerHTML = '<dt>—</dt><dd>Only for single GLB models</dd>'; return; }
  const get = async (suffix: string) => { try { const r = await fetch(`/assets/models/${entry.id}.${suffix}.json${bust}`); return r.ok ? await r.json() : null; } catch { return null; } };
  const [val, ins] = await Promise.all([get('validation'), get('inspection')]);
  const rows: Array<[string, string]> = [];
  if (val) rows.push(['glTF validator', `${val.issues.numErrors} errors · ${val.issues.numWarnings} warnings · ${val.issues.numInfos} infos`]);
  else rows.push(['glTF validator', 'no report']);
  if (ins) rows.push(['Topology', `${ins.boundaryEdges} open edges · ${ins.nonManifoldEdges} non-manifold · ${ins.degenerateTriangles} degenerate`], ['Signed volume', `${Number(ins.totalSignedVolume).toFixed(4)} m³`]);
  else rows.push(['Topology', 'no inspection report']);
  el.innerHTML = rows.map(([k, v]) => `<dt>${k}</dt><dd>${v}</dd>`).join('');
}

// ---------- references ----------
let currentRefs: Array<{ file: string; title: string }> = [];
let refIndex = 0;
function openReference(refs: Array<{ file: string; title: string }>, i: number): void {
  if (!refs.length) return;
  refIndex = (i + refs.length) % refs.length;
  const r = refs[refIndex]!;
  $('refpane').classList.add('open'); stage.classList.add('narrow'); requestAnimationFrame(() => { resize(); if (current) setView(view); });
  $('reftitle').textContent = `${r.title} (${refIndex + 1}/${refs.length})`;
  ($('refimg').querySelector('img') as HTMLImageElement).src = `/design-refs/${encodeURIComponent(r.file)}`;
}

// ---------- catalogue UI ----------
function renderCatalogue(): void {
  const filter = ($('search') as HTMLInputElement).value.trim().toLowerCase();
  const nav = $('catalogue'); nav.innerHTML = '';
  for (const group of GROUPS) {
    const items = catalogue.filter((e) => e.group === group && (!filter || `${e.label} ${e.id}`.toLowerCase().includes(filter)));
    if (!items.length) continue;
    const details = document.createElement('details'); details.className = 'cat'; details.open = true;
    details.innerHTML = `<summary><span>${group}</span><span>${items.length}</span></summary>`;
    for (const e of items) {
      const div = document.createElement('div'); div.className = 'item'; div.dataset.id = e.id; div.setAttribute('aria-selected', String(current?.entry.id === e.id));
      const meta = e.manifest ? `${(e.manifest.triangles / 1000).toFixed(1)}k` : e.formation ? `${e.formation.units.length}` : e.cluster ? `${e.cluster.length} pcs` : '';
      div.innerHTML = `<span class="name">${e.label}</span><span class="meta">${meta}</span><span class="badge ${e.status}">${{ approved: '✓', wip: 'WIP', missing: '✗', unregistered: '?', layout: 'L', procedural: 'P', shader: 'FX', notplanned: '—', failed: '!', candidate: 'C' }[e.status]}</span>`;
      div.onclick = () => void select(e.id);
      details.appendChild(div);
    }
    nav.appendChild(details);
  }
}

async function loadCatalogue(refresh = false): Promise<void> {
  if (refresh) { bust = `?v=${Date.now()}`; gltfCache.clear(); }
  const [candidates, manifest, refs, files] = await Promise.all([
    fetch(`/assets/models/candidates/manifest.json?v=${Date.now()}`).then((r) => (r.ok ? r.json() as Promise<Record<string, CandidateConfig>> : {})).catch(() => ({})),
    fetch(`/assets/models/manifest.json?v=${Date.now()}`).then((r) => (r.ok ? r.json() as Promise<Manifest> : {})).catch(() => ({})),
    fetch(`${new URL('./references.json', import.meta.url).href}?v=${Date.now()}`).then((r) => r.json() as Promise<ReferenceConfig>).catch(() => ({ sheets: [], planned: [] })),
    fetch('/design-refs/index.json').then((r) => (r.ok ? r.json() as Promise<Array<{ name: string }>> : [])).catch(() => []),
  ]);
  refsConfig = refs; refFiles = files.map((f) => f.name);
  catalogue = buildCatalogue(manifest, refs, layout, world().world.islands, candidates as Record<string, CandidateConfig>);
  renderCatalogue();
}

// ---------- contact sheet ----------
async function contactSheet(): Promise<number> {
  const sheet = $('sheet'), gridEl = $('sheetgrid');
  sheet.classList.add('open'); gridEl.innerHTML = '';
  const entries = catalogue.filter((e) => e.kind === 'glb' && e.manifest);
  const keep = current?.entry.id, keepView = view, keepMode = mode;
  const w = 400, h = 300, prevSize = renderer.getSize(new Vector2()), prevAspect = camera.aspect;
  let done = 0;
  for (const e of entries) {
    $('sheettitle').textContent = `Contact sheet — rendering ${done + 1}/${entries.length} (real GLBs, studio material mode)`;
    if (!(await select(e.id))) continue;
    renderer.setSize(w, h, false); camera.aspect = w / h; setView('hero'); setMode('material');
    renderer.render(scene, camera);
    const fig = document.createElement('figure');
    fig.innerHTML = `<img alt="${e.label}" src="${renderer.domElement.toDataURL('image/png')}"><figcaption><span>${e.label}</span><span class="badge ${e.status}">${e.status === 'approved' ? 'Approved' : 'WIP'}</span></figcaption><figcaption style="padding-top:0;color:var(--muted)"><span>${fmtLen(Math.max(...e.manifest!.size))}</span><span>${e.manifest!.triangles.toLocaleString()} tris</span></figcaption>`;
    fig.onclick = () => { sheet.classList.remove('open'); void select(e.id); };
    gridEl.appendChild(fig);
    done += 1;
  }
  renderer.setSize(prevSize.x, prevSize.y, false); camera.aspect = prevAspect; camera.updateProjectionMatrix();
  $('sheettitle').textContent = `Contact sheet — ${done} models (real GLBs, studio material mode; click to inspect)`;
  view = keepView; mode = keepMode;
  if (keep) await select(keep);
  sheet.classList.add('open');
  return done;
}

// ---------- wiring ----------
for (const [name, v] of Object.entries(VIEWS)) {
  const b = document.createElement('button'); b.type = 'button'; b.dataset.view = name; b.textContent = v.label;
  b.onclick = () => setView(name as ViewName); $('views').appendChild(b);
}
const reset = document.createElement('button'); reset.type = 'button'; reset.textContent = 'Frame'; reset.onclick = () => setView(view); $('views').appendChild(reset);
document.querySelectorAll<HTMLButtonElement>('[data-mode]').forEach((b) => { b.onclick = () => setMode(b.dataset.mode as Mode); });
const toggle = (id: string, on: (v: boolean) => void) => { const b = $(id); b.onclick = () => { const v = b.getAttribute('aria-pressed') !== 'true'; b.setAttribute('aria-pressed', String(v)); on(v); }; };
toggle('spin', (v) => { controls.autoRotate = v; });
toggle('grid', (v) => { if (grid) grid.visible = v; });
let playing = false; toggle('play', (v) => { playing = v; });
$('refbtn').onclick = () => openReference(currentRefs, 0);
$('refclose').onclick = () => { $('refpane').classList.remove('open'); stage.classList.remove('narrow'); requestAnimationFrame(() => { resize(); if (current) setView(view); }); };
$('refprev').onclick = () => openReference(currentRefs, refIndex - 1);
$('refnext').onclick = () => openReference(currentRefs, refIndex + 1);
$('refimg').onclick = () => $('refimg').classList.toggle('zoom');
$('sheetclose').onclick = () => $('sheet').classList.remove('open');
$('contact').onclick = () => void contactSheet();
$('search').oninput = renderCatalogue;
$('refresh').onclick = async () => { const id = current?.entry.id; await loadCatalogue(true); if (id) await select(id); };

function resize(): void {
  const r = stage.getBoundingClientRect();
  renderer.setSize(Math.max(1, r.width), Math.max(1, r.height));
  camera.aspect = Math.max(1, r.width) / Math.max(1, r.height); camera.updateProjectionMatrix();
}
new ResizeObserver(resize).observe(stage);
resize();
let modelTime = 0, last = performance.now();
const labelEls: HTMLSpanElement[] = [];
renderer.setAnimationLoop(() => {
  const now = performance.now(); if (playing) modelTime += (now - last) / 1000; last = now;
  for (const m of current?.display.timed ?? []) { const u = m.userData.uTime as { value: number } | undefined; if (u) u.value = playing ? modelTime : 0; }
  controls.update();
  renderer.render(scene, camera);
  const labels = current?.display.labels ?? [], layer = $('labels'), r = stage.getBoundingClientRect();
  while (labelEls.length < labels.length) { const s = document.createElement('span'); layer.appendChild(s); labelEls.push(s); }
  labelEls.forEach((el, i) => {
    const l = labels[i];
    if (!l || !current) { el.style.display = 'none'; return; }
    const p = l.at.clone().applyMatrix4(current.display.root.matrixWorld).project(camera);
    el.style.display = p.z < 1 ? '' : 'none'; el.textContent = l.text;
    el.style.left = `${((p.x + 1) / 2) * r.width}px`; el.style.top = `${((1 - p.y) / 2) * r.height}px`;
  });
});

interface ViewerApi { ready: boolean; error?: string | undefined; select: typeof select; setView: typeof setView; setMode: typeof setMode; contactSheet: typeof contactSheet; setCamera: (position: number[], target: number[]) => void; bounds: () => { centre: number[]; radius: number }; entries: () => Array<Pick<Entry, 'id' | 'group' | 'kind' | 'status'>>; current: unknown; stats: unknown }
function publish(entry: Entry, d: Display | null, error?: string): void {
  const api: ViewerApi = {
    ready: !error && (d !== null || entry.kind === 'planned' || entry.status === 'missing'), error, select, setView, setMode, contactSheet,
    // Explicit framing for review captures: world-space camera position and look-at target (metres).
    setCamera: (position, target) => { camera.up.set(0, 1, 0); camera.position.set(position[0]!, position[1]!, position[2]!); controls.target.set(target[0]!, target[1]!, target[2]!); camera.lookAt(controls.target); controls.update(); },
    bounds: () => ({ centre: centre.toArray(), radius }),
    entries: () => catalogue.map((e) => ({ id: e.id, group: e.group, kind: e.kind, status: e.status })),
    get current() { return { id: entry.id, status: entry.status, mode, view, parts: d?.parts.length ?? 0, radius }; },
    stats: d ? Object.fromEntries(d.stats) : null,
  };
  (window as unknown as { __viewer: ViewerApi }).__viewer = api;
}

// Boot: catalogue first (fast), then the dimension layout for formations/clusters.
void (async () => {
await loadCatalogue();
const assetParam = params.get('asset');
// `?model=/path.glb` (legacy) and `?asset=file:/path.glb` open any GLB by URL, flagged Unregistered.
const legacyModel = params.get('model') ?? (assetParam?.startsWith('file:') ? assetParam.slice(5) : null);
const initial = (assetParam?.startsWith('file:') ? null : assetParam) ?? (legacyModel ? catalogue.find((e) => e.file === legacyModel)?.id : null) ?? 'microbot';
if (legacyModel && !catalogue.some((e) => e.file === legacyModel)) {
  catalogue.push({ id: `file:${legacyModel}`, label: legacyModel.split('/').pop()!, group: 'Unregistered models', kind: 'glb', refCategory: 'other', file: legacyModel, status: 'unregistered', note: 'Opened by URL; not in manifest.json' });
  renderCatalogue();
  await select(`file:${legacyModel}`);
} else await select(initial);
setTimeout(() => {
  const e = world();
  const sizes = Object.fromEntries(Object.entries(ASSET_SIZES).map(([id, a]) => [id, a.size]));
  layout = layoutDimension(e.seed, placementInputs(e), sizes);
  void loadCatalogue().then(() => {
    renderCatalogue();
    const want = params.get('asset');
    if (want && want !== current?.entry.id && catalogue.some((x) => x.id === want)) void select(want);
  });
}, 50);
})();
