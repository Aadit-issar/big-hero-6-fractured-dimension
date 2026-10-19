# Phase 2 engineering report

Verified on 17 October 2026. Default seed: `17062026`; model: `fractured-2.0`.

## A. Phase status

**PHASE 2 COMPLETE — VERIFIED**

Mathematics, graph, traversal, branch handling, environmental effects, existing controls, automated checks, production browser execution, screenshot review and performance measurement are complete. No Phase 3 or ATLAS implementation was started.

## B. Mathematical results

The governing equation remains

```text
Φ(q,t)=Σ Aᵢsin(kᵢ·q−ωᵢt+θᵢ)+λΣᵢ<ⱼAᵢAⱼsin(uᵢ)sin(uⱼ)
X=7.5[q+4∇Φ]; J=I+4HΦ
```

Four original seeded wave draws and all fourteen terrain identities are preserved. Phase 2 scales original wave vectors by2, angular frequencies by.16 and shifts phase by−20ω. Amplitudes [.12,.20) and coupling [.24,.32) are unchanged. Original Phase 1 generation/mapping remains available; Phase 2 intentionally produces different trajectories for the same seed under its new versioned configuration.

A reproducible 19-configuration search evaluated38,475 grid/time samples. Phase 1 had minimum singular value .92054 and no samples below.08. The selected regime has minimum .0003324, **6.37% below.08**, **72.05% above.5**, determinant range[-.29480,2.52672], median displacement5.317u, p95 10.141u and sampled maximum12.161u. Every evaluation was finite. A conservative analytic displacement bound is26.91u for generated parameters at any time.

Analytical gradient, Hessian, normalized/world Jacobian and deformation velocity are tested against finite differences. Symmetric eigenvalues provide minimum absolute stretch and fold orientation. Long-time/multiple-seed tests remain finite through7,200 model seconds. This is a fictional coordinate model; neither negative determinant nor near-singularity alone creates a traversable connection.

Evidence: [parameter search](evidence/parameter-search.json), [full mathematical specification](MATHEMATICAL_MODEL.md).

## C. Spatial connectivity

Sparse eigenvalue sign-change discovery, bounded bisection and deterministic clustering identify anchor regions. Eight selected anchors track roots along fixed reference lines on a .25-second model-time lattice. This is bounded regional coverage, not a global detector.

Connections require a real root, root σ<.08, reference separation≥1.8, world separation<6u, opposite directional stretch, endpoint σ≥.06 and hazard<.85. Their lifecycle reconstructs from explicit time with one second of sampled lookahead/history; it does not accumulate rendering-frame state. The graph exposes active edges, region adjacency and individual connection state.

The default start contains **eight usable connections**. Example F01 joins points1.9 reference units apart (14.25u before deformation) whose mapped separation is1.619u; root σ=.0000957. F05 becomes unstable14.75s, closing15.25s and closed16.25s; it forms again48.5s and becomes usable49.5s. F08 is closed6.75s and usable again45s. Some intervals intentionally have no active edges.

In the actual browser, flight approached F04, E changed **origin → F04:B**, moved the actual camera and reference coordinates, preserved quaternion, and allowed subsequent flight. Repeated E was blocked by cooldown. Closing connections reject new entry. Traversal is atomic and checks finite, well-conditioned, clear exits before mutation.

A bounded damped least-squares inverse replaces X/L. Nonconvergence preserves the previous branch and exposes its actual residual. E explicitly selects a nearby endpoint branch when free flight has crossed a caustic; there is no silent global relocalization. Safe exits require σ≥.2, aperture separation>4u and conservative island clearance>1u.

Evidence: [connection metrics/windows](evidence/connection-history.json), `tests/connections.test.ts`, production browser suite.

## D. Environmental systems

- Gravity: `g=−.65(1+h)∇Φ`, in reference units/model second².
- Hazard: `.5C+.25K/(.3+K)+.25V/(8+V)`, using singular compression, Hessian Frobenius curvature and analytic deformation speed. It changes fold stability/cost and probe gravity strength.
- Twelve seeded tethered/damped probes use symplectic Euler at1/60 model second. Identical integer-step replay produces identical positions across frame cadences. A two-minute replay remained finite and confined.
- Four hazard volumes and gravity direction lines provide lightweight diagnostics. Aperture colors reflect actual connection lifecycle; closed indicators are never shown as usable.
- All fourteen island centers use the exact common map. Their local meshes receive bounded first-order strain with stretch[.82,1.18], preventing triangle inversions. Corrected material-group attachments make terrain upper surfaces readable.
- Pause freezes islands, graph, hazards and probes; reset restores all authoritative initial conditions and traversal history.

