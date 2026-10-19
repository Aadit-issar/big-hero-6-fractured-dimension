# Asset Inspection Gallery

A standalone 3D inspection tool for every physical asset used in the dimension.
It is separate from the playable app (own Vite root, port 4190) and lives in
Claude-owned `tools/asset-viewer/`.

**URL:** <http://127.0.0.1:4190>

**Start:** `npx vite --config tools/asset-viewer/vite.config.ts` (from the repository root).

**Verify:** `node tools/asset-viewer/verify.mjs http://127.0.0.1:4190 docs/evidence/gallery`.

## What it shows (real models only)

| Category | Source | Status shown |
|---|---|---|
| Microbots (model, LOD1, LOD2) | `public/assets/models/*.glb` | Microbot **Approved** (`3ade503`); LODs **WIP** (derived, not separately approved) |
| Concrete & rubble, steel beams, scaffolding, walkways, pipes, cables & electrical, facility panels, capsule components, Baymax remnants | exported GLBs (`assets-src/library`) | **WIP**: procedurally modelled, not yet approved |
| Microbot formations (10) | the dimension's deterministic layout (`src/scene/assets/placement.ts`) | **Dimension layout**: real unit transforms, LOD0/1/2 selectable |
| Debris clusters (8) | the same layout, with real positions, orientations and scales | **Dimension layout** |
| Island geology (14) | generated live by `src/scene/terrain` (performance resolution) with the real rock shader | **Procedural** (not a GLB) |
| True-scale lineups (3) | GLBs side by side at 1:1, labelled with size | — |
| Planned, missing and shader effects | `tools/asset-viewer/references.json` | **Missing** (on a reference sheet, not modelled), **Not planned**, **Shader effect** (tear, shear, motes: not meshes) |
| Unregistered models | in `manifest.json` but not in the scale registry, or opened by URL | **Unregistered** |

## Inspector

- **Shading modes:**
  - Material: the GLB's own PBR material, studio light.
  - Clay.
  - Wireframe.
  - Dimension: the in-game asset shader with object-space weathering and haze, under the game's light rig (violet hemisphere, 5.2 warm key, Neutral tone mapping). The dimension's sky environment is approximated by a violet gradient, and this is stated in the UI.
- **Motion** runs the in-game model-time drift, swirl and ripple in Dimension mode.
- **Views:** ¾, front, side, top, rear and ¾ opposite, plus Frame. Framing is automatic and fits the bounding sphere.
- **Camera controls:** orbit, pan (right-drag) and zoom.
- **Metric grid:** the HUD states the grid square size. 1 world unit = 1 m.
- **Statistics** are measured from what is rendered:
  - meshes, materials, triangles and vertices;
  - size in m, cm or mm and in world units;
  - file size, vertex colours and texture details;
  - units or pieces for formations and clusters.
- **Materials:** a swatch with metal and roughness values for each material.
- **Components:** each glTF primitive can be hidden or soloed (for example, the microbot's shell, recess and joint). Formations switch between LOD levels instead.
- **Validation:** the Khronos validator counts and the topology report (open and non-manifold edges, degenerate triangles, signed volume) from `<id>.validation.json` and `<id>.inspection.json`.
- **Scale registry:** intended size, measured size with a within-range check, allowed scale variation and the source of the estimate.
- **Reference sheets:** images from `Design/Object Designs/` (served read-only at `/design-refs/`). Click one to compare it side by side with the model; ◀ ▶ step between sheets and a click on the image zooms.
- **Contact sheet:** renders every GLB in the browser with the same renderer (studio material mode). Click a tile to inspect that model.
- **Missing files** show an error state with the failing URL. Planned components show what is missing.

## Adding assets later

1. Build them: `npx tsx assets-src/library/buildLibrary.ts`. This updates `manifest.json` and `src/scene/assets/assetSizes.ts`.
2. Register them in `src/scene/assets/assetRegistry.ts`.
3. Press **Refresh catalogue**, or reload. New GLBs appear automatically; unregistered ones are flagged.
4. Map new reference images in `tools/asset-viewer/references.json`. Unmapped images are still listed.

The gallery never modifies or rebuilds models.

URL options:

- `?asset=<id>` selects an entry, for example `?asset=formation:opening-swarm`.
- `&mode=material|clay|wire|dimension` sets the shading mode.
- The legacy `?model=/assets/models/x.glb&capture=1` form, used by `assets-src/library/captureLibrary.mjs`, still works.

## Verification (2026-10-18)

`tools/asset-viewer/verify.mjs`: **65/65 checks passed**, with no console errors (only the D3D X4122 shader-compiler precision notices that the app also logs).

| Area | What was checked |
|---|---|
| Catalogue | All 14 categories present; every manifest model catalogued |
| GLB loading | Every GLB loads and reports the manifest's triangle count |
| Shading | All four modes render |
| Views and camera | All six views; orbit and zoom change the view |
| Arrangements | Formations, clusters, island geology and lineups render; motion in Dimension mode |
| Missing assets | Planned/missing message; a missing file reports a load error |
| References | The comparison pane opens with the sheet loaded |
| Contact sheet | Renders all 26 GLBs |

Screenshots and `verification.json` are in `docs/evidence/gallery/`.
