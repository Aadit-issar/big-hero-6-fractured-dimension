"""Blender material helpers: Poly Haven style PBR sets that export as standard glTF PBR."""
import os

import bpy
import numpy as np


def load_image(path, srgb):
    img = bpy.data.images.load(os.path.abspath(path), check_existing=True)
    img.colorspace_settings.name = 'sRGB' if srgb else 'Non-Color'
    return img


def _gltf_output_group():
    ng = bpy.data.node_groups.get('glTF Material Output')
    if ng is None:
        ng = bpy.data.node_groups.new('glTF Material Output', 'ShaderNodeTree')
        ng.interface.new_socket(name='Occlusion', in_out='INPUT', socket_type='NodeSocketFloat')
    return ng


def pbr_material(name, base, normal, arm, vertex_color=False, normal_strength=1.0):
    """Principled material from a base colour (sRGB), OpenGL normal and ARM map
    (R = occlusion, G = roughness, B = metallic). With vertex_color the base colour is
    multiplied by COLOR_0 (neutral cavity AO and staining baked per vertex)."""
    m = bpy.data.materials.new(name)
    m.use_nodes = True
    nt = m.node_tree
    for n in list(nt.nodes):
        if n.type not in ('OUTPUT_MATERIAL', 'BSDF_PRINCIPLED'):
            nt.nodes.remove(n)
    bsdf = nt.nodes['Principled BSDF']
    L = nt.links
    d = nt.nodes.new('ShaderNodeTexImage')
    d.image = load_image(base, True)
    nrm = nt.nodes.new('ShaderNodeTexImage')
    nrm.image = load_image(normal, False)
    arm_n = nt.nodes.new('ShaderNodeTexImage')
    arm_n.image = load_image(arm, False)
    nmap = nt.nodes.new('ShaderNodeNormalMap')
    nmap.inputs['Strength'].default_value = normal_strength
    L.new(nrm.outputs['Color'], nmap.inputs['Color'])
    L.new(nmap.outputs['Normal'], bsdf.inputs['Normal'])
    sep = nt.nodes.new('ShaderNodeSeparateColor')
    L.new(arm_n.outputs['Color'], sep.inputs['Color'])
    L.new(sep.outputs['Green'], bsdf.inputs['Roughness'])
    L.new(sep.outputs['Blue'], bsdf.inputs['Metallic'])
    grp = nt.nodes.new('ShaderNodeGroup')
    grp.node_tree = _gltf_output_group()
    L.new(sep.outputs['Red'], grp.inputs['Occlusion'])
    if vertex_color:
        vc = nt.nodes.new('ShaderNodeVertexColor')
        vc.layer_name = 'Col'
        mix = nt.nodes.new('ShaderNodeMix')
        mix.data_type = 'RGBA'
        mix.blend_type = 'MULTIPLY'
        mix.inputs[0].default_value = 1.0
        L.new(d.outputs['Color'], mix.inputs[6])
        L.new(vc.outputs['Color'], mix.inputs[7])
        L.new(mix.outputs[2], bsdf.inputs['Base Color'])
    else:
        L.new(d.outputs['Color'], bsdf.inputs['Base Color'])
    return m


def read_triangles(obj):
    """(verts float32 Nx3, tris int32 Mx3) of a triangulated mesh object."""
    me = obj.data
    v = np.empty(len(me.vertices) * 3, dtype=np.float32)
    me.vertices.foreach_get('co', v)
    loops = np.empty(len(me.loops), dtype=np.int32)
    me.loops.foreach_get('vertex_index', loops)
    assert len(me.loops) == 3 * len(me.polygons), 'mesh must be triangulated'
    return v.reshape(-1, 3), loops.reshape(-1, 3)


def set_material_indices(obj, idx):
    obj.data.polygons.foreach_set('material_index', np.ascontiguousarray(idx, dtype=np.int32))
