"""Blender-side material creation and GLB export for kit Meshes (with texture-resolution LODs)."""
import os

import bpy
import numpy as np

import kit
from pylib import blend

TEX = os.path.join(kit.HERE, 'build', 'tex')

# mesh material name -> texture set (files <set>_{color,normal,orm}.png in build/tex[/div<n>]) or a solid entry
TEXSET = {
    'wall_outer': 'wall', 'hs_outer': 'hs', 'deck': 'whitepaint',
    'skin_back': 'primer', 'stringer': 'primer', 'rim_metal': 'baremetal', 'ablator_rim': 'honeycomb',
    'insulation': 'blanket', 'insulation_rim': 'blanket', 'pw_outer': 'isogrid', 'cabin_wall': 'cabin', 'frame': 'structure',
    'gunmetal': 'gunmetal', 'whitepaint': 'whitepaint', 'avionics': 'avionics', 'floor': 'floor',
    'frag_outer': 'frag', 'frag2_outer': 'frag2', 'frag_hs': 'fraghs', 'structure_back': 'structure', 'nozzle': 'nozzle', 'screen': 'screen',
}
EMISSIVE_TEX = {'screen': 2.2}
SOLID = {  # base rgb (linear), rough, metal, emissive rgb, emissive strength, alpha
    'glass': ((0.012, 0.016, 0.02), 0.06, 0.0, None, 0, 0.55),
    'glass_opaque': ((0.010, 0.013, 0.016), 0.08, 0.0, None, 0, 1.0),
    'cabin_dark': ((0.018, 0.018, 0.02), 0.85, 0.0, None, 0, 1.0),
    'lamp_amber': ((0.9, 0.45, 0.08), 0.4, 0.0, (1.0, 0.42, 0.06), 5.0, 1.0),
    'lamp_white': ((0.9, 0.85, 0.75), 0.4, 0.0, (1.0, 0.86, 0.66), 2.5, 1.0),
    'lamp_blue': ((0.15, 0.4, 0.9), 0.4, 0.0, (0.25, 0.6, 1.0), 4.0, 1.0),
    'lamp_red': ((0.6, 0.05, 0.03), 0.4, 0.0, (1.0, 0.08, 0.04), 4.0, 1.0),
    'lamp_green': ((0.1, 0.6, 0.2), 0.4, 0.0, (0.2, 1.0, 0.3), 3.0, 1.0),
    'cable_orange': ((0.62, 0.20, 0.025), 0.55, 0.0, None, 0, 1.0),
    'cable_blue': ((0.04, 0.10, 0.32), 0.55, 0.0, None, 0, 1.0),
    'cable_black': ((0.025, 0.025, 0.027), 0.6, 0.0, None, 0, 1.0),
    'cable_red': ((0.40, 0.03, 0.025), 0.55, 0.0, None, 0, 1.0),
    'cable_white': ((0.55, 0.55, 0.52), 0.6, 0.0, None, 0, 1.0),
    'cable_yellow': ((0.62, 0.45, 0.05), 0.55, 0.0, None, 0, 1.0),
    'copper': ((0.72, 0.38, 0.2), 0.35, 1.0, None, 0, 1.0),
    'steel_bright': ((0.56, 0.56, 0.57), 0.32, 1.0, None, 0, 1.0),
    'steel_dark': ((0.20, 0.20, 0.21), 0.45, 1.0, None, 0, 1.0),
    'rubber': ((0.03, 0.03, 0.033), 0.85, 0.0, None, 0, 1.0),
    'burnt': ((0.06, 0.045, 0.035), 0.6, 0.6, None, 0, 1.0),
    'gold_foil': ((0.55, 0.36, 0.10), 0.35, 1.0, None, 0, 1.0),
    'cushion_orange': ((0.45, 0.13, 0.02), 0.75, 0.0, None, 0, 1.0),
    'cushion_dark': ((0.035, 0.035, 0.038), 0.8, 0.0, None, 0, 1.0),
    'primer_solid': ((0.11, 0.14, 0.09), 0.65, 0.0, None, 0, 1.0),
    'structure_solid': ((0.17, 0.18, 0.19), 0.5, 0.6, None, 0, 1.0),
    'char_solid': ((0.03, 0.026, 0.022), 0.9, 0.0, None, 0, 1.0),
}
CLAY = os.environ.get('CAPSULE_CLAY') == '1'
_cache = {}


def _img(path, srgb):
    img = bpy.data.images.load(os.path.abspath(path), check_existing=True)
    img.colorspace_settings.name = 'sRGB' if srgb else 'Non-Color'
    return img


def _gltf_group():
    ng = bpy.data.node_groups.get('glTF Material Output')
    if ng is None:
        ng = bpy.data.node_groups.new('glTF Material Output', 'ShaderNodeTree')
        ng.interface.new_socket(name='Occlusion', in_out='INPUT', socket_type='NodeSocketFloat')
    return ng


def tex_dir(res_div):
    return TEX if res_div == 1 else os.path.join(TEX, f'div{res_div}')


