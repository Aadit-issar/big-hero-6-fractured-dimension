# Baymax armour workflow

Stylised hard-surface pipeline for Baymax armour remnants (family `baymax_*`, candidates under
`public/assets/models/candidates/baymax/`). Reference: `Design/Object Designs/ChatGPT Image Oct 17, 2026, 10_46_34 PM.png`.

Run: `C:/Users/aadit/bh6-bpy-venv/Scripts/python.exe build_all.py [shoulder forearm chest joint shard] [--nolod] [--notex]`
(hold `C:/Users/aadit/bh6-heavy.lock` while building: texture painting uses ~1 GB). Contact sheet: `node assets-src/workflows/baymax/contact_sheet.mjs`.

Method (all numpy, Blender only for export; deterministic hash noise, no RNG):
- `shell.py`: a smooth parametric surface f(s,t) is clipped by a metric tear field (jagged `jag`, sub-cell clipping), curled at the lip,
  dented, stepped at panel seams, and thickened inward along analytic normals (real shell thickness, grey inner face, exposed rim).
  Wrapped sheets are welded after thickening so there is no seam. Mechanical vocabulary: lathe bearing hubs, ball joint, bolts, pistons, cables, frame ribs.
- `paint.py`: per-part glossy red paint atlas evaluated in 3D (chips to bare grey metal, cellular and star cracks concentrated at damage,
  seams, scuffs, grime, chest emblem, shoulder lilac panel) plus shared grey tile sets (liner, rim, gunmetal).
- `parts.py`: shoulder, forearm, chest, joint shell and plating shard share the same generator (different surface, tear field, internals).

Known limits: shells are simple smooth parametric forms (shoulder reads fairly spherical); internals are modest; LODs use Blender quadric decimation.
