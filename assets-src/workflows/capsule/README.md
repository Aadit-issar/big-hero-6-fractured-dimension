# Capsule family v2 (candidates, not approved)

Source of truth: `Design/Object Designs/ChatGPT Image Oct 17, 2026, 10_46_31 PM.png`. Evidence: `docs/evidence/parallel-assets/capsule/contact-sheet-v2.png` and `v2/`.

## Workflow
- `kit.py`: wide, low profile (spherical-cap heat shield R 4.6 m, 0.60 m shoulder torus, 6 cm ablator lip, convex 18-48 deg backshell,
  deck at 2.59 m, docking tunnel to 2.78 m, 3.91 m across). Sheets live in (theta, s); each band is meshed through a conformal planar
  map with an adaptive quadtree + constrained Delaunay (`mathutils.geometry.delaunay_2d_cdt`). `clip_mesh` here replaces the pylib one
  (pylib duplicates seam vertices, which created internal rim "fences"); `clip_clean` collapses short boundary edges and relaxes the tear.
- `layout.py`: azimuth plan (window -y/front, breach +x, engine bay +y/rear, crew hatch -x), panels, hatches, ports, breach fields.
- `shell.py`: ablator, skin with curled petals and slits, MLI blanket, hat stringers, pressure wall (isogrid outside, cabin inside),
  ring frames, deck. Thickness along finite-difference normals of the displaced sheet.
- `exterior.py`: windows (bezel, liner, glass), crew hatch, engine bay with three nozzles, RCS pods, vents, camera port (replaces the
  v1 grey disc), rails, shoulder fittings, umbilical, docking tunnel, snapped antenna stub. `interior.py`: floor, seat, avionics racks,
  far-wall lockers, small emissive displays, coolant lines, cable looms with torn ends.
- `parts.py`: collar ring, heat-shield panel, upper fragment (RE-01 + camera port), impact fragment.
- `textures.py`: procedural numpy PBR (wall atlas 2048^2, heat-shield atlas 2048x1024, 512 tile sets, 1k fragment region textures,
  div2/div4 copies for LODs). All textures are generated here; no third-party texture assets were added (nothing new for provenance).
- `export.py`: materials and GLB export (no COLOR_0). `build_all.py`: GLBs + LODs (quadric decimation, half/quarter textures) + manifest.

## Run
`python textures.py tiles wall hs frags down` (~8 min, hold the heavy lock), then `python build_all.py [ids]` (bpy venv python).
Contact sheet: `node assets-src/workflows/capsule/contact_sheet.mjs` after gallery captures (`closeups.mjs` = captureCloseups with a port).

## Status
Rebuilt: capsule_shell_remnant, capsule_collar_ring, capsule_heatshield_panel, capsule_upper_shell_fragment, capsule_impact_fragment.
Kept from v1 unchanged: capsule_rcs_thruster, capsule_antenna_broken, capsule_instrument_unit (v1 sources: git history before cae918f).
Markings: generic serials/stencils only (RE-01, A-07, RCS 4, NO STEP, RESCUE...); no agency or company marks.
