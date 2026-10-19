"""High-to-low relief baking for the concrete heroes (Cycles, CPU): normal, colour, AO and roughness atlases."""
import math
import os

import bpy
import numpy as np


def setup(samples=8, ao_distance=0.07):
    sc = bpy.context.scene
    sc.render.engine = 'CYCLES'
    sc.cycles.device = 'CPU'
    sc.cycles.samples = samples
    sc.cycles.use_denoising = False
    sc.world = bpy.data.worlds.new('bake_world')
    sc.world.use_nodes = True
    sc.world.node_tree.nodes['Background'].inputs['Strength'].default_value = 1.0
    sc.world.light_settings.distance = ao_distance


def load(path, srgb):
    img = bpy.data.images.load(os.path.abspath(path), check_existing=True)
    img.colorspace_settings.name = 'sRGB' if srgb else 'Non-Color'
    return img


class HiMat:
    """Emission material evaluated on the high-res mesh: object-space box-projected PBR set -> colour or roughness."""

    def __init__(self, name, diff, arm, tile):
        self.mat = bpy.data.materials.new(name)
        self.mat.use_nodes = True
        nt = self.nt = self.mat.node_tree
        for n in list(nt.nodes):
            if n.type != 'OUTPUT_MATERIAL':
                nt.nodes.remove(n)
        out = nt.nodes['Material Output']
        N, L = nt.nodes.new, nt.links.new
        tc = N('ShaderNodeTexCoord')
        mp = N('ShaderNodeMapping')
        mp.inputs['Scale'].default_value = (1 / tile,) * 3
        L(tc.outputs['Object'], mp.inputs['Vector'])
        self.d = N('ShaderNodeTexImage')
        self.d.image = load(diff, True)
        self.a = N('ShaderNodeTexImage')
        self.a.image = load(arm, False)
        for t in (self.d, self.a):
            t.projection, t.projection_blend = 'BOX', 0.3
            L(mp.outputs['Vector'], t.inputs['Vector'])
        sep = N('ShaderNodeSeparateColor')
        L(self.a.outputs['Color'], sep.inputs['Color'])
        self.gray = N('ShaderNodeCombineColor')
        for k in ('Red', 'Green', 'Blue'):
            L(sep.outputs['Green'], self.gray.inputs[k])
        self.em = N('ShaderNodeEmission')
        L(self.em.outputs['Emission'], out.inputs['Surface'])

    def set(self, kind):
        for l in list(self.nt.links):
            if l.to_node == self.em:
                self.nt.links.remove(l)
        src = self.d.outputs['Color'] if kind == 'color' else self.gray.outputs['Color']
        self.nt.links.new(src, self.em.inputs['Color'])


def target_material(low):
    m = bpy.data.materials.new('bake_target')
    m.use_nodes = True
    node = m.node_tree.nodes.new('ShaderNodeTexImage')
    low.data.materials.clear()
    low.data.materials.append(m)
    return node


def unwrap_smart(obj, angle_deg=75.0, margin=0.004):
    bpy.ops.object.select_all(action='DESELECT')
    bpy.context.view_layer.objects.active = obj
    obj.select_set(True)
    bpy.ops.object.mode_set(mode='EDIT')
    bpy.ops.mesh.select_all(action='SELECT')
    bpy.ops.uv.smart_project(angle_limit=math.radians(angle_deg), island_margin=margin, correct_aspect=True, scale_to_bounds=False)
    bpy.ops.uv.select_all(action='SELECT')
    bpy.ops.uv.average_islands_scale()
    bpy.ops.uv.pack_islands(margin=margin, rotate=True)
    bpy.ops.object.mode_set(mode='OBJECT')


def bake(low, high, node, kind, size, srgb, extrusion=0.02, max_ray=0.05, margin=10):
    """Bake `kind` ('color'|'rough' emission, 'ao', 'normal') from high onto low's UVs into a new image."""
    img = bpy.data.images.new(f'{low.name}_{kind}', size, size, alpha=False)
    img.colorspace_settings.name = 'sRGB' if srgb else 'Non-Color'
    node.image = img
    node.select = True
    node.id_data.nodes.active = node
    bpy.ops.object.select_all(action='DESELECT')
    high.select_set(True)
    low.select_set(True)
    bpy.context.view_layer.objects.active = low
    typ = {'color': 'EMIT', 'rough': 'EMIT', 'ao': 'AO', 'normal': 'NORMAL'}[kind]
    kw = dict(type=typ, use_selected_to_active=True, cage_extrusion=extrusion, max_ray_distance=max_ray, margin=margin, margin_type='EXTEND', use_clear=True)
    if typ == 'NORMAL':
        kw['normal_space'] = 'TANGENT'
    bpy.ops.object.bake(**kw)
    return img


def pixels(img):
    a = np.empty(len(img.pixels), dtype=np.float32)
    img.pixels.foreach_get(a)
    return a.reshape(-1, 4)


def make_image(name, rgba, size, srgb, fmt):
    img = bpy.data.images.new(name, size, size, alpha=False)
    img.colorspace_settings.name = 'sRGB' if srgb else 'Non-Color'
    img.pixels.foreach_set(np.ascontiguousarray(rgba, dtype=np.float32).ravel())
    img.file_format = fmt
    img.update()
    return img


def downscaled(img, size, name, fmt):
    c = img.copy()
    c.name = name
    c.scale(size, size)
    c.file_format = fmt
    return c


def final_material(name, col, orm, nrm, normal_strength=1.0):
    from pylib.materials import _gltf_output_group
    m = bpy.data.materials.new(name)
    m.use_nodes = True
    nt = m.node_tree
    for n in list(nt.nodes):
        if n.type not in ('OUTPUT_MATERIAL', 'BSDF_PRINCIPLED'):
            nt.nodes.remove(n)
    bsdf = nt.nodes['Principled BSDF']
    N, L = nt.nodes.new, nt.links.new
    c = N('ShaderNodeTexImage')
    c.image = col
    o = N('ShaderNodeTexImage')
    o.image = orm
    n_ = N('ShaderNodeTexImage')
    n_.image = nrm
    nm = N('ShaderNodeNormalMap')
    nm.inputs['Strength'].default_value = normal_strength
    L(c.outputs['Color'], bsdf.inputs['Base Color'])
    L(n_.outputs['Color'], nm.inputs['Color'])
    L(nm.outputs['Normal'], bsdf.inputs['Normal'])
    sep = N('ShaderNodeSeparateColor')
    L(o.outputs['Color'], sep.inputs['Color'])
    L(sep.outputs['Green'], bsdf.inputs['Roughness'])
    L(sep.outputs['Blue'], bsdf.inputs['Metallic'])
    grp = N('ShaderNodeGroup')
    grp.node_tree = _gltf_output_group()
    L(sep.outputs['Red'], grp.inputs['Occlusion'])
    return m
