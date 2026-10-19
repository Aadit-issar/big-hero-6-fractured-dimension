"""Build Baymax candidates: C:/Users/aadit/bh6-bpy-venv/Scripts/python.exe build_all.py [parts...] [--nolod] [--notex]"""
import os, sys, json, time
sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import numpy as np
import kit, paint, parts, export

ROOT = os.path.abspath(os.path.join(kit.HERE, '..', '..', '..'))
OUT = os.path.join(ROOT, 'public', 'assets', 'models', 'candidates', 'baymax')
ASSETS = {
    'shoulder': ('baymax_shoulder_shell', 'Shoulder armour shell, torn open on the joint', 'baymax_shoulder_fragment', (12000, 2000)),
    'forearm': ('baymax_forearm_shell', 'Forearm armour shell with split panel and wrist hub', 'baymax_forearm_fragment', (12000, 2000)),
    'chest': ('baymax_chest_armor', 'Chest armour fragment with emblem and exposed interior', None, (12000, 2000)),
    'joint': ('baymax_joint_shell', 'Joint shell piece with bearing hub and lens', None, (9000, 1800)),
    'shard': ('baymax_plating_shard', 'Armour plating shard with slot', None, (5000, 1200)),
}

if __name__ == '__main__':
    args = [a for a in sys.argv[1:] if not a.startswith('--')]
    only = args or list(ASSETS)
    os.makedirs(OUT, exist_ok=True)
    man_path = os.path.join(OUT, 'manifest.json')
    man = json.load(open(man_path)) if os.path.exists(man_path) else {}
    if '--notex' not in sys.argv and not os.path.exists(os.path.join(paint.TEX, 'liner_color.png')):
        for nm in ('liner', 'rim', 'gunmetal'):
            paint.tile_set(nm, nm)
    for key in only:
        aid, label, repl, lods_t = ASSETS[key]
        t = time.time()
        mesh, atlas = parts.BUILDERS[key]()
        print(key, 'mesh', len(mesh.T), f'{time.time()-t:.1f}s', flush=True)
        if '--notex' not in sys.argv:
            a = dict(atlas); W, H = a.pop('size'); nm = a.pop('name')
            paint.paint_atlas(nm, a.pop('f'), a.pop('keep'), W, H, **a)
            print(key, 'tex', f'{time.time()-t:.1f}s', flush=True)
        info = export.export_mesh(mesh, os.path.join(OUT, f'{aid}.glb'), aid)
        lods = {}
        if '--nolod' not in sys.argv:
            for i, tgt in enumerate(lods_t, 1):
                li = export.export_mesh(mesh, os.path.join(OUT, f'{aid}_lod{i}.glb'), aid, tgt)
                lods[f'lod{i}'] = dict(file=f'/assets/models/candidates/baymax/{aid}_lod{i}.glb', triangles=li['triangles'], bytes=li['bytes'])
        b = np.array(info['max']) - np.array(info['min'])
        man[aid] = dict(file=f'/assets/models/candidates/baymax/{aid}.glb', replaces=repl, category='baymax', label=label,
                        state='Textured PBR review candidate', triangles=info['triangles'], bytes=info['bytes'],
                        bounds_m=[round(float(x), 3) for x in b], lods=lods, source='assets-src/workflows/baymax/')
        print(aid, info['triangles'], info['bytes'], [round(float(x), 2) for x in b], f'{time.time()-t:.1f}s', flush=True)
        json.dump(man, open(man_path, 'w'), indent=1)
