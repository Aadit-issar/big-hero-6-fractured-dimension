# Dimension dynamics overhaul

Scope: `src/world/**` (dynamics), `src/scene/dimension/PhysicsVisuals.tsx`, `src/scene/gas/gasInputs.ts`. `src/simulation/**` is untouched; every new term is a composition on top of the existing law and is absent (bit-identical) unless a mover or disturbance opts in.

## The law, extended

Original (unchanged, still what the first four movers obey):

```
q̈ = −k (q − g(t)) − c q̇ − μ ∇Φ(q,t) + a_d1(q,t)          X = L (q + α ∇Φ(q,t))
```

Extended, per mover (all new symbols default to "absent"):

```
q̈ = −k (q − g(t)) − c q̇ − c₂ |q̇| q̇ − μ ∇Φ + (1/m) [ Σ_d a_d(q,t) + a_fold(q,t) ]        ψ̇ = κ_ψ (Σ_d s_d + Σ_f s_f)
```

| symbol | field (`MoverDef`) | meaning |
|---|---|---|
| m | `mass` | inertia against disturbance and fold forces only (Φ already has its own μ = `fieldCoupling`) |
| c₂ | `drag` | quadratic drag: light, flat pieces lose speed fast after a kick, compact ones coast |
| g(t) | `lane` | `ellipse` (original Lissajous), `figure8` (self-crossing), `trefoil` (three lobes) |
| κ | `foldCoupling` | strength of the fold funnel |
| κ_ψ | `spinCoupling` | extra spin angle ψ(t) added to the analytic attitude `q₀ ⊗ spin(rate·t)`; objects visibly spin up inside a disturbance |
| trail | `trail` | the mover system keeps a ring buffer (64 samples, one every 3 ticks = 3.2 s) of the mover's own past mapped positions |

Disturbances (`DisturbanceDef.kind`, `affects`: ids it acts on; absent = every mover, which is how `disturbance-1` still behaves). Gaussian w(r) = exp(−|r|²/2σ²), s(t) = ½ + ½ sin(ωt+φ):

* **swirl** (original): `a = A s w (n̂ × r)/σ`. With `precession`, `n̂(t) = unit(n̂₀ + tilt (cos Ωt u₁ + sin Ωt u₂))`, a rotating shear whose deflection sense turns.
* **sheet** (fracture slip sheet): with h = n̂·r, `a = A s tanh(h/δ) e^(−h²/2(4δ)²) e^(−|r∥|²/2σ²) t̂`. The force flips sign across the surface h = 0: objects on the two sides are slipped in opposite directions along t̂.
* **well** (breathing well): `a = −A p(t) w r/σ`, p = sin(ωt+φ): attracts, then repels, on an 18 s cycle.

Fold funnel (structure-influenced motion, deterministic): `engine.network.getConnections(lattice)` on the 4 Hz lattice gives each valid connection a weight w_f (open 1, unstable 0.85, forming 0.45, closing 0.35, otherwise 0) and its reference-space entry/exit. For each: entry `a −= κ w_f g(|q−e|) (q−e)/ρ` (draws objects in), exit `a += κ w_f g(|q−x|) (û + 0.4 (q−x)/ρ)` with û = unit(exit − entry) (throws them out along the connection), ρ = 0.9. Folds open in bursts (about 40 % of the time), so fold-coupled movers switch regime when the real graph changes. A mover is never moved to the exit: stretch goal (d), traversal with identity continuity, was **not implemented** because at fold sites the map collapses entry and exit to about 1.6 m apart in world space, so a traversal would be indistinguishable from the funnel itself and would add determinism risk.

Integration is unchanged: symplectic Euler at 1/60 s from a lane-aligned seeded state, a pure function of the tick count. Trail samples are recorded only inside the last 192 ticks before the target, so a long jump and frame-by-frame advance produce identical trails.

## Population

Original four unchanged (`CORE_MOVER_DEFS`, same definitions and order; `MOVER_DEFS = [...CORE, ...OVERHAUL]`). Seven new (`OVERHAUL_MOVER_DEFS`), lanes found by `scripts/mover-design.ts` (seeded search; constraints: inside the cavern, clear of rock, ≥ 10 m from the capsule, bounded speed):

| id | asset | m | c₂ | lane | acted on by | fold κ | character |
|---|---|---|---|---|---|---|---|
| shard-glider | baymax_plating_shard | 0.55 | 0.16 | trefoil | sheet, vortex, d1 | – | fast curve-bender |
| heatshield-skimmer | capsule_heatshield_panel | 0.6 | 0.08 | figure8 | sheet, d1 | 2.0 | fast, self-crossing lane |
| joint-orbiter | baymax_joint_shell | 0.8 | 0.02 | ellipse | vortex, d1 | 3.2 | fold-driven |
| collar-ring | capsule_collar_ring | 1.0 | – | ellipse | vortex, d1 | – | spins up in the vortex |
| forearm-tumbler | baymax_forearm_shell | 1.6 | – | ellipse | well, d1 | – | slow tumbler |
| pipe-long | industrial_pipe_large_fractured | 3.0 | – | ellipse | well, d1 | – | heavy, slow |
| slab-drifter | concrete_slab_rebar | 6.0 | 0.1 | ellipse | sheet, d1 | – | very heavy, barely deflected |

Disturbance positions (reference): fracture-sheet (4.3, 2.6, −4.2), breathing-well (−3.2, −0.8, −4.5), precessing-vortex (−0.5, 2.5, −3.0); chosen by `scripts/mover-design.ts` search to sit in free space (≥ 9 m from rock) and ≥ 11 m from the capsule. No new disturbance lists the capsule or the original three; `tests/moversOverhaul.test.ts` proves the original four are bit-identical for t = 0…300 s against a frozen copy of the previous `movers.ts` (`tests/fixtures/moversBaseline.ts`).

## Visual response (rendering only, `PhysicsVisuals.tsx`)

* **Trails**: one additive ribbon mesh (one draw call) through each trailed mover's last 3.2 s, camera-facing, tapering, brightened while the mover is inside a disturbance or fold funnel.
* **Flow lines**: streamlines of each disturbance's own force field (`src/world/flowLines.ts`, RK2 in reference space, then the unchanged map), 12 per disturbance, one `LineSegments` draw call; a travelling brightness pulse shows the force direction; brightness follows the force magnitude, so lines fade where the force fades and the sheet shows anti-parallel lines either side of its seam. One disturbance is re-traced per frame (bounded CPU).
* **Glow**: one `Points` draw call: a soft sprite on any mover whose activity is non-zero, coloured by the dominant disturbance (teal for fold funnels), plus a faint marker per disturbance core.
* **Gas** (`gasInputs.ts`): up to two extra gas shears per frame from the disturbances (sheet: slip along the mapped slip direction with a luminous seam; swirl: shear of the layer normal to the mapped axis), computed from the Jacobian of the same map on the 4 Hz lattice and cached per lattice step. They take precedence over the second fold pair and the strain shears when slots run out (6 total).
* `?disable=trails,fieldlines,glow` toggles each layer.

## Information boundary

ATLAS still sees only observed positions/attitudes (`scanSceneObjects`) and the disturbance regions (position, radius, intensity). Trails, ring buffers, activities and velocities are not serialised. New movers and disturbances will appear in scans and in `disturbances` of the observation; the lead must re-sync `src/world/movers.ts` (and `src/world/trail.ts`, which it now imports) into ATLAS test support.
