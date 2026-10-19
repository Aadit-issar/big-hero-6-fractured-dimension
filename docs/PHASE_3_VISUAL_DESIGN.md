# Phase 3 visual design — The Fractured Cosmic Wilderness

> **Superseded art direction.** Phase 3B replaced the cloud sea, distant scenery and nebula-sky look with a predominantly gaseous dimension matching `Design/`; see `docs/PHASE_3B_REPORT.md`. The terrain, material and lighting sections below still describe the island geology.

This document covers rendering only. Nothing here changes `src/simulation/`; its diff against the Phase 2 commit `0d814ba` is empty.

## Art direction

The environment is a cold, deep-navy cosmos with lavender and violet nebular structure, sparse stars and a lavender cloud sea below the island field. Rock is desaturated basalt and slate with natural luminance variation. Cyan accents mark stable mineral seams and open folds. Amber is reserved for genuine instability: hazard shells, unstable folds, and mineral glow on islands whose sampled hazard is high. Palette anchors: navy `#070B16`, slate `#152333`, basalt `#22272F`, mineral slate `#43576D`, cyan `#66DFE1`, lavender `#806DB0`, violet `#574B85`, amber `#F0A65C`. Colours were tuned by inspecting screenshots, not taken as hard-coded rules.

Composition uses three planes:

- **Foreground:** a detailed, side-lit hero island (the opening view looks across island-01, the Shattered Plateau).
- **Middle distance:** the other islands, fold apertures, gravity probes and hazard shells, fading progressively into sky-coloured haze.
- **Background:** nine decorative megastructure silhouettes 380–900 u away, the cloud sea, the nebula and the stars.

## Terrain

`src/scene/terrain/` generates each island's geology from a signed-distance field, which is meshed with **naive surface nets** (`surfaceNets.ts`). Distance fields give real overhangs, crevices, floating fragments and negative space, which a displaced sphere cannot. Grid boundaries are forced empty, so every surface is closed, and the tests assert there are no open edges.

Techniques that made a visible difference:

- A noisy footprint outline, an overhanging lip, and a tapering, fluted underside with a 0.72-power profile.
- Sawtooth **strata ledges** whose phase wanders with low-frequency noise. Fixed-phase strata produced a regular "comb" silhouette, which was rejected after screenshot review.
- **Broken terraces**: a quantised fBm height field with flat treads and short risers, cached on a 2D lattice.
- **Domain warping** (amplitude 0.45 u on heroes) followed by **vertically stretched ridged multifractal** crags, which read as erosion runnels on cliffs. Top surfaces get much gentler detail.
- Vertical **crevices**: slabs cut inward from the rim, with jagged, noise-displaced walls. Straight slabs looked machined and were replaced.
- **Angular fallen blocks** and debris: rotated, rounded boxes. Ellipsoid boulders looked like eggs and blobs.
- **Hanging roots**: tapered capsules smooth-unioned into the underside, with varied length and lean. Uniform roots looked like icicles.
- **Voronoi shattering** (archipelago forms): one stratified landmass is split into cells, and each cell is offset, so the fragments share strata and origin.
- A **broken shelf** partway down one hero cliff.

Archetypes are cast by stable island identity (`archetypes.ts`):

| Island | Form |
| --- | --- |
| `island-01` | **Hero A — Shattered Plateau**: broad terraced top, 5 crevices, 6 fallen blocks, broken shelf, 4 roots, 8 debris blocks |
| `island-05` | **Hero B — Splintered Spire**: 7 fluted tapered spires, 5 roots, 4 splinter cracks, 5 split-off shards |
| `island-03` | **Hero C — Rift Archipelago**: one plateau shattered into 5 drifted Voronoi fragments, 10 debris blocks |
| other 11 | Supporting `mesa`, `tilted-slab`, `spire`, `shard-cluster`, rotated in identity order (no neighbours share a form), with per-seed proportions |

