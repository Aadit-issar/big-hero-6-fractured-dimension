# Phase 3 engineering report

Verified on 17 October 2026. Seed `17062026`, model `fractured-2.0` (unchanged). Branch `phase3-world`, based on Phase 2 commit `0d814ba`.

## A. Phase status

**PHASE 3 COMPLETE — VERIFIED**

Every mandatory Definition of Done item is met, with the limitations listed in H. The simulation is untouched: `git diff 0d814ba -- src/simulation` is empty. Phase 4 and ATLAS have not been started.

## B. Visual transformation

- **Geology.** Fourteen faceted placeholder cones were replaced by procedural distance-field landmasses meshed with surface nets. They have stratified cliffs, overhanging lips, broken terraces, jagged crevices, angular fallen blocks, hanging roots, debris and Voronoi-shattered fragments. Three hero forms are cast by identity: Shattered Plateau (`island-01`), Splintered Spire (`island-05`) and Rift Archipelago (`island-03`). The other eleven use four varied supporting forms.
- **Materials.** Three CC0 Poly Haven PBR sets (layered cliff 2K, broken ground 1K, dark lichen basalt 1K) are applied with triplanar projection. Layers are blended from baked cavity/exposure/height attributes, recoloured toward basalt and slate, given strata bands and cavity AO, and carry hazard-driven mineral seams.
- **Lighting.** Phase 2 used flat ambient light plus point lights. Phase 3 uses a fitted-shadow key light, camera-side fill, cyan rim, lavender bounce, sky-derived PMREM environment, aperture point lights, and ACES tone mapping at exposure 1.25.
- **Atmosphere and depth.** A black background with 720 points became a baked nebula sky (dust lanes, galactic band, luminous core, three star layers). There is now sky-coloured aerial haze with height haze, a 2–3 layer cloud sea, and 7–9 distant megastructure silhouettes.
- **Composition.** The opening shot now has a foreground hero island, a middle distance of islands and folds, and a hazy background of megastructures, nebula and clouds. Seven inspection viewpoints were added, plus a HUD-free presentation mode.
- **Folds.** Rings now have glow discs, rock-shard rims and light cast onto terrain. Hazard volumes are fresnel shells instead of wire spheres.
- **Still weak:** island scale is bounded by the clearance envelope (see H), plateau-top blocks look soft and rounded up close, the wide shot remains sparse, and the fracture-region framing (view 4) is the weakest of the renders.

## C. Technical implementation

New modules:

- `src/scene/terrain/`: `noise.ts` (seeded Perlin, fBm, ridged), `surfaceNets.ts`, `archetypes.ts` (density fields and casting), `terrainGenerator.ts` (sampling, slab sampling, attributes), `terrainWorker.ts`, `terrainLibrary.ts` (pool and cache), `rockMaterial.ts`.
- `src/scene/environment/`: `CosmicSky.tsx`, `CloudLayers.tsx`, `DistantScenery.tsx`, `distantLayout.ts`.
- `src/scene/cinematicViews.ts`, `src/rendering/qualitySettings.ts`, `src/rendering/renderReadiness.ts`.

Modified:

- `FloatingIsland.tsx`: the group carries the unchanged simulation matrix, and the detailed mesh is its child.
- `Lighting.tsx`, `SpatialEffects.tsx`, `DimensionScene.tsx`, `ExplorationCamera.tsx` (1–7 viewpoints), `diagnostics.ts` (read-only `render` block).
- `App.tsx` (quality, H, loading veil, terrain prefetch), `HelpOverlay.tsx`, `SimulationControls.tsx` (quality selector), `SimulationHUD.tsx`, `App.css`.

Removed: `src/scene/Environment.tsx`, replaced by `CosmicSky`. `islandGeometry.ts` is kept as the placeholder and for its original tests.

New scripts: `capture-baseline.mjs`, `capture-views.mjs`, `load-profile.mjs`, `shader-profile.mjs`, `terrain-stats.ts`, `inspect-inverse.ts`. `benchmark.mjs` gained readiness waiting, query and viewport arguments.

Technique, assets, material, lighting and environment details are in [PHASE_3_VISUAL_DESIGN.md](PHASE_3_VISUAL_DESIGN.md). Asset licences are in [ASSET_PROVENANCE.md](ASSET_PROVENANCE.md).

Relationship to the simulation: rendering reads `engine.clock.time`, `evaluateField`, `boundedLocalJacobian`, `sampleField(...).hazard` (on the 4 Hz lattice) and graph state. Nothing in `src/simulation/` imports rendering code or quality settings. Cloud drift and aperture shimmer use model time, so they freeze on pause. Terrain is a pure function of island identity and resolution, so reset reproduces it exactly.

## D. Simulation preservation

