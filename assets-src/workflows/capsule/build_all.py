"""Build capsule candidates: C:/Users/aadit/bh6-bpy-venv/Scripts/python.exe build_all.py [ids...]

Rebuilt in v2: the hero and the four shell/collar parts. capsule_rcs_thruster, capsule_antenna_broken and
capsule_instrument_unit keep their v1 GLBs (manifest entries are preserved untouched).
LODs: LOD1/LOD2 are quadric decimations of LOD0 with half / quarter resolution textures."""
import json
import os
import sys
import time

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import numpy as np

import kit
import export

ROOT = os.path.abspath(os.path.join(kit.HERE, '..', '..', '..'))
OUT = os.path.join(ROOT, 'public', 'assets', 'models', 'candidates', 'capsule')
ASSETS = {  # id: (label, replaces, lod targets)
    'capsule_shell_remnant': ('Capsule shell remnant (hero)', 'capsule_collar_remnant', (18000, 4500)),
    'capsule_collar_ring': ('Docking collar, separation damage', 'capsule_collar_remnant', (4000, 1200)),
    'capsule_heatshield_panel': ('Heat-shield panel, charred ablator on ribbed carrier', None, (4000, 1200)),
    'capsule_upper_shell_fragment': ('Upper shell fragment with RE-01 stencil and camera port', None, (4000, 1200)),
    'capsule_impact_fragment': ('Impact fragment: folded skin, layers and torn loom', None, (4000, 1200)),
}


# parts: at most two textured materials each (everything else is untextured solid PBR)
REMAP = {
    'capsule_collar_ring': {'rim_metal': 'steel_bright', 'avionics': 'gunmetal', 'whitepaint': 'whitepaint'},
    'capsule_heatshield_panel': {'ablator_rim': 'char_solid', 'pw_outer': 'structure', 'structure_back': 'structure', 'rim_metal': 'steel_bright'},
    'capsule_upper_shell_fragment': {'skin_back': 'primer_solid', 'stringer': 'primer_solid', 'rim_metal': 'steel_bright', 'insulation_rim': 'insulation',
                                     'gunmetal': 'steel_dark', 'whitepaint': 'steel_dark'},
    'capsule_impact_fragment': {'skin_back': 'primer_solid', 'stringer': 'primer_solid', 'rim_metal': 'steel_bright', 'insulation_rim': 'insulation',
                                'frame': 'structure_solid', 'gunmetal': 'steel_dark'},
}


def build(aid):
    if aid == 'capsule_shell_remnant':
        import hero
        return hero.hero(0, ('shell', 'layers', 'hardware', 'interior'))
    import parts
    return {'capsule_collar_ring': parts.collar_ring, 'capsule_heatshield_panel': parts.heatshield_panel,
            'capsule_upper_shell_fragment': parts.upper_fragment, 'capsule_impact_fragment': parts.impact_fragment}[aid](2)


if __name__ == '__main__':
    only = [a for a in sys.argv[1:] if not a.startswith('--')] or list(ASSETS)
    man_path = os.path.join(OUT, 'manifest.json')
    man = json.load(open(man_path)) if os.path.exists(man_path) else {}
    for aid in only:
        label, repl, (l1, l2) = ASSETS[aid]
        t = time.time()
        mesh = build(aid)
        for a, b in REMAP.get(aid, {}).items():
            mesh = mesh.remat(a, b)
        info = export.export_mesh(mesh, os.path.join(OUT, f'{aid}.glb'), aid)
        lods = {}
        for i, (tgt, div) in enumerate(((l1, 2), (l2, 4)), 1):
            li = export.export_mesh(mesh, os.path.join(OUT, f'{aid}_lod{i}.glb'), aid, res_div=div, decimate_to=tgt)
            lods[f'lod{i}'] = dict(file=f'/assets/models/candidates/capsule/{aid}_lod{i}.glb', triangles=li['triangles'], bytes=li['bytes'])
        b = np.array(info['max']) - np.array(info['min'])
        # same convention as v1: Blender axes (x, y, z-up)
        man[aid] = dict(file=f'/assets/models/candidates/capsule/{aid}.glb', replaces=repl, category='landmark', label=label,
                        state='Textured PBR review candidate (v2)', source='assets-src/workflows/capsule/', triangles=info['triangles'],
                        bytes=info['bytes'], bounds_m=[round(float(x), 3) for x in b], lods=lods)
        print(aid, info['triangles'], info['bytes'], man[aid]['bounds_m'], {k: (v['triangles'], v['bytes']) for k, v in lods.items()}, f'{time.time() - t:.1f}s', flush=True)
        json.dump(man, open(man_path, 'w'), indent=1)
