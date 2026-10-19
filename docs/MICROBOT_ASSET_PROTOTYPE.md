# Microbot asset prototype (first-asset approval gate)

Date: 17 October 2026. Branch `dimension`. Scope: one asset, Hiro's individual microbot. Nothing in the playable dimension was changed.

## A. References inspected

Every image was opened and examined.

- **Environment (`Design/`):** `ChatGPT Image Oct 17, 2026, 07_03_08 PM-1.png`, `…07_03_09 PM-2.png` and `…07_03_11 PM-3.png` (gaseous mirror-dimension art direction).
- **Objects (`Design/Object Designs/`):**

  | Time stamp | Content |
  | --- | --- |
  | `10_46_23 PM` | Microbot sheet: hero render, front/top/side orthographics, swarm, cluster, chain and broken-cluster formations |
  | `10_46_28 PM` | Construction and industrial debris: concrete with rebar, steel beams, scaffold towers, walkways, Krei-branded wall panels, pipes, cables |
  | `10_46_31 PM` | "Abigail Callaghan transport capsule". Contains NASA insignia and generic Apollo-like features that the brief forbids; it will be treated as non-canonical |
  | `10_46_34 PM` | Baymax armour remnants (chest, shoulder, forearm, wing, thruster and joint components) |
  | `10_46_37 PM` | Natural phenomena: dust, energy currents, compressed matter, distorted gas, fold apertures, debris orbits |

**Film evidence: limitation.** The brief refers to a film close-up of the microbot supplied earlier. It is **not present** in this repository, in the ATLAS worktree, or in `Downloads`, `Desktop` or `Pictures` (searched by file type and name). No film still was used.

The model is therefore built from the `10_46_23 PM` sheet. That sheet is AI-generated, but its single-unit design matches every feature the brief attributes to the film still:

- two long, dark, opposing, tapered angular housings;
- a central spherical joint;
- subtle recessed slots and seams;
- restrained black and charcoal materials;
- no neon, eyes, faces, antennae or insignia.

Its proportions were measured from the orthographic panels (silhouette scan of the front view). Its formation panels and other sheets were not used for the unit's form.

## B. Existing dimension audit (read-only; nothing modified)

| Visual | Source | Geometry / material | Purpose | Simulation link | Classification and future action |
| --- | --- | --- | --- | --- | --- |
| Floating "crystal" diamonds | `src/scene/dimension/DebrisCurrents.tsx` | Jittered `OctahedronGeometry`, metallic violet, instanced (90/160/240 per preset) | Decorative | Model-time orbit only | **Decorative placeholder.** Replace with microbots and industrial fragments, or remove |
| Amber faceted chunks | `SpatialEffects.tsx`, `GravityProbes` | `IcosahedronGeometry`, amber emissive, instanced ×12, plus 4 direction lines | **Gravity probes** (`engine.debris`) | Real, integrated by the simulation | **Functional.** Keep the data; restyle as a subtle probe indicator, not debris |
| Small tan/orange octahedra and fresnel spheres | `SpatialEffects.tsx`, `HazardShell` | `octahedronGeometry(.15)`, `sphereGeometry` shell | **Hazard markers** at 4 sample points | `sampleField().hazard` | **Functional.** Keep; subtler marker |
| Rings, glow discs and dodecahedron shards | `SpatialEffects.tsx`, `Aperture` and `FoldIndicator` | `torusGeometry`, additive plane, 8 instanced `DodecahedronGeometry` shards; wireframe octahedra for invalid candidates | **Fold interaction points** (E-traversal) | Graph connection state | **Functional.** Replace the visual with a gas-integrated aperture; must remain locatable |
| Giant transparent triangles and floor | `src/scene/dimension/MirrorPlanes.tsx` | 2/3/5 triangles 70–200 u with barycentric rim seam; sky cube reflection; 700 u floor | Decorative "mirror" | None | **Decorative.** Remove; replace with spatial shear (C) |
| Vortex disc and halo | `src/scene/dimension/Vortex.tsx` | 420 u and 620 u camera-facing planes | Decorative focal point | Model time | Not in scope; keep until a later approved pass |
| Motes | `src/scene/gas/GasMotes.tsx` | Points (1,200/2,400/4,000) | Atmospheric | Hazard-driven swirl | Keep as dimensional dust (E1) |
| Island rock | `FloatingIsland.tsx` and `terrain/` | Surface-nets geology | **Terrain**, simulation transforms | Authoritative | Keep |

