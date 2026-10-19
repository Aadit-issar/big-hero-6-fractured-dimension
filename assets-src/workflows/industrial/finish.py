"""Shared finishing pipeline for the industrial kit assemblers.

groups: {'paint': M, 'hw': M, ...}. The baked group ('paint') gets bevel + smart UV atlas + the Cycles wear bake
(bake2.WearMaterial, red-oxide/zinc/other paint, worn edges, bare metal, selective rust). Every other group is a
constant-factor material. Exports LOD0 and decimated LOD1/LOD2 GLBs (textures downscaled per LOD) and returns stats."""
import json
import math
import os
import sys

import numpy as np

HERE = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, HERE)
sys.path.insert(0, os.path.join(HERE, '..', '..', 'pilots'))

ROOT = os.path.abspath(os.path.join(HERE, '..', '..', '..'))
OUT_DIR = os.path.join(ROOT, 'public', 'assets', 'models', 'candidates', 'industrial')
TEX = os.path.join(ROOT, 'assets-src', 'pilots', 'textures')

# constant materials: (rgb linear, roughness, metallic)
CONST = {
    'bolt': ((0.34, 0.34, 0.36), 0.45, 0.9),
    'weld': ((0.12, 0.12, 0.13), 0.6, 0.5),
    'zinc': ((0.42, 0.43, 0.44), 0.42, 0.9),
    'rubber': ((0.025, 0.025, 0.027), 0.7, 0.0),
    'cable_red': ((0.30, 0.03, 0.025), 0.55, 0.0),
    'cable_blue': ((0.02, 0.05, 0.22), 0.55, 0.0),
    'cable_yellow': ((0.45, 0.33, 0.04), 0.55, 0.0),
    'copper': ((0.62, 0.30, 0.17), 0.35, 0.95),
    'dark': ((0.05, 0.05, 0.055), 0.6, 0.4),
    'wood': ((0.26, 0.15, 0.075), 0.85, 0.0),
    'glass': ((0.2, 0.25, 0.25), 0.2, 0.0),
}


def _mesh_object(blend, name, m, with_dmg):
    obj = blend.mesh_object(name, m.v.astype(np.float32), m.t.astype(np.int32))
    if with_dmg:
        rgba = np.zeros((len(m.v), 4), np.float32)
        rgba[:, 0] = np.clip(m.d[:, 0], 0, 1)
        rgba[:, 1] = np.clip(m.d[:, 1], 0, 1)
        rgba[:, 3] = 1
        blend.set_vertex_colors(obj, rgba, name='dmg')
    return obj