def textured(name, key, res_div=1):
    d = tex_dir(res_div)
    m = bpy.data.materials.new(name)
    m.use_nodes = True
    nt = m.node_tree
    for n in list(nt.nodes):
        if n.type not in ('OUTPUT_MATERIAL', 'BSDF_PRINCIPLED'):
            nt.nodes.remove(n)
    b = nt.nodes['Principled BSDF']
    Lk = nt.links.new
    c = nt.nodes.new('ShaderNodeTexImage'); c.image = _img(os.path.join(d, f'{key}_color.png'), True)
    Lk(c.outputs['Color'], b.inputs['Base Color'])
    nrm = nt.nodes.new('ShaderNodeTexImage'); nrm.image = _img(os.path.join(d, f'{key}_normal.png'), False)
    nm = nt.nodes.new('ShaderNodeNormalMap')
    Lk(nrm.outputs['Color'], nm.inputs['Color']); Lk(nm.outputs['Normal'], b.inputs['Normal'])
    orm = nt.nodes.new('ShaderNodeTexImage'); orm.image = _img(os.path.join(d, f'{key}_orm.png'), False)
    sep = nt.nodes.new('ShaderNodeSeparateColor')
    Lk(orm.outputs['Color'], sep.inputs['Color'])
    Lk(sep.outputs['Green'], b.inputs['Roughness']); Lk(sep.outputs['Blue'], b.inputs['Metallic'])
    g = nt.nodes.new('ShaderNodeGroup'); g.node_tree = _gltf_group()
    Lk(sep.outputs['Red'], g.inputs['Occlusion'])
    if key in EMISSIVE_TEX:
        e = nt.nodes.new('ShaderNodeTexImage'); e.image = _img(os.path.join(d, f'{key}_emit.png'), True)
        Lk(e.outputs['Color'], b.inputs['Emission Color'])
        b.inputs['Emission Strength'].default_value = EMISSIVE_TEX[key]
    return m


def get_material(name, res_div=1):
    k = (name, res_div)
    if k in _cache:
        return _cache[k]
    if CLAY:
        mat = bpy.data.materials.new(name)
        mat.use_nodes = True
        mat.node_tree.nodes['Principled BSDF'].inputs['Base Color'].default_value = (0.5, 0.5, 0.5, 1)
    elif name in TEXSET and os.path.exists(os.path.join(tex_dir(res_div), f'{TEXSET[name]}_color.png')):
        mat = textured(name, TEXSET[name], res_div)
    else:
        rgb, rough, metal, em, es, alpha = SOLID.get(name, ((0.5, 0.5, 0.5), 0.6, 0.0, None, 0, 1.0))
        mat = bpy.data.materials.new(name)
        mat.use_nodes = True
        b = mat.node_tree.nodes['Principled BSDF']
        b.inputs['Base Color'].default_value = (*rgb, 1)
        b.inputs['Roughness'].default_value = rough
        b.inputs['Metallic'].default_value = metal
        if em:
            b.inputs['Emission Color'].default_value = (*em, 1)
            b.inputs['Emission Strength'].default_value = es
        if alpha < 1:
            b.inputs['Alpha'].default_value = alpha
            try:
                mat.surface_render_method = 'BLENDED'
            except Exception:
                pass
    mat.use_backface_culling = False
    _cache[k] = mat
    return mat


def to_object(mesh, name, res_div=1, smooth_angle=34.0):
    names = list(mesh.mat)
    uniq = sorted(set(names), key=names.index)
    T, ok = kit.clean_tris(mesh.P.astype(np.float64), mesh.T)
    UV = np.nan_to_num(mesh.UV[ok])
    mi = np.array([uniq.index(n) for n in np.asarray(names, dtype=object)[ok]], np.int32)
    obj = blend.mesh_object(name, mesh.P.astype(np.float32), T)
    blend.set_loop_uvs(obj, UV.reshape(-1, 2))
    for n in uniq:
        obj.data.materials.append(get_material(n, res_div))
    obj.data.polygons.foreach_set('material_index', mi)
    import bmesh
    bm = bmesh.new()
    bm.from_mesh(obj.data)
    bmesh.ops.remove_doubles(bm, verts=bm.verts[:], dist=2e-6)
    bmesh.ops.dissolve_degenerate(bm, dist=1e-7, edges=bm.edges[:])
    bmesh.ops.triangulate(bm, faces=[f for f in bm.faces if len(f.verts) > 3])
    bm.to_mesh(obj.data)
    bm.free()
    obj.data.validate(clean_customdata=False)
    blend.shade_by_angle(obj, smooth_angle)
    return obj


def export_mesh(mesh, path, name='capsule', res_div=1, smooth_angle=34.0, jpeg=86, decimate_to=None):
    blend.reset()
    _cache.clear()
    obj = to_object(mesh, name, res_div, smooth_angle)
    if decimate_to:
        blend.decimate(obj, decimate_to)
        blend.shade_by_angle(obj, smooth_angle)
    tris = len(obj.data.polygons)
    size = blend.export_glb(path, [obj], jpeg_quality=jpeg, extra={'export_vertex_color': 'NONE'})
    xs = np.array([v.co[:] for v in obj.data.vertices])
    return dict(triangles=tris, bytes=size, min=xs.min(0).tolist(), max=xs.max(0).tolist())