Rendering constraints to respect: the raymarched gas pass (`gas/GasVolumePass.ts`) dominates GPU cost on the integrated AMD GPU. Every new object therefore needs instancing and LOD, and must pass the depth buffer so the gas composites correctly. Areas that will need future modification: `DebrisCurrents.tsx`, `MirrorPlanes.tsx`, the `SpatialEffects` visuals, `qualitySettings.ts` (counts), and `DimensionScene.tsx` (mounting).

## C. Proposed future replacement architecture (not implemented)

- **Organisation:** `assets-src/<asset>/build*.ts` holds the parametric source (this pipeline). Exports go to `public/assets/models/<asset>.glb`, with `*.stats.json`, `*.inspection.json` and `*.validation.json` alongside. Licensed third-party assets go to `public/assets/models/thirdparty/`, recorded in `docs/ASSET_PROVENANCE.md`.
- **Loading:** a small `src/rendering/assetLibrary.ts` would hold a cached `GLTFLoader` promise per URL, add an entry to the readiness store, and fall back to a hidden empty mesh on failure.
- **Instancing:**
  - One `InstancedMesh` per (geometry, material) pair. The microbot's three primitives give 3 draws for any swarm size; they could be merged into one primitive with a 3-entry vertex-colour or material palette, giving 1 draw.
  - Instance matrices are computed once from deterministic layouts. Motion is evaluated on the GPU from model time (the pattern already used by `DebrisCurrents`), so there are no per-frame CPU updates per unit.
- **LOD (planned, not built):**

  | Level | Approx. triangles | Description |
  | --- | --- | --- |
  | LOD0 | ~5,900 | This model |
  | LOD1 | ~900 | No seams or slots, 16-segment joint |
  | LOD2 | ~120 | Octagonal arms, low-poly ball |

  Selection is by screen size per instance batch.
- **Deterministic placement:** seeded layouts (`createSeededRandom`) keyed to world data.
  - Microbot chains follow fold corridors between real connection endpoints.
  - Debris accumulations sit near hazard samples.
  - Infrastructure fragments sit near islands, outside the island clearance envelope.
  - Rare landmarks (the capsule, if the story is validated; Baymax pieces) are single, framed placements.
  - Nothing implies a traversable connection that the graph does not contain.
- **Spatial shear replacing the triangles:** remove `MirrorPlanes`. At a few anomaly sites (real open folds, and high-strain points from existing field samples), draw a thin irregular curved boundary. It would combine:
  - (D) a volumetric flow discontinuity: the gas density is sampled with an offset or rotated domain on one side of the boundary, giving a visible mismatch of cloud forms;
  - (A) bounded, depth-aware screen-space refraction along the boundary;
  - (B) optionally, for at most one or two primary folds, a low-resolution displaced-view render target showing the connected endpoint's region.

  Fold apertures become gas cavities whose opening and closing follow the connection's actual state. All of this is to be chosen by performance tests.
- **Phenomena:** dust stays as motes; energy currents become ribbons along gas flow; compressed matter and debris orbits use real debris assets near hazard samples. Gravity disturbances read the existing probe and gravity data.

## D. Completed microbot model

**Process.** A parametric TypeScript script builds hard-surface geometry with no external modelling tool; Blender is not installed. The script is the editable source: every dimension, station, seam and slot is a named parameter.

- **Arms:** a loft of a bevelled octagon (8 main faces plus 8 narrow bevel strips that catch edge highlights) through 16 authored stations:
  - a flat inner face seated into the ball;
  - an inner chamfer up to the maximum section;
  - a seam ring;
  - a two-facet long taper with a crease;
  - a second seam ring;
  - an end chamfer;
  - a stepped, recessed end cap.

  The second arm is a 180° rotation of the first, so the unit is symmetric with consistent handedness.
- **Slots and seams:** real recessed geometry. Each feature is a polygon hole triangulated into the planar loft face, with walls and a floor inset along the face normal. They are:
  - an upper vertical slot and an L-slot on each side face;
  - small slots on the four diagonal faces;
  - a straight and a kinked panel seam on each side;
  - centre seams on the top and bottom faces.
- **Joint:** a lathed sphere around the arm axis with an equatorial seam groove, plus closed octagonal necks that read as short collars.
- **Orientation and normals:** every triangle is oriented against an analytic outward normal. Vertices are welded only where position and normal coincide, so flat facets stay hard-edged and the ball stays smooth.