def finish(name, groups, *, paint_rgb=(0.20, 0.05, 0.038), rust_gain=0.8, wear_gain=1.0, bake_px=2048, samples=16,
           bevel=0.0012, bevel_angle=55.0, smooth_angle=40.0, lod_ratios=(0.30, 0.08), uv_margin=0.003, rust_tex='rebar_rust',
           skip_bake=False, extra_notes=''):
    import bpy
    from pylib import blend, materials
    import bake2
    out = {}
    stats = {'id': name}
    blend.reset()
    objs = {}
    baked = groups.get('paint')
    for gname, m in groups.items():
        if m is None or not len(m.t):
            continue
        o = _mesh_object(blend, f'{name}_{gname}', m, gname == 'paint')
        objs[gname] = o
    allv = np.concatenate([m.v for m in groups.values() if m is not None and len(m.t)])
    lo, hi = allv.min(0), allv.max(0)
    stats['bounds_m'] = [round(float(hi[0] - lo[0]), 3), round(float(hi[2] - lo[2]), 3), round(float(hi[1] - lo[1]), 3)]  # glTF y-up size (x, z, y)
    p = objs['paint']
    if bevel:
        blend.bevel(p, bevel, 1, angle_deg=bevel_angle)
    blend.shade_by_angle(p, smooth_angle)
    for g, o in objs.items():
        if g != 'paint':
            blend.shade_by_angle(o, 45.0)
    # UV atlas for the painted group
    bpy.ops.object.select_all(action='DESELECT')
    bpy.context.view_layer.objects.active = p
    p.select_set(True)
    bpy.ops.object.mode_set(mode='EDIT')
    bpy.ops.mesh.select_all(action='SELECT')
    bpy.ops.uv.smart_project(angle_limit=math.radians(66.0), island_margin=uv_margin, area_weight=0.0, correct_aspect=True, scale_to_bounds=False)
    bpy.ops.object.mode_set(mode='OBJECT')
    p.data.materials.clear()
    if skip_bake:
        mat = bpy.data.materials.new('paint')
        mat.use_nodes = True
        b = mat.node_tree.nodes['Principled BSDF']
        b.inputs['Base Color'].default_value = (*paint_rgb, 1)
        b.inputs['Roughness'].default_value = 0.6
        p.data.materials.append(mat)
    else:
        bake2.setup_cycles(samples)
        wm = bake2.WearMaterial(f'{name}_wear', os.path.join(TEX, f'{rust_tex}_diff_1k.jpg'), os.path.join(TEX, f'{rust_tex}_nor_gl_1k.jpg'),
                                paint_rgb=paint_rgb, rust_gain=rust_gain, wear_gain=wear_gain)
        p.data.materials.append(wm.mat)
        bdir = os.path.join(ROOT, 'test-results', f'industrial-bake-{name}')
        os.makedirs(bdir, exist_ok=True)
        paths = {}
        for kind, srgb in (('color', True), ('orm', False), ('normal', False)):
            paths[kind] = os.path.join(bdir, f'{kind}.png')
            wm.bake(p, kind, bake_px, srgb, path=paths[kind])
        p.data.materials.clear()
        p.data.materials.append(materials.pbr_material(f'{name}_pbr', paths['color'], paths['normal'], paths['orm']))
    for g, o in objs.items():
        if g == 'paint':
            continue
        rgb, rough, metal = CONST[g]
        mat = bpy.data.materials.new(g)
        mat.use_nodes = True
        b = mat.node_tree.nodes['Principled BSDF']
        b.inputs['Base Color'].default_value = (*rgb, 1)
        b.inputs['Roughness'].default_value = rough
        b.inputs['Metallic'].default_value = metal
        o.data.materials.append(mat)
    if 'dmg' in p.data.color_attributes:
        p.data.color_attributes.remove(p.data.color_attributes['dmg'])
    stats['lods'] = export_with_lods(name, list(objs.values()), lod_ratios)
    return stats


def export_with_lods(name, olist, lod_ratios=(0.30, 0.08)):
    """Triangulate, export LOD0, then decimate + halve textures for each further LOD. Returns [{file, triangles, bytes}]."""
    import bpy
    from pylib import blend
    res = []
    os.makedirs(OUT_DIR, exist_ok=True)
    tri = lambda: sum(len(o.data.polygons) for o in olist)  # noqa: E731
    bpy.ops.object.select_all(action='DESELECT')
    for o in olist:
        bpy.context.view_layer.objects.active = o
        o.select_set(True)
        bpy.ops.object.modifier_add(type='TRIANGULATE')
        bpy.ops.object.modifier_apply(modifier='Triangulate')
        o.select_set(False)
    size = blend.export_glb(os.path.join(OUT_DIR, f'{name}.glb'), olist, extra={'export_vertex_color': 'NONE'})
    res.append({'file': f'/assets/models/candidates/industrial/{name}.glb', 'triangles': tri(), 'bytes': size})
    imgs = [i for i in bpy.data.images if i.size[0] > 8 and i.users]
    orig = {o.name: len(o.data.polygons) for o in olist}
    for k, ratio in enumerate(lod_ratios, start=1):
        for o in olist:
            blend.decimate(o, max(48, int(orig[o.name] * ratio)))
        for im in imgs:
            w, h = im.size
            im.scale(max(64, w // 2), max(64, h // 2))
        sz = blend.export_glb(os.path.join(OUT_DIR, f'{name}_lod{k}.glb'), olist, extra={'export_vertex_color': 'NONE'})
        res.append({'file': f'/assets/models/candidates/industrial/{name}_lod{k}.glb', 'triangles': tri(), 'bytes': sz})
    return res


def write_manifest_entry(stats, replaces, category, label, state):
    mp = os.path.join(OUT_DIR, 'manifest.json')
    data = json.load(open(mp)) if os.path.exists(mp) else {}
    l0 = stats['lods'][0]
    data[stats['id']] = {'file': l0['file'], 'replaces': replaces, 'category': category, 'label': label, 'state': state,
                         'triangles': l0['triangles'], 'bytes': l0['bytes'], 'bounds_m': stats['bounds_m'],
                         'lods': [{'file': l['file'], 'triangles': l['triangles'], 'bytes': l['bytes']} for l in stats['lods'][1:]]}
    json.dump(data, open(mp, 'w'), indent=2)