| Area | Result | Evidence |
| --- | --- | --- |
| Field evolution, analytic derivatives | PASS | All 45 original unit tests unchanged and passing |
| Determinism | PASS | Original determinism tests; new terrain determinism and slab-equivalence tests |
| Fold connectivity, lifecycle | PASS | `connections.test.ts`; browser "connection windows close…" |
| Traversal and branch transfer | PASS | Browser "approaches a real fold, changes reference branch…" |
| Gravity and hazards | PASS | `environmentalPhysics.test.ts`; browser evolution assertions |
| Controls: pause, time scale, reset, flight, R | PASS | Browser `world.spec.ts`, `phase3-world.spec.ts` |
| Quality isolation | PASS | Unit test (engine state identical); browser: switching quality while paused leaves time, connections, debris, island transforms and reference unchanged |
| Island identity and parenting | PASS | Browser: all 14 `island-XX-terrain` meshes are parented to their simulation group |

**Coordinate diagnostic (§13.3).** The HUD can show `NOT-CONVERGED` while the camera sits still at the opening pose. `scripts/inspect-inverse.ts` reproduces this with the simulation alone, no renderer. It converges until t ≈ 10.27 s, when a fold caustic sweeps through the camera position (σ → 0.024). The local branch then terminates, the previous branch is kept, and the residual grows as the field evolves. This is the documented Phase 2 behaviour (inverse failures preserve the previous branch, and there is no silent relocalisation), and the Phase 2 baseline screenshots show the same thing. It is reported honestly and the solver was not changed. Evidence: `docs/evidence/phase3/inverse-status-investigation.txt`.

## E. Visual evidence

All images are genuine application captures from headless Chrome against this repository.

- **Before** (Phase 2, 1440×900): `docs/evidence/phase3/before/opening-view.png` (faceted islands, black void) and `before/island-closeup.png`.
- **After** (same script, viewport and composition, balanced preset): `docs/evidence/phase3/after/opening-view.png` and `after/island-closeup.png`.
- **Side-by-side:** `docs/evidence/phase3/compare-opening-view.png`, `compare-island-closeup.png`.
- **Competition-ready renders** (cinematic preset, 1920×1080, HUD hidden, `docs/evidence/phase3/renders/`):
  - `view-0-cinematic.png`: opening composition, with the foreground plateau, spire and megastructures in haze, nebula and cloud sea.
  - `view-1-cinematic.png`: hero overview (main environment overview).
  - `view-2-cinematic.png`: close geological view of the Shattered Plateau (lit cliffs, strata, fallen blocks, root, fold rings).
  - `view-3-cinematic.png`: mid-distance, with an unstable (amber) fold integrated beside the Rift Archipelago (spatial connection in the environment).
  - `view-4-cinematic.png`: fracture region around the primary fold.
  - `view-5-cinematic.png`: wide fractured-dimension landscape.
  - `view-6-cinematic.png`: Splintered Spire close-up.
  - `view-7-cinematic.png`: Rift Archipelago close-up.
  - Contact sheet: `docs/evidence/phase3/renders-contact-sheet.png`.

Every image above was opened and reviewed. Defects found during iteration and then fixed: near-black albedo, a snow-like star field and purple wash in the sky, black shadow sides with a teal cast, comb-like strata, machined straight cracks, egg-shaped debris, bubbly plateau tops, icicle roots, papery aperture shards, and pinwheel artifacts in the aperture core.

## F. Performance

Environment: Windows 11, AMD Radeon(TM) Graphics (integrated, `0x15E7`) through ANGLE/Direct3D 11, 16 logical CPU threads, Node 24.19, installed Chrome 155 (headless, `--channel chrome`), DPR 1. Each run had a 2 s warm-up after readiness and a 10 s rAF measurement of the opening view. The display is vsync-limited at 60 Hz, so frame times near 16.7 ms mean the GPU and CPU have headroom that these numbers cannot show. Raw JSON: `docs/evidence/phase3/perf-*.json`.

| Build / preset | Viewport | FPS | p50 / p95 / p99 ms | Draw calls | Triangles drawn* | Ready (s)† | Heap after GC |
| --- | --- | --- | --- | --- | --- | --- | --- |
| Phase 2 baseline (`0d814ba`) | 1440×900 | 60.1 | 16.6 / 17.1 / 17.5 | 72 | 12.2 k | 0.7 | 9.1 MB |
| Phase 3 performance | 1440×900 | 60.1 | 16.7 / 17.1 / 17.7 | 77 | 238 k | 4.1 | 10.3 MB |
| Phase 3 balanced (default) | 1440×900 | 60.0 | 16.7 / 17.3 / 17.7 | 77 | 482 k | 5.5 | 10.4 MB |
| Phase 3 cinematic | 1440×900 | 59.9 | 16.7 / 17.2 / 17.7 | 74 | 856 k | 9.4 | 10.5 MB |
| Phase 3 cinematic | 1920×1080 | 57.1 | 16.7 / 18.0 / 33.7 | 69 | 874 k | 18.3 | 10.2 MB |