**Clearance envelope.** All visual rock lies inside a sphere of radius 0.84·(radius + height). The bounded local strain stretches by at most 1.18, so rendered rock always stays strictly inside the explorer's clearance sphere (radius + height). Traversal exits, which require more than 1 u of clearance, therefore never land inside rock. The test `keeps all visual rock inside the explorer clearance sphere…` enforces this. The same constraint bounds how large islands can look; scale is communicated through composition instead.

**Determinism.** Generation is a pure function of the island definition and the cell size. It uses seeded Perlin noise and `createSeededRandom`, and nothing else. Wall-clock time is used only for profiling.

**Performance.** Coarse distances are evaluated on 4³ blocks, and blocks far from the surface are interpolated. Full detail is evaluated only within a shell around the surface. Hero islands are sampled as three z-slabs on separate workers and merged in row order. The test suite asserts the merged result is bit-identical to a single pass. A module-worker pool of 2–6 workers runs the jobs, and terrain prefetch starts as soon as the engine exists. Balanced preset: ≈226 k island triangles (`docs/evidence/phase3/terrain-balanced.json`). Replacing `Math.hypot` with `sqrt` in the hot loops alone cut a coarse distance sample from 2.4 µs to 0.55 µs.

**Attachment.** Each island is a `group` named by its id, with `matrixAutoUpdate=false`. Its matrix is the unchanged Phase 2 transform: the exact mapped centre plus `boundedLocalJacobian`. All geology, debris and roots are child geometry in island-local units, so they move and strain with the parent and never separately. The Phase 2 faceted mesh is shown as a placeholder until the detailed mesh arrives.

## Materials

`rockMaterial.ts` extends `MeshStandardMaterial` through `onBeforeCompile`. It keeps three.js lighting, shadows, PMREM image lighting and tone mapping:

- Three CC0 Poly Haven layers (see `ASSET_PROVENANCE.md`): **cliff** (triplanar `cliff_side`), **top** (top-down `rocks_ground_06`) and **base/underside** (triplanar `lichen_rock`).
- Projection uses object-space position, so textures stick to the rock under the field strain. `textureGrad` with explicit derivatives keeps mip selection valid inside the weight branches. Projections and layers below 1% weight are skipped.
- Normals use whiteout triplanar blending in object space, then the object's `normalMatrix`, which correctly handles the non-orthogonal strain.
- Layer weights come from baked per-vertex attributes: cavity AO (solid rock sampled along the normal), sky exposure (upward-facing and not under an overhang), normalised height, plus low-frequency macro noise to break up repetition.
- Photographic albedo is recoloured toward a geological tint while keeping its luminance structure, so orange sandstone becomes basalt or slate. Cliffs carry alternating cool/warm strata bands that follow object height.
- Cavity AO darkens direct light (at 45%) and attenuates indirect diffuse and specular light. Roughness comes from the ARM map; metalness is 0.
- **Mineral seams** glow faintly only in deep crevices. Their intensity and colour (cyan → amber) follow each island's simulation hazard, sampled on the 4 Hz model-time lattice, so the glow is derived data and never invented events.
- **Aerial perspective** replaces standard fog for rock: distance and height haze blend toward a blurred mip of the baked sky in the view direction, before tone mapping, so silhouettes sink into the nebula colour. Distant scenery uses 0.23× density so it stays legible.

## Lighting and colour management

- Key: cool white directional light (4.6), from the side relative to the opening view. It is the only shadow caster, using PCF shadows. Its orthographic frustum is fitted in light space to the island field plus 14 u of drift padding, rather than covering empty space. Shadow maps are 1024/2048/4096 for performance/balanced/cinematic.
- Fill: cool lavender directional light (1.25) from the camera side, which keeps shadowed cliffs readable. The first screenshots showed near-black shadow sides with a teal cast.
- Rim: cyan from behind the field (0.75). Bounce: lavender from below (0.6). Hemisphere light (1.0). Environment: PMREM of the baked sky (intensity 2.4).
- Folds: two pooled point lights follow the nearest open aperture pair, so fold light falls on nearby rock. The fixed light count avoids shader recompiles.
- ACES Filmic tone mapping, exposure 1.25, sRGB output. Colour maps are sRGB and data maps are linear. Haze is mixed in linear HDR before tone mapping, so it matches the tone-mapped background exactly.

