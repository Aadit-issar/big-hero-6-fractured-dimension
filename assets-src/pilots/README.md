# Premium asset pilots (candidates, not approved)

Reproducible sources for the two quality-gate candidates. They are **not** used by the dimension.

| Candidate | Replaces | Source | Output |
|---|---|---|---|
| `concrete_slab_premium` | `concrete_slab_rebar` | `concrete_slab_premium.py` | `public/assets/models/candidates/concrete_slab_premium.glb` |
| `steel_girder_premium` | `steel_ibeam_twisted` | `steel_girder_premium.py` | `public/assets/models/candidates/steel_girder_premium.glb` (geometry only; wear bake unfinished) |

Tooling: Blender 4.5 LTS as the `bpy` Python module in a venv **outside** the repository
(`python -m venv C:/Users/aadit/bh6-bpy-venv && C:/Users/aadit/bh6-bpy-venv/Scripts/pip install bpy==4.5.14`).

```
C:/Users/aadit/bh6-bpy-venv/Scripts/python.exe assets-src/pilots/concrete_slab_premium.py --cell 0.005   # ~3 min
C:/Users/aadit/bh6-bpy-venv/Scripts/python.exe assets-src/pilots/steel_girder_premium.py --stage geometry # seconds
python -I assets-src/pilots/prepare_textures.py        # re-fetch and grade the CC0 texture sets (network)
```

`pylib/` holds the reusable parts: seeded noise, surface-nets meshing, sheet-metal grids with sub-cell tear clipping,
rebar and weld sweeps, hex-bolt hardware, plate-with-holes triangulation, material and bake helpers.
Candidates are listed in `public/assets/models/candidates/manifest.json` and appear under "Candidates (under review)"
in the Asset Inspection Gallery.