**Materials (3, no textures):**

| Material | Base colour | Metalness | Roughness |
| --- | --- | --- | --- |
| `microbot_shell` | sRGB-linear 0.02 near-black | 0.45 | 0.40 (satin black metal) |
| `microbot_recess` | darker | 0.15 | 0.85 |
| `microbot_joint` | slightly lighter charcoal | 0.6 | 0.28 |

**Scale and pivot:** origin at the joint centre; arm axis along +x/−x, with +y up and side faces facing ±z. Size is 38.8 × 7.4 × 7.4 mm. The real size is an assumption (fingertip scale), and the asset can be uniformly scaled at placement.

**Reference accuracy:** the measured proportions match the reference front view:
- length to height 5.24, against 5.4 on the reference;
- joint diameter about equal to the arm's maximum height;
- maximum section about 0.14 L from the centre;
- tip height about 0.2 of the maximum.

**Known deviations:**
- Seams are thinner and shallower than in the concept render.
- A short octagonal collar is visible between the ball and each arm; the concept shows the arm meeting the ball directly.
- The ball has only an equatorial seam, without the concept's curved secondary lines.
- Slot placement is approximate.
- No film still was available to confirm canon details.

## E. Files

| Item | Path |
| --- | --- |
| GLB | `public/assets/models/microbot.glb` |
| Editable source | `assets-src/microbot/buildMicrobot.ts` (parameters in `PARAMS`) |
| GLB writer | `assets-src/gltf/writeGlb.ts` |
| Mesh inspection | `assets-src/microbot/inspect.ts`, output in `public/assets/models/microbot.inspection.json` |
| Khronos validation report | `public/assets/models/microbot.validation.json` |
| Export statistics | `public/assets/models/microbot.stats.json` |
| Viewer | `tools/asset-viewer/` (`index.html`, `main.ts`, `vite.config.ts`) |
| Render capture script | `assets-src/microbot/captureRenders.mjs` |
| Typecheck config | `assets-src/tsconfig.json` |
| Renders | `docs/evidence/microbot/01-hero-three-quarter.png` … `10-reference-angle.png`, `contact-sheet.png`, `comparison-reference.png` |

## F. Model statistics

All measured from the exported file.

| Metric | Value |
| --- | --- |
| Meshes | 1 (3 primitives) |
| Materials | 3 |
| Draw calls | 3 |
| Triangles | 5,872 |
| Vertices | 5,266 |
| Textures | none |
| GLB size | 199,432 bytes |
| Bounds | 38.8 × 7.4 × 7.4 mm |
| Welded edges | closed 2-manifold: 0 boundary, 0 non-manifold |
| Degenerate triangles | 0 |
| Non-finite values | 0 |
| Non-unit normals | 0 |
| Winding/normal disagreements | 0 |
| Signed volume per primitive | positive (outward) |

Instancing considerations: 3 draws per swarm with no textures, so the asset is cheap to instance. At 5.9 k triangles, 1,000 visible units would be 5.9 M triangles, so LOD1/LOD2 are required for swarms. Merging the three primitives into a single vertex-coloured primitive would give one draw per LOD.

## G. Verification

| Check | Result |
| --- | --- |
| Khronos glTF Validator 2.0.0-dev.3.10 (Apache-2.0; installed in the scratchpad, not the project) | 0 errors, 0 warnings, 0 infos, 0 hints |
| `inspect.ts` mesh checks on the exported file | All pass (see F) |
| Viewer, Chrome headless | GLB loads through `GLTFLoader`; statistics shown match the file; all 8 views, clay and wireframe modes work; no console or page errors |
| Asset typecheck (`npx tsc -p assets-src/tsconfig.json`) | PASS |
| Project `npm run typecheck` | PASS |
| `npm test` | 60/60 |
| `npm run build` | PASS |

## H. Future readiness

To proceed after approval:

1. Accept or adjust the unit's proportions and details, which are parameters in `PARAMS`.
2. Decide the canonical scale.
3. Build LOD1/LOD2 and a merged single-primitive variant.
4. Write `assetLibrary.ts` and an instanced microbot renderer.
5. Model the debris library with the same pipeline, adding UVs and textures where materials need them.
6. Validate the capsule story before modelling it.
7. Implement the spatial shear, then remove `MirrorPlanes`.

None of these stages has been started.