## Cosmic environment

- `CosmicSky.tsx` bakes a static procedural sky once into a half-float cubemap (512/1024/2048). The sky contains a domain-warped nebula, dust lanes, a galactic band, a luminous core behind the opening view, three star layers, and a key-light glow. One bake serves as the background, the PMREM environment and the haze source, and costs nothing per frame. The shader evaluates four noise channels per lattice lookup, because ANGLE/FXC inlines loops: seven scalar fBm loops took 1.77 s to compile, and two vec4 loops take 0.48 s.
- `CloudLayers.tsx` renders 1–3 transparent cloud-sea planes (−36/−62/−98 u). They sample a seeded, tileable baked fBm texture, catch the key light, and dissolve into sky colour with distance. Their drift is driven by **simulation time**, so it stops on pause and replays identically after reset.
- `DistantScenery.tsx` places 4/7/9 seeded megastructures (the same geology at about 8× feature scale) 380–900 u from the field centre, densest along the opening view. They are not in the engine, never move, and never take part in folds, gravity or traversal. A test checks that they lie more than 100 u beyond the simulated field.

## Fold presentation

Fold apertures keep their Phase 2 positions, normals, colours and state logic. Each aperture now has a thin emissive ring, an additive glow disc (ring, halo and a soft core that is stronger when open, with shimmer driven by model time), a fixed seeded rim of rock shards in the aperture frame, and light cast on nearby rock. Hazard volumes are now soft front-face fresnel shells instead of wireframe spheres. Gravity probes are instanced faceted rock with an amber glow. Closed connections still never look usable.

## Camera and presentation

- The opening pose is unchanged: it is the explorer's reference-based pose facing the primary fold, which the regression tests rely on. FOV is 56° (Phase 2 used 63°) to give islands more presence.
- Keys **1–7** select rendering-only framings computed from the islands' current mapped centres: hero overview, geology close-up (lit three-quarter side), mid-distance, fracture region, wide landscape, spire close-up, rift close-up. Selecting one is an ordinary free-flight jump. The reference estimate then continues honestly, so it may report `not-converged`, and **R** returns to the opening reference.
- **H** hides the HUD. `?hud=0` starts hidden, and `?quality=performance|balanced|cinematic` selects a preset; the dock also has a quality selector, remembered in `localStorage`.
- HUD panels are more transparent (glass at about 50–60%) and the vignette is lighter, so the world dominates.

## Quality presets

`src/rendering/qualitySettings.ts` sets DPR cap, shadow map size, terrain cell size, sky cube size, cloud layers, distant structure count/cell and anisotropy. The presets import nothing from the simulation, and the tests check that engine state is identical across presets.

## Known visual limitations

- Island scale is capped by the clearance envelope. In wide shots the field still reads as islands spaced 15–30 u apart, so vastness comes from haze, clouds and distant silhouettes.
- Plateau tops still look a little soft and lumpy up close, and boulders are rounded-box primitives roughened by noise rather than scanned rocks.
- At 0.115 u resolution, surface nets smooths features smaller than about two cells, so very sharp arrises are carried by normal maps.
- Sky resolution in the balanced preset (1024 per face) slightly softens fine nebula wisps. Use cinematic for final renders.
- Distant scenery loads progressively and is not part of the readiness gate. Screenshot tooling waits an extra few seconds.

## Preparation for Phase 4

- Fold visuals are isolated in `SpatialEffects.tsx`, which already has per-aperture additive materials, a model-time uniform and pooled lights. Lensing, portal interiors and energy filaments can replace the glow disc without touching terrain.
- Rock shading is one material factory with named uniforms (mineral colour and intensity, haze). Field-driven emissive or distortion terms can be added there.
- The sky bake is a single shader pass: animated or post-processed skies can reuse its uniforms.
- Tone mapping is ACES with linear-space haze, so a post-processing stack (bloom, grading) can be inserted without double-applying colour transforms.
