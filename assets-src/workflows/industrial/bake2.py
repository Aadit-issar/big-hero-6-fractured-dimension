"""Cycles baking helpers: UV atlas, procedural wear network, EMIT/NORMAL bakes -> glTF-ready PBR images."""
import math
import os

import bpy
import numpy as np


def setup_cycles(samples):
    sc = bpy.context.scene
    sc.render.engine = 'CYCLES'
    sc.cycles.device = 'CPU'
    sc.cycles.samples = samples
    sc.cycles.use_denoising = False
    sc.render.bake.margin = 6
    sc.render.bake.use_clear = True
    sc.render.bake.use_selected_to_active = False
    sc.world = bpy.data.worlds.new('bake_world')
    sc.world.use_nodes = True
    sc.world.node_tree.nodes['Background'].inputs['Strength'].default_value = 0.0


class WearMaterial:
    """Layered paint / bare steel / rust shader driven by edges, cavity and per-vertex damage.

    Channels are exposed as node sockets so each pass can bake them through an Emission shader."""

    def __init__(self, name, rust_color_path, rust_normal_path, paint_rgb=(0.20, 0.050, 0.038), seed=1.0, rust_gain=1.0, wear_gain=1.0, dmg_layer='dmg'):
        self.mat = bpy.data.materials.new(name)
        self.mat.use_nodes = True
        nt = self.nt = self.mat.node_tree
        for n in list(nt.nodes):
            if n.type != 'OUTPUT_MATERIAL':
                nt.nodes.remove(n)
        self.out = nt.nodes['Material Output']
        N, L = nt.nodes.new, nt.links.new

        def node(kind, **kw):
            n = N(kind)
            for k, v in kw.items():
                setattr(n, k, v)
            return n

        def math_(op, a=None, b=None, clamp=False):
            n = node('ShaderNodeMath', operation=op, use_clamp=clamp)
            for i, v in ((0, a), (1, b)):
                if v is None:
                    continue
                if isinstance(v, (int, float)):
                    n.inputs[i].default_value = v
                else:
                    L(v, n.inputs[i])
            return n.outputs[0]

        def ramp(fac, stops):
            r = node('ShaderNodeValToRGB')
            r.color_ramp.elements[0].position, r.color_ramp.elements[0].color = stops[0][0], (stops[0][1],) * 3 + (1,)
            r.color_ramp.elements[1].position, r.color_ramp.elements[1].color = stops[1][0], (stops[1][1],) * 3 + (1,)
            L(fac, r.inputs['Fac'])
            return r.outputs['Color']

        def noise(scale, detail=6.0, rough=0.55, offset=0.0, vec=None):
            n = node('ShaderNodeTexNoise', noise_dimensions='3D')
            n.inputs['Scale'].default_value = scale
            n.inputs['Detail'].default_value = detail
            n.inputs['Roughness'].default_value = rough
            shift = node('ShaderNodeVectorMath', operation='ADD')
            shift.inputs[1].default_value = (offset * 3.1, offset * 1.7, offset * 5.3)
            L(vec or texco.outputs['Object'], shift.inputs[0])
            L(shift.outputs['Vector'], n.inputs['Vector'])
            return n.outputs['Fac']

        texco = node('ShaderNodeTexCoord')
        geo = node('ShaderNodeNewGeometry')
        dmg = node('ShaderNodeVertexColor', layer_name=dmg_layer)
        dsep = node('ShaderNodeSeparateColor')
        L(dmg.outputs['Color'], dsep.inputs['Color'])
        tear, crumple = dsep.outputs['Red'], dsep.outputs['Green']
        # Edge mask: where a small bevel of the surface normal departs from the true normal (arrises).
        bev = node('ShaderNodeBevel', samples=10)
        bev.inputs['Radius'].default_value = 0.0035
        dot = node('ShaderNodeVectorMath', operation='DOT_PRODUCT')
        L(bev.outputs['Normal'], dot.inputs[0])
        L(geo.outputs['Normal'], dot.inputs[1])
        edge = math_('MULTIPLY', math_('SUBTRACT', 1.0, dot.outputs['Value']), 22.0 * wear_gain, clamp=True)
        ao = node('ShaderNodeAmbientOcclusion', samples=10, only_local=False)
        ao.inputs['Distance'].default_value = 0.05
        self.ao_out = ao.outputs['AO']
        cavity = math_('SUBTRACT', 1.0, ao.outputs['AO'], clamp=True)
        n_large = noise(2.2 * seed, 6.0, 0.6, 1.0)
        n_mid = noise(9.0 * seed, 5.0, 0.55, 2.0)
        n_fine = noise(70.0, 4.0, 0.6, 3.0)
        # Paint loss: edges, damage, crumpling and fine flaking noise, softly thresholded.
        loss = math_('ADD', math_('MULTIPLY', edge, 0.95), math_('MULTIPLY', tear, 1.1))
        loss = math_('ADD', loss, math_('MULTIPLY', crumple, 0.55))
        loss = math_('ADD', loss, math_('MULTIPLY', math_('SUBTRACT', n_fine, 0.5), 0.75))
        loss = math_('ADD', loss, math_('MULTIPLY', math_('SUBTRACT', n_large, 0.5), 0.35))
        loss = math_('ADD', loss, math_('MULTIPLY', cavity, 0.25))
        chip = ramp(loss, [(0.50, 0.0), (0.58, 1.0)])
        # Rust spreads from the damaged bare steel, with an additional patchy distribution.
        rust_drive = math_('ADD', math_('MULTIPLY', math_('SUBTRACT', n_mid, 0.45), 1.6), math_('MULTIPLY', math_('ADD', tear, crumple), 0.9 * rust_gain))
        rust_drive = math_('ADD', rust_drive, math_('MULTIPLY', cavity, 0.6))
        rust = ramp(rust_drive, [(0.35, 0.0), (0.75, 1.0)])
        rust = math_('MULTIPLY', rust, chip)
        # Colours.
        paint = node('ShaderNodeMix', data_type='RGBA', blend_type='MULTIPLY')
        paint.inputs[0].default_value = 1.0
        paint.inputs[6].default_value = paint_rgb + (1.0,)
        shade = math_('ADD', 0.88, math_('MULTIPLY', n_large, 0.24))
        sh_col = node('ShaderNodeCombineColor')
        for k in ('Red', 'Green', 'Blue'):
            L(shade, sh_col.inputs[k])
        L(sh_col.outputs['Color'], paint.inputs[7])
        grime = node('ShaderNodeMix', data_type='RGBA', blend_type='MULTIPLY')
        grime.inputs[0].default_value = 1.0
        L(paint.outputs[2], grime.inputs[6])
        gcol = node('ShaderNodeCombineColor')
        gval = math_('SUBTRACT', 1.0, math_('MULTIPLY', cavity, 0.55), clamp=True)
        for k in ('Red', 'Green', 'Blue'):
            L(gval, gcol.inputs[k])
        L(gcol.outputs['Color'], grime.inputs[7])
        bare = node('ShaderNodeMix', data_type='RGBA', blend_type='MIX')
        bare.inputs[0].default_value = 1.0
        bare.inputs[6].default_value = (0.24, 0.24, 0.25, 1.0)
        bare.inputs[7].default_value = (0.12, 0.12, 0.13, 1.0)
        L(n_fine, bare.inputs[0])
        rust_img = node('ShaderNodeTexImage', projection='BOX')
        rust_img.image = bpy.data.images.load(os.path.abspath(rust_color_path), check_existing=True)
        rust_img.image.colorspace_settings.name = 'sRGB'
        rust_img.projection_blend = 0.25
        mp = node('ShaderNodeMapping')
        mp.inputs['Scale'].default_value = (1.8, 1.8, 1.8)
        L(texco.outputs['Object'], mp.inputs['Vector'])
        L(mp.outputs['Vector'], rust_img.inputs['Vector'])
        under = node('ShaderNodeMix', data_type='RGBA', blend_type='MIX')
        L(rust, under.inputs[0])
        L(bare.outputs[2], under.inputs[6])
        L(rust_img.outputs['Color'], under.inputs[7])
        final = node('ShaderNodeMix', data_type='RGBA', blend_type='MIX')
        L(chip, final.inputs[0])
        L(grime.outputs[2], final.inputs[6])
        L(under.outputs[2], final.inputs[7])
        self.color = final.outputs[2]
        # Roughness / metallic.
        def blend(a, b, fac):
            return math_('ADD', math_('MULTIPLY', a, math_('SUBTRACT', 1.0, fac)), math_('MULTIPLY', b, fac))
        under_r = blend(0.38, 0.82, rust)
        under_m = blend(1.0, 0.35, rust)
        self.rough = blend(math_('ADD', 0.46, math_('MULTIPLY', math_('SUBTRACT', n_mid, 0.5), 0.15)), under_r, chip)
        self.metal = blend(0.0, under_m, chip)
        # Surface height for the normal map: paint is proud of bare steel; rust is pitted and rough.
        rust_img_h = node('ShaderNodeRGBToBW')
        L(rust_img.outputs['Color'], rust_img_h.inputs['Color'])
        h = math_('MULTIPLY', math_('SUBTRACT', 1.0, chip), 0.00045)
        h = math_('ADD', h, math_('MULTIPLY', math_('MULTIPLY', rust_img_h.outputs['Val'], rust), 0.0006))
        h = math_('ADD', h, math_('MULTIPLY', n_fine, 0.00012))
        bump = node('ShaderNodeBump')
        bump.inputs['Strength'].default_value = 1.0
        bump.inputs['Distance'].default_value = 1.0
        L(h, bump.inputs['Height'])
        self.bump = bump
        self.principled = node('ShaderNodeBsdfPrincipled')
        L(bump.outputs['Normal'], self.principled.inputs['Normal'])
        self.emit = node('ShaderNodeEmission')
        self.img_node = node('ShaderNodeTexImage')
        self._pack = node('ShaderNodeCombineColor')
        L(self.ao_out, self._pack.inputs['Red'])
        L(self.rough, self._pack.inputs['Green'])
        L(self.metal, self._pack.inputs['Blue'])
        self.orm = self._pack.outputs['Color']

    def _emit_to(self, socket):
        nt = self.nt
        for l in list(nt.links):
            if l.to_node == self.emit and l.to_socket.name == 'Color':
                nt.links.remove(l)
        nt.links.new(socket, self.emit.inputs['Color'])
        for l in list(nt.links):
            if l.to_node == self.out:
                nt.links.remove(l)
        nt.links.new(self.emit.outputs['Emission'], self.out.inputs['Surface'])

    def bake(self, obj, kind, size, srgb, samples=None, path=None):
        """Bake 'color' | 'orm' (R=AO, G=roughness, B=metal) | 'normal' into a new image."""
        W, H = (size, size) if isinstance(size, int) else size
        img = bpy.data.images.new(f'{self.mat.name}_{kind}', W, H, alpha=False, float_buffer=False)
        img.colorspace_settings.name = 'sRGB' if srgb else 'Non-Color'
        self.img_node.image = img
        self.nt.nodes.active = self.img_node
        self.img_node.select = True
        bpy.context.view_layer.objects.active = obj
        bpy.ops.object.select_all(action='DESELECT')
        obj.select_set(True)
        if samples:
            bpy.context.scene.cycles.samples = samples
        if kind == 'normal':
            for l in list(self.nt.links):
                if l.to_node == self.out:
                    self.nt.links.remove(l)
            self.nt.links.new(self.principled.outputs['BSDF'], self.out.inputs['Surface'])
            bpy.ops.object.bake(type='NORMAL', normal_space='TANGENT', margin=6, use_clear=True)
        else:
            self._emit_to(self.color if kind == 'color' else self.orm)
            bpy.ops.object.bake(type='EMIT', margin=6, use_clear=True)
        if path:
            img.filepath_raw = os.path.abspath(path)
            img.file_format = 'PNG'
            img.save()
        return img