\* Includes the shadow pass. † Time from navigation until terrain, textures and sky report ready.

Loading behaviour: a veil shows geology/material/sky progress, and placeholders render underneath it. A typical balanced start-up (`scripts/load-profile.mjs`) is about 2.9 s of main-thread WebGL initialisation and shader compilation (about 2.8 s of blocking compiles in total, `shader-compile-balanced.json`: rock 0.67 s, PMREM 0.52 s, sky 0.48 s), then terrain arrives from the workers until about 5.7 s. Optimisations made in response to measurement: sky fBm vectorisation (compile 1.77 → 0.48 s), deferred sky bake, terrain prefetch before canvas mount, and slab-parallel hero sampling (balanced ready time 7.8 → 4.9–5.7 s). The heap is stable (10.2–10.8 MB after GC), the number of GPU geometries is bounded, and there are no page errors. Notable limitation: cinematic start-up at 1080p took 18 s in one run, because it uses finer terrain and a 2048² sky bake. It is intended for screenshots.

## G. Verification

| Check | Result | Detail |
| --- | --- | --- |
| TypeScript | PASS | `npm run typecheck` |
| Unit / numerical / determinism | PASS | **55 tests in 9 files** (45 original, unchanged, plus 10 new terrain/quality tests): `docs/evidence/phase3/unit-tests.log` |
| Browser, production build | PASS | **6 scenarios** (5 original plus Phase 3), real Chrome/WebGL2: `docs/evidence/phase3/browser-production.log` |
| Browser, dev server | PASS | The same 6 scenarios: `docs/evidence/phase3/browser-dev.log` |
| Production build | PASS | `npm run build`: JS 1.22 MB minified, 342 kB gzip (expected chunk-size warning); worker chunk 15 kB; assets copied |
| Asset loading | PASS | Browser test asserts `texturesReady`, no fallback, no failed or ≥400 requests |
| Runtime errors | PASS | No page or console errors. Chrome logs FXC precision warnings (X4122) and a three.js `Clock` deprecation warning, both benign |
| Visual inspection | PASS | All before/after and render images reviewed (E) |

Test expectation changes, all documented:

- Playwright now runs one worker. Parallel pages each start a terrain worker pool, which measured CPU contention instead of the application.
- The two Phase 2 spatial specs wait up to 20 s (previously 8 s) for the diagnostics object, because start-up now includes shader compilation for the new materials.
- No assertion about simulation behaviour was relaxed.

## H. Known limitations

- **Scale.** Rock is kept inside 0.84·(radius + height) so that traversal exits stay outside rock. Islands therefore cannot be made physically larger without changing simulation data, which was not done.
- **Load time.** Load is 4–6 s on balanced, compared with 0.7 s in Phase 2. Terrain is regenerated on every visit (no persistent cache).
- **Surface nets.** At 0.2% of edges, the meshes contain non-manifold pinches (4 faces sharing an edge). There are no open edges, and no visible artifacts were observed. Features smaller than about two cells are smoothed.
- **Distant scenery** is not part of the readiness gate and pops in shortly after the veil lifts.
- **Viewpoint jumps** are free-flight teleports. The reference inverse may report `not-converged` until R restores the opening reference, by design.
- **Deferred to Phase 4:** lensing, portal interiors, energy filaments, bloom and colour grading, volumetrics.
- No unresolved serious defects are known.

## I. Phase 4 readiness

The environment is ready for:

- **Advanced fracture shaders and portal interiors:** replace the glow disc in `SpatialEffects.tsx`. It already has additive materials, a model-time uniform, per-state colours and pooled lights.
- **Spatial distortion:** a screen-space pass can be inserted. Haze is mixed before tone mapping, and tone mapping is the single ACES output transform.
- **Field-driven energy effects:** the rock material already exposes per-island uniforms fed from simulation hazard.
- **Post-processing and grading:** the sky, rock and clouds all output linear HDR, so bloom and grading can be layered on without double colour transforms.

Extension points: `createRockMaterial`, `CosmicSky` (bake shader), `CloudLayers`, `SpatialEffects`, `qualitySettings.ts` (add effect toggles) and `cinematicViews.ts`.

## J. Final handoff

- Workspace: `C:\Users\aadit\BigHero6`. Branch: `phase3-world`. The final commit hash is recorded in the Git log and the session handoff.
- Preview: `npm run build`, then `npm run preview`, then open the printed URL. Append `?quality=cinematic&hud=0` for presentation captures.
- Verify: `npm run typecheck`, `npm test`, `npm run test:e2e`, `npm run build`.
- Renders: `node scripts/capture-views.mjs http://127.0.0.1:4174 docs/evidence/phase3/renders cinematic 1920 1080 0 0,1,2,3,4,5,6,7 4` (against a running preview on port 4174).
- Recommended next action: review the renders, merge `phase3-world` into `master`, then approve Phase 4 explicitly.