## E. Technical implementation

New simulation modules: `linearAlgebra.ts`, `spatialModel.ts`, `fractures.ts`, `coordinates.ts`, `explorer.ts`, `debris.ts`. New scene modules: `SpatialEffects.tsx`, `telemetry.ts`, `diagnostics.ts`. Existing engine, camera, islands, environment, HUD, styles and application telemetry are integrated with those APIs.

Added21 unit tests, two browser scenarios and reproducible analysis/benchmark/health scripts. Original24 unit tests remain unchanged. The existing camera regression expectation now derives from the new reference-based opening pose at frozen model time; its movement/look/reset assertions remain. Screenshot output uses unique run directories after reproducing transient Windows locks on overwritten image files.

React19/TypeScript/Vite/Three.js/R3F9 remain. Only `tsx` was added as a development dependency for analysis scripts. No framework, physics engine, shader system or external assets were introduced. CPU mathematics, graph and coordinates remain independent of Three.js. GPU geometries created outside JSX have explicit disposal; caches and profiling buffers are bounded. HUD text is throttled, terrain transforms avoid per-frame React state, and probes are instanced.

GitNexus was refreshed after core changes (449nodes/1,369edges/35flows); its change-impact review identified the expected engine/camera/renderer/HUD flows, covered by regression/browser checks. Its optional full-text extension was unavailable. Serena symbol retrieval had no active language server, so bounded direct source inspection was used. Neither auxiliary limitation blocked development.

Implementation checkpoint: `5c74e17473b21b1338cf8b26037a6ffa9bd36d81`.

## F. Verification

| Check | Result | Actual evidence |
| --- | --- | --- |
| Phase 1 baseline | PASS | Initial HEAD b39ae3b; clean tree; typecheck,24tests and build passed |
| Strict TypeScript | PASS | `npm run typecheck`; also part of production build |
| Unit/numerical/determinism | PASS | **45 tests across8files**, including all original24 |
| Fold/graph/traversal | PASS | Numerical root rules, invalid pairs, lifecycle/request-order reproducibility, explicit branch transfer, safe exits, cooldown and closed rejection |
| Coordinates | PASS | Well-conditioned accuracy, branch continuation, singular status, bounded failure, returned-estimate residual consistency |
| Gravity/hazard/replay | PASS | Computed force response, spatial/time hazard variation, pause/reset, cadence equality and120-second replay |
| Development browser | PASS | Five scenarios,30.9s |
| Production browser | PASS | **Five scenarios,32.4s**, real installed headless Chrome155/WebGL2 |
| Browser health | PASS | No page/console errors, failed requests, context loss or GL errors; all14 actual island transforms finite |
| Screenshot inspection | PASS | Four requested captures opened and reviewed; checkpoint copies below |
| Production build | PASS | JS1,178.33KB minified /324.98KB gzip; expected Vite chunk-size warning |
| Performance | PASS | Actual rAF/WebGL measurements; details below |

Test environment: Windows, Node24, installed Chrome155, ANGLE/D3D11 AMD Radeon(TM) Graphics,1440×900,DPR1, headless. The opening-view benchmark uses2s warmup and8s measurement. Phase1 was measured from an isolated checkout of b39ae3b using the same browser/GPU/viewport; that temporary checkout was removed afterward.

| Metric | Phase 1 baseline | Phase 2 production |
| --- | ---: | ---: |
| Average FPS | 60.05 | 60.05 |
| Mean frame | 16.65ms | 16.65ms |
| p95 frame | 17.0ms | 16.8ms |
| p99 frame | 17.4ms | 17.3ms |
| Maximum frame | 17.7ms | 18.3ms |
| Draw calls | 15 | 72 |
| Triangles | 4,088 | 12,220 |

Phase2 detector mean2.48ms, p953.5ms, maximum4.0ms per raw eight-anchor sample; graph assembly mean.0225ms, p95.1ms. Measurements include capped caches and model-time updates, not millions of Hessians per frame. Draw growth includes proper two-group island rendering and diagnostic apertures/volumes. The baseline used development Vite and Phase2 production preview, so bundle/runtime development overhead differs; these are practical same-machine observations, not controlled hardware-general guarantees.

