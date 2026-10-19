# Big Hero 6: Fractured — dimension demo runbook

## Launch

```bash
npm install            # once
npm run build          # typecheck + production bundle in dist/
npx vite preview --host 127.0.0.1 --port 4174 --strictPort    # production preview
# development server instead: npm run dev -- --host 127.0.0.1 --port 4173 --strictPort
```

| Purpose | URL |
|---|---|
| **Live judging (smooth on an integrated GPU)** | `http://127.0.0.1:4174/?quality=performance` |
| Live judging (stronger GPU) / default | `http://127.0.0.1:4174/` (balanced) |
| Clean screenshots | `http://127.0.0.1:4174/?quality=cinematic&hud=0` |

The quality chosen with the on-screen **Perf / Bal / Cine** buttons is remembered in the browser; a `?quality=` parameter overrides it. Quality changes rendering cost only (gas, bloom, shadows, terrain resolution, LOD distances, microbot counts). Positions, folds and physics are identical at every level.

The gas renders as sky-like clouds by default: slow drift, large coherent forms with defined edges, sunward self-shadowing. Add `&clouds=legacy` to any URL to get the earlier, softer Phase 5 gas back.

Loading takes about 9–14 s. The veil lists real stages (geology, materials, sky, gas, objects) and lifts only when the scene is ready.

## Controls (verified in `ExplorationCamera.tsx`, `App.tsx`, `SimulationHUD.tsx`)

| Input | Action |
|---|---|
| Drag (left mouse) | Look around (Esc releases the pointer) |
| W A S D | Fly |
| Space / Ctrl | Ascend / descend |
| Shift | Boost |
| E | Enter the real fold you are next to (the hint panel says when) |
| R | Reset the view to the opening pose |
| 1–9 | Cinematic viewpoints: 1 overview, 2 geology, 3 fracture corridor, 4 mirror chamber, 5 vortex, 6 turbulent wide, 7 fracture region, 8 spire, 9 rift close-up |
| Shift+1–9 | Object views: 1 microbot swarm, 2 formation, 3 debris cluster, 4 beams, 5 capsule landmark, 6 fold shear, 7 strain shear, 8 vortex inflow, 9 material close-up |
| H | Hide / show the HUD (presentation mode) |
| P | Pause / resume the simulation (works with the HUD hidden) |
| I | Expand / collapse the field readout |
| Pause button, 0.25× / 1× / 2× | Simulation clock (all motion freezes on pause) |
| ↺ button | Reset the simulation (time, branch, debris) |

Held keys are released automatically when the window loses focus or the tab is hidden.

## Two-minute judge route

1. **Opening (0:00).** Load the judging URL. You see the vortex, a floating island, rifts and wreckage. Press **H** for a clean frame.
2. **Into the chamber (0:15).** Hold **W** for 3 s, then drag left. Concrete and steel wreckage drifts at true scale.
3. **The capsule (0:35).** Press **Shift+5**: Abigail's capsule remnant, with its breach and debris trail.
4. **A real fold (0:50).** Press **H** to show the HUD again and **R** to reset the view, then hold **W** toward the amber aperture until the connection panel reads *E · Traverse fold*. Press **E**: the reference branch changes, which is genuine simulation behaviour. Press **R** to return.
5. **Spatial damage (1:20).** Press **9** (rift close-up) and **7** (fracture region). The dark-void rifts and shears are cosmetic and cannot be entered; the amber apertures are the real folds.
6. **Vortex and close (1:40).** Press **5**, then **1** for the closing wide shot.

**If something goes wrong:** press **R** (view) or ↺ (simulation); reload the page if needed; if the frame rate drops, switch to **Perf**.

## Known limitations

- The eight real folds lie on one ridge; their positions come from the protected simulation.
- On the integrated AMD GPU, balanced runs at about 42–50 FPS and cinematic at about 27–33 FPS (see `docs/PHASE_5_REPORT.md`). Performance holds 60 FPS.
- The capsule sits upright, and Baymax LOD2 files are unused (LOD1 is their farthest level).
