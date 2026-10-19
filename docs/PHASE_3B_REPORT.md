# Phase 3B report: the gaseous Fractured Dimension

Verified on 17 October 2026, branch `phase3b-mirror-dimension` (based on Phase 3, `729f278`). Seed `17062026`, model `fractured-2.0`. `git diff 0d814ba -- src/simulation` is empty: the mathematics, fold graph, traversal, gravity, hazards, clock and explorer are byte-identical to Phase 2.

The Design references were replaced twice during this phase. The first set (hard rock, dense debris, crystal shards) was rejected by the user. This report covers the **final** direction: the current `Design/` images, a predominantly gaseous dimension inspired by the *Big Hero 6* portal realm. Work toward the rejected direction (rock cavern, decorative rock formations, cloud-card billboards, dense debris) was removed rather than kept alongside the new direction.

## A. What changed

| Before (Phase 3) | After (Phase 3B) |
| --- | --- |
| Floating islands in open space under a nebula sky | The viewer is inside billowing violet, magenta and cobalt **dimensional gas** with deep blue cavities |
| Rocks were the subject | Gas dominates; islands remain intact but are wrapped in, and subordinate to, the matter |
| One sky nebula | A raymarched volume with real parallax and depth, plus a gaseous sky with one main whirlpool and three secondary eddies |
| No focal force | A golden vortex as the focal point, with the gas twisted into a whirlpool around its axis |
| Wireframe and glass clutter (intermediate attempt) | A few large **displaced-space panes** (windows onto rotated or mirrored views of the dimension) and a reflective **mirror floor** |

Visual regions, all derived from the existing world data:

- **A, Living Nebula:** the chamber around the island field. A cavity opens from the field toward the vortex.
- **B, Distorted Passage:** the entrance corridor behind the opening pose. Gas coordinates are folded with `abs()`, so the cloud walls repeat and mirror into themselves.
- **C, Unstable Current:** at the four sampled hazard points, the simulation's hazard value increases domain-warp turbulence and crest brightness. Luminous motes swirl around them faster as hazard rises.
- **D, Temporary Passage:** only real graph connections whose state is open, unstable, forming or closing part the gas into a passage. The rim glows lavender-cyan, strongest when the connection is open. Closed and inactive connections never open the gas (unit-tested).

## B. Technical changes

New modules (rendering only):

- `src/scene/gas/gasNoise.ts`: tileable 3D Perlin–Worley density plus a Perlin warp channel (RG8, 128³). Seeded, and generated as parallel z-slabs that merge exactly (tested).
- `src/scene/gas/GasVolumePass.ts`: a depth-aware raymarch pass.
  - Marches at half resolution against the scene depth buffer, so gas wraps islands correctly.
  - Uses explicit-LOD mipmapped 3D texture fetches with early-outs.
  - Shading is self-luminous: dark bodies, light-facing crests and rims.
  - The composite step upsamples with a tent filter and applies a linear-light saturation lift.
- `src/scene/gas/gasInputs.ts`: a pure, read-only adapter from the simulation to the gas. It reads fold endpoints and hazard samples on the 4 Hz model lattice.
- `src/scene/gas/GasWorld.tsx`: owns the frame. The pipeline is scene, then gas, then soft bloom, then OutputPass. Each frame it feeds the gas the live island transforms (clearings) and the 4 Hz simulation inputs.
- `src/scene/gas/GasMotes.tsx`: luminous particles whose swirl speed follows the sampled hazard.
- `src/scene/dimension/MirrorPlanes.tsx` (rewritten): displaced-space panes and the mirror floor.

Modified:

- `CosmicSky.tsx`: a gaseous storm with whirlpool eddies.
- `DebrisCurrents.tsx`: now sparse glassy crystals.
- `Vortex.tsx`: premultiplied blending, restrained intensity.
- `DimensionScene.tsx`: Khronos **Neutral** tone mapping, which preserves violet and magenta hues that ACES bleached. Also adds a `?disable=` profiling switch.
- `qualitySettings.ts`: gas steps, gas resolution, motes, crystals and panes per preset.
- `renderReadiness.ts`: the loading veil now also waits for the gas volume (`gasReady`).
- `cinematicViews.ts`: keys 1–9.
- `rockMaterial.ts`: edge glow and wall mode.
- Worker and library: gas-noise jobs.

Removed: the rock cavern, decorative rock formations and their clearance layout, cloud-card billboards, the dense debris field, and the old post-processing component.

Performance implications: the gas is the main new cost. It is bounded by march resolution and step count per preset, and the early-outs roughly halved it (balanced went from 38 to 57 FPS on the uncontended dev run).

## C. Screenshot evidence

All images are real application captures, in `docs/evidence/phase3b/`:

