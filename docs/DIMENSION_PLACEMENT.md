# Dimension placement (branch `dimension-placement`)

## Diagnosis (baseline ee2e537)
84 debris pieces sat in five authored clusters, all within about 40 m of islands 01/02/04 (the densest 20 m sphere held 54 % of all pieces). Only 9 of 132 chamber cells (15 m) were occupied. The far chamber (islands 08–14), the edges, below and above the islands, the entrance and the funnel were empty. Folds: only the nearest 4 connections were drawn, and their additive tears were dimmed by the gas *behind* them, because the gas composite multiplies the scene by the whole ray's transmittance. The 8 simulated folds sit on a single ridge (x ≈ 11–30, z ≈ −2…−58) and are valid about 23 % of the sampled time. That distribution is simulation-owned and was not changed.

## Strategy
The layout is world-anchored, seeded and quality-independent (`src/scene/assets/placement.ts`): capsule crash trail with Baymax armour (mid chamber), wall-breach building fragment (far left), torn industrial structure (far right), funnel breach, Baymax remnants (high back), hazard accumulation zones (top sampled hazard), per-island ecosystems outside each swept path, fold-seam framing outside fold clearance and aperture view cones, low sediment, high drift, vortex inflow, mid-distance anchors from the opening view, and ambient scatter weighted by region (chamber 62 %, funnel 24 %, entrance 14 %) with a seeded low-frequency density field (quiet, medium and dense bands). Clearance is checked with a spatial index. Elongated pieces never line up between nearby islands. No sector streaming, and nothing follows the camera.

## Rendering
- Candidate GLBs are loaded by path from `public/assets/models/candidates/`, with LODs (Baymax LOD2 is never used).
- Textures are de-duplicated by content hash and capped per tier. Geometry-only levels reuse the textured level's materials.
- `DebrisField` applies per-instance LOD, frustum and distance culling, with dithered transitions.
- The luminous overlay pass (`src/scene/gas/overlay.ts`) draws real fold apertures (all current connections, at their simulated endpoints and states) and cosmetic fractures after the gas.

## Metrics (`scripts/placement-plot.py`; chamber = island centres ± (22, 14, 22) m, Halton samples outside island clearance)
| | before | after |
|---|---|---|
| pieces | 84 | 433 |
| median / p90 distance to nearest piece | 41.2 / 67.6 m | 11.6 / 21.0 m |
| 15 m cells occupied | 9 / 132 | 91 / 132 |
| densest 20 m sphere share | 0.54 | 0.07 |

Texture budget (`npx tsx scripts/placement-budget.ts`): 119 / 241 / 423 MB GPU (tiers low/mid/high), 92 MB of GLB download.

## Handoff and requests
- After refined capsule GLBs arrive, run `npx tsx scripts/placement-manifest.ts`. `tests/assetScale.test.ts` fails if this is not re-run.
- Request: an explicit `assets.textureTier` preset field. The tier is currently derived from `lodScale`.
- Evidence: `docs/evidence/dimension-placement/{before,after,compare-*.jpg}`. Camera matrix: `scripts/placement-matrix.json`.
