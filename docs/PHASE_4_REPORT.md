# Dimension Phase 4: integration and cinematic pass (18 Oct 2026)

Branch `dimension`. Simulation, sensors, shared contracts, `src/atlas/**` and package files are unchanged since the Phase 3B baseline (`git diff 1466da6 HEAD -- src/simulation src/sensors src/shared src/atlas package.json package-lock.json` is empty). The microbot is unchanged (sha256 `efceac86…f37329d`).

## What changed
- **Asset families in the scene.** Concrete (8), industrial (13), Baymax (5) and capsule v2 (8) GLBs are placed by `src/scene/assets/placement.ts` (seeded, world-anchored, no streaming): 433 pieces + 13 microbot formations, replacing the 84-piece central cluster. Method and metrics: `docs/DIMENSION_PLACEMENT.md`.
- **Capsule v2** (`assets-src/workflows/capsule/`): a wide, low hero remnant (≈3.9 m heat shield) with a layered breach and interior, plus a rebuilt collar ring, heat-shield panel, upper shell and impact fragments. The thruster, antenna and instrument unit are reused from v1.
- **Material readability.** Textured candidates use full sky light and a soft lavender bounce (`assetMaterial.ts`), so concrete, paint and armour no longer read as black silhouettes.
- **Concrete slab/wall LODs.** Their LOD1/LOD2 bakes were all black; they are replaced by decimations of LOD0 that draw with LOD0's materials.
- **Gas.** A separable Gaussian on the half-resolution march frame removes the halftone grain. Balanced gas is now 34 steps at 0.42 scale (was 44 / 0.5).
- **Cosmetic spatial damage**, in three classes, all non-traversable and kept 14 m or more from folds, islands, apertures, exits and the opening view:
  - A, rifts: 30–95 m ragged gashes with a dark void, on the cavern walls, the ceiling and the funnel;
  - B, shears: bands showing the gas displaced, around the chamber and at the entrance;
  - C, hairline fissures, from the placement worker.

  Implemented in `src/scene/dimension/{tearLayout.ts,SpatialTears.tsx}` and tested in `tests/placementTears.test.ts`.
- **Real folds.** All current connections are drawn at their exact simulated endpoints and states. Open folds glow Portal Amber with a light-filled interior (was cyan with stripes); other states keep distinct palette colours.

## Validation
- `npm run typecheck`: clean.
- `npm test`: 92/92.
- `npm run build`: passes.
- `npx playwright test`: 8/8 on the full run. A later targeted rerun failed `spatial-physics.spec.ts:18` (fold approach) once, then passed on retry. This is intermittent and not yet diagnosed; no artefact was kept.

## Performance
Production preview, 1440×900, headless Chrome, AMD Radeon integrated GPU (ANGLE D3D11). Codex's ATLAS servers were running at the same time, so treat the numbers as indicative.

| Preset | Avg FPS | p50 ms | p95 ms | Triangles/frame | Draw calls |
|---|---|---|---|---|---|
| performance | 59.1 | 16.6 | 17.7 | 1.91 M | 219 |
| balanced | 36.0 | 16.7 | 83.4 | 2.96 M | 327 |
| cinematic | 22.8 | 33.2 | 133.3 | 3.91 M | 327 |

On balanced, the cost comes from the gas, not the debris: disabling debris gives 31.6 FPS (before the gas change), while disabling gas gives 54.0. The p95 frames are periodic stalls, not a steady load; their cause is not yet found.

## Evidence (`docs/evidence/phase4-final/`)
- `after/`: the 75-pose camera matrix (`scripts/placement-matrix.json`). The matching before frames (ee2e537) are in `docs/evidence/dimension-placement/before/`.
- `compare-empty-regions.jpg`, `compare-crowded-and-overview.jpg`, `compare-folds-fractures-vortex.jpg`, `contact-sheet-after.jpg`.
- `integration/`: capsule in-scene shots, the v2 contact sheet and material close-ups.
- `opening-view-final.jpg`, `benchmark-*.json`.

## Known limitations
- The 8 simulated folds sit on one ridge. That is the protected simulation's layout and was not changed; only their presentation and framing changed.
- On balanced and cinematic there are periodic 80–130 ms frames on this GPU.
- The capsule hero is 102k triangles and carries 46 texture maps (capped at 384/512/1024 px).
- The Baymax LOD2 files are still broken and unused.
- Wall-breach opening shape and slab fracture softness (concrete review notes) were not revisited.
- From the high overview, a faint straight edge of the mirror-floor/gas boundary is still visible.