| View | Balanced 1440×900 (`after/`) | Cinematic 1920×1080 (`renders/`) |
| --- | --- | --- |
| Opening (Living Nebula, vortex focal point) | `view-0-balanced.png` | `view-0-cinematic.png` |
| Hero overview | — | `view-1-cinematic.png` |
| Corridor (Distorted Passage) | `view-3-balanced.png` | `view-3-cinematic.png` |
| Mirror floor and displaced panes | `view-4-balanced.png` | `view-4-cinematic.png` |
| Vortex: collapse toward light | `view-5-balanced.png` | `view-5-cinematic.png` |
| Wide reveal | `view-6-balanced.png` | `view-6-cinematic.png` |
| Fracture region (real fold passage) | `view-7-balanced.png` | `view-7-cinematic.png` |

- Before and after: `compare-before-after.png`. The before images are in `before/` (Phase 3 captures).
- References versus application: `compare-references.png`, generated by `scripts/compare-references.py`.
- Contact sheet: `renders-contact-sheet.png`.
- Colour statistics: `colour-statistics.json`. Values below are means over a 320×180 downsample.

  | | References | Application |
  | --- | --- | --- |
  | Saturation | 0.77–0.85 | 0.61–0.84 |
  | Value | 0.61–0.66 | 0.47–0.70 |
  | Vivid-magenta coverage | 0.28–0.35 | 0.20–0.62 |
  | Bright fraction | 0.15–0.23 | 0.005–0.16 |

  Before the palette work, application saturation was 0.49–0.62 and vivid magenta 0.04–0.19.

## D. Verification

| Check | Result | Notes |
| --- | --- | --- |
| Type checking | PASS | `npm run typecheck` |
| Unit tests | PASS | **57/57**: the 45 original tests unchanged, plus terrain, gas-noise determinism and slab merge, gas inputs (only real connections open passages; no engine mutation), mirror floor below all island paths, and preset keys |
| Browser, production build | PASS | **6/6**: `browser-production.log` |
| Production build | PASS | 1.27 MB JS, 356 kB gzip; worker 18 kB (`production-build.log`) |
| Runtime errors | PASS | No page or console errors and no failed requests (asserted by the browser specs) |
| Simulation preservation | PASS | Empty `src/simulation` diff. Traversal, fold lifecycle, pause, time scale, reset, free flight and quality isolation are all browser-verified |

Test expectation changes (no simulation assertion was relaxed):

- The spatial-physics specs and two world specs now wait for `data-render-ready` before flying or reading the HUD. Flight distance per frame is clamped (`min(delta, 0.05)`) and the HUD refreshes on accumulated frame time, so start-up stalls (terrain, gas noise, shader compilation) previously shortened the approach and delayed the HUD readout.
- Vitest uses a 30 s timeout. The terrain test meshes all 14 islands and timed out at 5 s on a loaded CPU.

Performance (installed Chrome 155 headless, ANGLE/D3D11, AMD Radeon integrated GPU, 1440×900, DPR 1, 10 s after readiness; raw JSON in `perf-*.json`):

| Preset | Best observed | Contended run |
| --- | --- | --- |
| Performance | 60.1 FPS, p95 17.5 ms | 19.5 FPS |
| Balanced (default) | 54.6–56.9 FPS, p50 16.7 ms, p95 33 ms | 13.3 FPS |
| Cinematic | 40.3 FPS, p95 33.6 ms (1080p: 28.2 FPS) | — |

Draw calls were 78–95 and triangles 0.22–0.81 M, including shadows. Load time was 4.5–11 s.

**Important:** another, non-headless Chrome session was running on the same integrated GPU throughout. The same build and preset varied by up to 4×, and one run with the gas disabled was slower than one with it enabled. Treat the best-observed column as the realistic figure, and re-benchmark with other GPU applications closed before quoting numbers.

Remaining limitations:

- The gas is self-luminous with a single directional crest tap. There are no shadow rays, so very fine cauliflower detail and crisp cobalt rims are softer than in the references.
- The half-resolution march leaves a fine grain at cloud edges. There are soft halos around island silhouettes, and gas very close to the camera blurs.
- Panes and the mirror floor reflect the baked sky, not the raymarched gas, so their displaced views are softer than the reference panes.
- The opening pose is the explorer's fixed reference pose, so its framing is not art-directed per shot.
- Bloom and colour grading are deliberately light.

## E. Recommendation

The world now reads as a predominantly gaseous, violet, magenta and cobalt dimension with a golden whirlpool, restrained mirror and fold cues, and subordinate islands. It is clearly aligned with the current references, while the simulation is preserved and verified.

Before Phase 4: re-run the benchmarks on an otherwise idle machine. If balanced drops below 45 FPS there, lower `gas.steps` or `gas.resolutionScale`. Then approve Phase 4 (lensing, gas-aware panes, temporal accumulation for the march, and grading) explicitly.