The8s run retained51 geometries/one texture; post-GC CDP used heap rose from7.48MB to8.51MB while caches warmed. The30s lifecycle run measured60.05FPS, p9517.0ms, p9917.4ms, maximum17.9ms and no runtime errors. Geometry counts fell51→24 as apertures closed; post-GC heap was7.96MB before and9.02MB after cache warmup. Raw heap samples fluctuated rather than increasing continuously. See `evidence/phase2-soak.json`. Heap snapshots, renderer counts and bounded cache capacities are evidence for this short session only, not a claim of exhaustive leak freedom. No lower-end hardware, mobile or non-Chromium performance benchmark was run.

Logs: [unit](evidence/unit-tests.log), [browser](evidence/browser-production.log), [build](evidence/production-build.log), [health](evidence/browser-health.json), [baseline performance](evidence/phase1-performance.json), [Phase2 performance](evidence/phase2-performance.json).

## G. Visual evidence

All four captures were opened and visually inspected. They demonstrate the procedural island field, real graph indicators, actual branch-transfer feedback, stable destination coordinates and gravity/hazard diagnostics. Lighting/material visibility and opening composition were checked; aperture framing and exit conditioning were corrected during verification.

- [Overview](evidence/screenshots/phase2-overview.png): foreground terrain, depth, hazard volumes, fold indicators and HUD.
- [Active fold](evidence/screenshots/phase2-active-fold.png): paired cyan/violet F04 endpoints and valid entrance interaction, including explicitly reported inverse uncertainty.
- [Traversal result](evidence/screenshots/phase2-traversal.png): F04:B reference branch, finite destination and transfer history, reframed through ordinary mouse look after orientation-preservation assertion.
- [Instability](evidence/screenshots/phase2-instability.png): evolved field, amber probes/direction lines, hazard volume and mapped terrain.

Original final-run captures are in `test-results/captures/1792234830006-7504/`; fixed requested copies also exist at `test-results/phase2-*.png`. The copies under `docs/evidence/screenshots/` are retained by Git.

## H. Known limitations

**Expected Phase2 limits:** eight selected anchor regions; sampled safety windows rather than continuous-time certification; simple graph sheet IDs rather than a complete coordinate atlas; inverse uncertainty at caustics; no flight collision system; conservative exit bounds; damped/tethered point probes rather than rigid bodies; bounded affine terrain strain rather than exact nonlinear vertex warping. Some model-time intervals have no open connections. Arbitrary large probe time seeks require bounded repeated replay calls, explicitly reported through `targetReached`.

**Deferred Phases3–5:** detailed terrain, realistic materials, cinematic fracture shaders, volumetrics, polished storms and broad hardware optimisation. ATLAS remains unimplemented and separate from hidden mathematical truth.

**Noncritical:** upstream Three.js/R3F initialization emits a `THREE.Clock` deprecation warning; application model time uses its own clock. Vite reports the expected renderer bundle-size warning. Headless Chrome is the verified browser; mobile input and other engines are not verified.

**Critical blockers:** none known after the recorded checks. The transient screenshot-overwrite issue was repaired by unique capture directories without weakening functional assertions.

## I. Phase 3 readiness

Stable island identities/reference coordinates, exact center mapping, derivative access, bounded local matrices and isolated geometry/material components provide a usable terrain extension boundary. More sophisticated meshes can replace local island geometry while keeping simulation invariants. Future fracture shaders must consume actual graph state and agree with the CPU field; they must not define connectivity. Risk, gravity, edge costs and sampled lifetimes are exposed independently for later navigation/observation work. ATLAS will need a restricted observation layer, not direct use of engineering diagnostics.

No prerequisite blocks Phase3 terrain work. Retain the numerical/browser suites and introduce terrain LOD/performance budgets as mesh complexity rises. **Phase3 has not been started.**

## J. Final handoff

- Workspace: `C:\Users\aadit\BigHero6`.
- Branch: `master`; verified implementation checkpoint: `5c74e17473b21b1338cf8b26037a6ffa9bd36d81`. A following documentation-only commit records this identifier; `git log -1` identifies the final handoff. Working tree was clean after checkpoint creation.
- Preview: `http://127.0.0.1:4174`; development: `http://127.0.0.1:4173` while the launched servers remain running.
- Run: `npm ci`, `npm run dev`; production: `npm run build`, `npm run preview`.
- Verify: `npm run typecheck`, `npm test`, `npm run test:e2e`, `npm run build`.
- Reproduce analysis: `npm run analyze:field`, `npm run analyze:connections`.
- Performance/health: `npm run benchmark -- http://127.0.0.1:4174 test-results/phase2-performance.json`, `node scripts/browser-health.mjs`.
- Report: `docs/PHASE_2_REPORT.md`. No remote push was performed.
- Recommended next action: review this checkpoint and authorize Phase3 terrain/world design when ready. Stop at the Phase2 boundary.
