# Dimension Phase 5: release pass (18 Oct 2026)

Branch `dimension`. Simulation, sensors, shared contracts, `src/atlas/**` and package files are unchanged; the microbot is unchanged (sha256 `efceac86…f37329d`). Run instructions: `docs/DIMENSION_FINAL_DEMO.md`.

## Performance (production build, 1440×900, DPR 1, headless Chrome 155, AMD Radeon integrated GPU via ANGLE D3D11)

`scripts/benchmark.mjs` and `scripts/frame-pacing.mjs` both measure rAF frame **intervals**, not GPU time. Codex's ATLAS servers were running throughout, and run-to-run spread on this machine is about ±5 FPS; ranges cover the runs made today.

| Preset | Phase 4 avg FPS | Phase 4 p95 | Phase 5 avg FPS | Phase 5 p50 / p95 / p99 | Frames > 50 ms (10 s) | Long tasks | Draw calls / triangles |
|---|---|---|---|---|---|---|---|
| performance | 59.1 | 17.7 ms | 60.1 | 16.7 / 17.3 / 17.9 ms | 0 | 0 | 220 / 1.9 M |
| balanced | 36.0 | 83 ms | 42–50 | 16.7 / 33.5 / 33.9 ms | 0 (was 40) | 0 (was 40) | 328 / 3.0 M |
| cinematic | 22.8 | 133 ms | 27–33 | 33.3 / 50.2 / 50.5 ms | 20 | 0 | 324 / 3.9 M |

Evidence: `docs/evidence/phase5-final/perf/`.

### Periodic stalls: root cause and fix
- **Symptom.** All 40 frames over 50 ms per 10 s coincided with main-thread long tasks every 250 ms (`frame-pacing.mjs`).
- **Diagnosis.** The CPU profile (`scripts/cpu-profile.mjs`) showed `getProgramInfoLog` taking 1.09 s of 4 s. `GlowPoint` and `Aperture` (in `SpatialEffects.tsx`) rebuilt their `ShaderMaterial` whenever a prop changed, which happened on every 4 Hz hazard update. Disposing the previous material released the last user of its WebGL program, so shaders relinked four times a second.
- **Fix.** Materials are now created once per mount, and props update uniforms only. Result: 0 long tasks.

### Gas cost
- **Measurement.** Disabling layers on balanced showed the gas was the whole GPU budget: gas off gave a locked 60 FPS; bloom, overlay and shears were minor. Shader micro-optimisations gave nothing measurable, because cost scales with pixels × steps (3D-texture bandwidth).
- **First attempt.** A per-pixel checkerboard gave nothing either, since 2×2 quads and wavefronts still run the march.
- **Fix.** The march now renders alternating full-resolution columns into a half-width target each frame. An interleave pass merges them with the previous frame's other half, and the existing Gaussian blends the two phases. Resolution and step count are unchanged, and no visible artifacts appear in stills or the recording.
- **Remaining.** After this, debris triangles are the balanced limiter (debris off gives 60 FPS). Tightening LOD distances showed no measurable gain, so they are unchanged.

### Resource lifecycle
- **Leak.** Each quality switch leaked 11 GPU textures: the bloom pass's render targets, the output pass and the depth textures. `EffectComposer.dispose()` frees only its own targets.
- **Fix.** All passes and depth textures are now disposed. Balanced's texture count after perf/bal/cine round trips went from 183, 195, 217, 228, 250 to 173 every time (`scripts/lifecycle-check.mjs`; geometry count is stable).

## Fold-approach test
- **Cause.** Flight integrates `min(delta, 0.05)`, so each 67–83 ms relink stall discarded part of a frame's motion. At about 40 stalls per 10 s, the explorer covered less ground than expected and could miss the test's 9 s approach deadline under load.
- **Result.** With the stalls removed, the test passed 18 of 18 targeted repeats (8 + 10) and both full-suite runs (one of them against the production preview). No timeouts, assertions or simulation code were changed. The original failure trace was not retained, so this cause is inferred from the measured mechanism rather than from a captured failure.

## Experience polish
- **HUD.** The field readout is compact by default (model time, seed), with **I** or the **Details** button to expand it. All 6–9 px labels are now 10–11 px, and accents are lavender (the dimension palette) instead of cyan. **H** hides the HUD, and `?hud=0` works as before.
- **Controls.** Held keys are now also released when the tab is hidden; window blur and Esc were already handled.
- **Floor.** Fully dissolved floor fragments no longer write depth. This removes the straight floor-edge line through the gas seen from high viewpoints.
- **Loading.** Unchanged and already truthful: real per-stage counts, no percentage, lifting at render-ready (about 9–14 s).
- **Viewpoints.** All 1–9 and Shift+1–9 views were captured and reviewed; none clip.

## Validation (this tree)
- `npm run typecheck`: exit 0.
- `npm test`: 92/92.
- `npm run build`: passes.
- `npx playwright test`: 8/8 against the dev server, and 8/8 against the production preview (`E2E_BASE_URL=http://127.0.0.1:4174`).
- Fold-approach test: 10/10 repeated.
- Lifecycle check: no console errors.

## Evidence (`docs/evidence/phase5-final/`)
- `final/01…10`: hero/opening, capsule, real fold, cosmetic rifts, island, debris and wall breach, vortex, wide fold ridge, clean presentation, production balanced frame.
  - Frames 01–09 are cinematic 1920×1080 from the production preview with the HUD hidden; 10 is balanced 1920×1080.
- `contact-sheet-final.jpg`, plus `cinematic/` (16 frames).
- `walkthrough/dimension-walkthrough-performance.webm`: a 38 s real browser recording (Playwright, performance preset) covering the opening, flight, capsule, island, rift, fold approach and vortex.

## Remaining limitations
- **Release-blocking:** none known.
- **Important:**
  - Balanced reaches 42–50 FPS, not 60, on this iGPU; debris triangles are the remaining cost.
  - Cinematic runs at 27–33 FPS, which is fine for stills and slow camera work.
- **Cosmetic:**
  - The capsule hero sits upright.
  - The concrete wall opening is rounded.
  - The fold aperture's jagged lip aliases slightly at long range.
- **Deferred:** Baymax LOD2 files are broken but unused (LOD1 is their farthest level).

## ATLAS readiness
Simulation semantics, fold identities and connections, timing and the sensor contract are untouched, so ATLAS can build on them. No ATLAS integration exists in this branch.
