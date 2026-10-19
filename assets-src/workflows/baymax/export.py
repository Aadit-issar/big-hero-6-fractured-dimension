"""Blender-side material creation and GLB export for kit Meshes (Baymax kit)."""
import os

import bpy
import numpy as np

import kit
from pylib import blend, materials

TEX = os.path.join(kit.HERE, 'build', 'tex')

SET = {  # material name -> texture set key (tile sets shared by the family; <part>_paint atlases are per part)
    'liner': 'liner',
    'rim': 'rim',
    'gunmetal': 'gunmetal',
}
SOLID = {  # rgb, rough, metal, emissive rgb, emissive strength
    'lens_blue': ((0.15, 0.45, 0.95), 0.25, 0.0, (0.25, 0.6, 1.0), 5.0),
    'lens_glass': ((0.01, 0.02, 0.03), 0.12, 0.0, None, 0),
    'cable_black': ((0.025, 0.025, 0.028), 0.55, 0.0, None, 0),
    'cable_red': ((0.52, 0.035, 0.04), 0.35, 0.0, None, 0),
    'steel': ((0.62, 0.62, 0.64), 0.28, 1.0, None, 0),
    'rubber': ((0.03, 0.03, 0.034), 0.8, 0.0, None, 0),
    'copper': ((0.72, 0.38, 0.2), 0.35, 1.0, None, 0),
}
_cache = {}


def get_material(name):
    if name in _cache and name in bpy.data.materials:
        return _cache[name]
    if name in SET or name.endswith('_paint'):
        key = SET.get(name, name)
        mat = materials.pbr_material(name, os.path.join(TEX, f'{key}_color.png'), os.path.join(TEX, f'{key}_normal.png'), os.path.join(TEX, f'{key}_orm.png'))
    else:
        rgb, rough, metal, em, es = SOLID[name]
        mat = bpy.data.materials.new(name)
        mat.use_nodes = True
        b = mat.node_tree.nodes['Principled BSDF']
        b.inputs['Base Color'].default_value = (*rgb, 1)
        b.inputs['Roughness'].default_value = rough
        b.inputs['Metallic'].default_value = metal
        if em:
            b.inputs['Emission Color'].default_value = (*em, 1)
            b.inputs['Emission Strength'].default_value = es
    mat.use_backface_culling = False
    _cache[name] = mat
    return mat


ALIAS = {}


def to_object(mesh, name, decimate_to=None):
    names = [ALIAS.get(n, n) for n in mesh.mat]
    uniq = sorted(set(names), key=names.index)
    T, ok = kit.clean_tris(mesh.P.astype(np.float64), mesh.T)
    UV = mesh.UV[ok]
    mi = np.array([uniq.index(n) for n in np.asarray(names, dtype=object)[ok]], np.int32)
    obj = blend.mesh_object(name, mesh.P, T)
    blend.set_loop_uvs(obj, UV.reshape(-1, 2))
    for n in uniq:
        obj.data.materials.append(get_material(n))
    blend.set_material_indices_np = None
    obj.data.polygons.foreach_set('material_index', mi)
    blend.shade_by_angle(obj, 34.0)
    if decimate_to:
        for _ in range(4):
            if blend.decimate(obj, decimate_to) <= decimate_to * 1.12:
                break
    return obj


def export_mesh(mesh, path, name='baymax', decimate_to=None):
    blend.reset()
    _cache.clear()
    obj = to_object(mesh, name, decimate_to)
    tris = len(obj.data.polygons)
    size = blend.export_glb(path, [obj], jpeg_quality=86, extra={'export_vertex_color': 'NONE'})
    xs = np.array([v.co[:] for v in obj.data.vertices])
    return dict(triangles=tris, bytes=size, min=xs.min(0).tolist(), max=xs.max(0).tolist())
