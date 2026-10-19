"""Premium damaged structural steel girder (pilot B).

A rolled I-section (W-shape, 340 deep x 200 flange, 14 mm flanges, 9 mm web) that failed in a
plastic hinge under extreme load: the compression (top) flange buckled in waves, the web crippled,
the tension (bottom) flange and web tore open at the hinge with curled lips, the section twisted,
and the far end sheared off jaggedly. The near end keeps its bolted end plate, a web splice and
stiffeners.

Method: sheet-metal mid-surfaces (flanges, web, fillets) -> sub-cell contour clipping against
tear masks -> one coherent deformation field (bend, twist, buckling, crush, curled lips) ->
Blender Solidify (real thickness, including torn rims) -> hardware -> UVs -> baked PBR -> GLB.

Run: C:/Users/aadit/bh6-bpy-venv/Scripts/python.exe assets-src/pilots/steel_girder_premium.py [--stage geometry|full]
Everything is seeded and deterministic.
"""
import argparse
import math
import os
import sys
import time

import numpy as np

sys.path.insert(0, os.path.dirname(__file__))
from pylib.noise import fbm, smoothstep, vnoise  # noqa: E402
from pylib import hardware, rebar  # noqa: E402
from pylib.sheets import clip_mesh, grid_mesh  # noqa: E402

SEED = 20261019
D, BF, TF, TW = 0.34, 0.20, 0.014, 0.009     # depth, flange width, flange and web thickness (m)
ZF = D / 2 - TF / 2                            # flange mid-surface height
RF, TFIL = 0.012, 0.008                        # web/flange fillet radius and its plate thickness
LEN = 4.7                                      # rest length before the far end is torn off
S_H = 2.30                                     # hinge station
BEND = math.radians(40.0)                      # total bend angle through the hinge
W_H = 0.085                                    # hinge width (bend concentration)
S_T = 2.34                                     # tear station (tension side, just past the hinge apex)


# ------------------------------------------------------------------ sampling rings
def rings():
    """Ring stations along the beam: fine at the hinge and the torn end, coarse elsewhere."""
    s, out = 0.0, []
    while s < LEN:
        out.append(s)
        near = min(abs(s - S_H) - 0.34, abs(s - 4.25) - 0.26, abs(s - 0.0) - 0.0 + 0.5)
        dist = max(near, 0.0) if abs(s - S_H) <= 1.2 or abs(s - 4.25) <= 1.0 else 0.35
        s += 0.007 + 0.16 * max(min(abs(s - S_H) - 0.34, abs(s - 4.25) - 0.26), 0.0)
        s = min(s, LEN) if s > LEN - 1e-9 else s
    out.append(LEN)
    return np.asarray(out)


# ------------------------------------------------------------------ masks (keep > 0)
def far_end_keep(s, y, z):
    s_cut = 4.18 + 0.20 * (-z / D) + 0.12 * fbm(y * 6.0 + 3.0, z * 5.0, None, 3, seed=SEED + 1) + 0.05 * vnoise(y * 38.0, z * 38.0, None, SEED + 2)
    return s_cut - s


def flange_tear_keep(s, y, z):
    """Bottom (tension) flange severed across its whole width: a stepped, irregular gap (it stretches open as the beam bends)."""
    step = 0.035 * np.tanh(5.0 * fbm(y * 6.0 + 7.0, 0 * y, None, 2, seed=SEED + 3))
    s_line = S_T + step + 0.03 * fbm(y * 14.0, 0 * y, None, 3, seed=SEED + 13)
    w = 0.050 * (0.75 + 0.5 * vnoise(y * 17.0, 0 * y, None, SEED + 4)) * (0.55 + 0.45 * smoothstep(-0.10, 0.10, y))
    m = np.abs(s - s_line) - w / 2
    return np.where(z < -0.10, m, 1.0)


def web_tear_g(s, z):
    """Implicit tear region (g > 0 inside): a ragged crescent opening up from the bottom flange."""
    ds, dz = (s - (S_T + 0.02)) / 0.175, (z + 0.125) / 0.105
    return 1.0 - ds * ds - dz * dz + 0.32 * fbm(s * 11.0, z * 11.0 + 4.0, None, 3, seed=SEED + 5)


def web_tear_keep(s, y, z):
    return -web_tear_g(s, z)


# ------------------------------------------------------------------ deformation
def _tables():
    ss = np.linspace(0.0, LEN + 0.5, 8001)
    kappa = (BEND / (W_H * math.sqrt(math.pi))) * np.exp(-(((ss - S_H) / W_H) ** 2))
    # A gentler secondary bend in the far span keeps the end from looking like a single kink.
    kappa += (math.radians(7.0) / (0.5 * math.sqrt(math.pi))) * np.exp(-(((ss - 3.4) / 0.5) ** 2))
    theta = np.concatenate([[0.0], np.cumsum(0.5 * (kappa[1:] + kappa[:-1]) * np.diff(ss))])
    rx = np.concatenate([[0.0], np.cumsum(0.5 * (np.cos(theta[1:]) + np.cos(theta[:-1])) * np.diff(ss))])
    rz = np.concatenate([[0.0], np.cumsum(0.5 * (np.sin(theta[1:]) + np.sin(theta[:-1])) * np.diff(ss))])
    return ss, theta, rx, rz


_TAB = _tables()
Z_PIVOT = 0.09          # the bend pivots near the compression flange: the tension side stretches open and tears


def tri_wave(x):
    """Triangle wave in [-1, 1]: sharp creases between flat panels (sheet metal folds, not sine ripples)."""
    return np.arcsin(np.sin(x)) * (2.0 / math.pi)


def tent(d, w):
    return np.maximum(0.0, 1.0 - np.abs(d) / w)


_RNG = np.random.default_rng(SEED + 11)
# Yield lines of the crippled web: (station offset, height, angle, half-width, signed amplitude).
_YIELD = [(float(_RNG.uniform(-0.20, 0.30)), float(_RNG.uniform(-0.15, 0.15)), float(_RNG.uniform(-1.2, 1.2)), float(_RNG.uniform(0.035, 0.07)), float(_RNG.choice([-1, 1]) * _RNG.uniform(0.010, 0.022))) for _ in range(11)]


def deform(P, aux=None):
    """Rest-space points (s, y, z) -> deformed world points, as one coherent field.

    If `aux` is a dict it receives 'crumple' (0..1): how crushed or buckled each point is."""
    s, y, z = P[:, 0].astype(np.float64), P[:, 1].astype(np.float64), P[:, 2].astype(np.float64)
    env = np.exp(-(((s - S_H) / 0.20) ** 2))
    env_w = np.exp(-(((s - S_H - 0.03) / 0.30) ** 2))
    # Compression flange: accordion creases growing toward the flange tips.
    top = smoothstep(0.03, 0.12, z)
    tip = (np.abs(y) / (BF / 2)) ** 1.6
    wave = 2 * math.pi * (s - S_H - 0.02) / 0.056 + 1.3 * np.sign(y) + 2.0 * fbm(s * 7.0, y * 3.0, None, 2, seed=SEED + 6)
    dz = top * 0.030 * env * tip * tri_wave(wave) * (0.65 + 0.7 * vnoise(s * 16.0, np.sign(y) * 3.0, None, SEED + 6))
    dz += top * 0.012 * env * (1.0 - tip) * tri_wave(wave * 0.5 + 1.0)
    bot = smoothstep(-0.03, -0.12, z)
    dz += bot * 0.007 * env * tip * tri_wave(wave * 0.7)
    web_mask = 1.0 - np.maximum(top, bot)
    # Web crippling: sharp yield lines (tent folds) between flat panels, plus a gentle overall bow.
    dy = np.zeros_like(s)
    for ds, zc, ang, w, amp in _YIELD:
        d = (s - (S_H + ds)) * math.cos(ang) + (z - zc) * math.sin(ang)
        dy += amp * tent(d, w)
    dy = web_mask * (dy * env_w + 0.010 * env_w * np.sin(math.pi * (z + D / 2) / D))
    crumple = np.clip(np.abs(dz) / 0.022 + np.abs(dy) / 0.02, 0.0, 1.0)
    dy += 0.012 * smoothstep(S_H - 0.1, S_H + 0.7, s)                       # the far span has slid sideways a little
    # Crushing: the section loses depth at the hinge.
    z_c = z * (1.0 - 0.15 * env) + dz
    # Curled tear lips: flaps peel alternately outward and inward around the torn web and flange.
    g = web_tear_g(s, z)
    lip = smoothstep(0.42, 0.0, -g) * (g < 0.5)
    n = np.sign(fbm(s * 9.0 + 2.0, z * 9.0, None, 2, seed=SEED + 7)) * (0.5 + 0.8 * vnoise(s * 21.0, z * 21.0, None, SEED + 9))
    dy = dy + (np.abs(y) < 0.03) * 0.045 * lip * n
    if aux is not None:
        aux['crumple'] = np.maximum(crumple, lip * (np.abs(y) < 0.03))
    near_t = smoothstep(0.085, 0.0, np.abs(s - S_T) - 0.03)
    fl = (z < -0.10) * near_t
    z_c = z_c - fl * 0.040 * np.sign(fbm(y * 11.0 + 5.0, s * 7.0, None, 2, seed=SEED + 8)) * (0.45 + 0.8 * vnoise(y * 28.0, s * 11.0, None, SEED + 10))
    y_c = y + dy
    # Twist about the centreline, developing across the hinge and beyond.
    phi = 0.17 * smoothstep(S_H - 0.12, S_H + 0.9, s) + 0.05 * smoothstep(3.3, 4.4, s)
    cy, sy = np.cos(phi), np.sin(phi)
    yt, zt = y_c * cy - z_c * sy, y_c * sy + z_c * cy
    # Global bend about a pivot line near the compression flange.
    ss, theta, rx, rz = _TAB
    th = np.interp(s, ss, theta)
    cx, cz = np.interp(s, ss, rx), np.interp(s, ss, rz)
    nx, nz = -np.sin(th), np.cos(th)
    return np.stack([cx + (zt - Z_PIVOT) * nx, yt, cz + (zt - Z_PIVOT) * nz + Z_PIVOT], axis=1)


def damage_colors(rest):
    """Per-vertex wear drivers for the paint/rust bake: R = proximity to torn edges, G = crumple."""
    s, y, z = rest[:, 0], rest[:, 1], rest[:, 2]
    aux = {}
    deform(rest, aux)
    prox = np.exp(-(np.maximum(far_end_keep(s, y, z), 0) / 0.06) ** 2)
    prox = np.maximum(prox, np.where(z < -0.10, np.exp(-(np.maximum(flange_tear_keep(s, y, z), 0) / 0.04) ** 2), 0.0))
    prox = np.maximum(prox, np.exp(-(np.maximum(-web_tear_g(s, z) * 0.12, 0) / 0.05) ** 2) * (np.abs(y) < 0.02))
    return np.stack([prox, aux['crumple'], np.zeros_like(prox), np.ones_like(prox)], axis=1).astype(np.float32)


# ------------------------------------------------------------------ sheets
class Sheet:
    def __init__(self, name, thickness, pts, tris, mapper_rest):
        self.name, self.thickness, self.rest, self.tris = name, thickness, pts, tris


def build_sheets():
    s_vals = rings()
    sheets = []
    ny = int(round(BF / 0.0075)) + 1
    nz = int(round(2 * ZF / 0.0075)) + 1
    y_vals = np.linspace(-BF / 2, BF / 2, ny)
    z_vals = np.linspace(-ZF, ZF, nz)

    def mk(name, thickness, u, v, mapper, keeps):
        pts, uvs, tris = grid_mesh(u, v, mapper)
        for keep in keeps:
            m = keep(pts[:, 0], pts[:, 1], pts[:, 2])
            m = np.broadcast_to(m, (len(pts),))
            pts, uvs, tris = clip_mesh(pts, uvs, tris, m)
        sheets.append(Sheet(name, thickness, pts, tris, mapper))

    mk('flange_top', TF, s_vals, y_vals, lambda S, Y: np.stack([S, Y, np.full_like(S, ZF)], 1), [far_end_keep])
    mk('flange_bottom', TF, s_vals, y_vals, lambda S, Y: np.stack([S, Y, np.full_like(S, -ZF)], 1), [far_end_keep, flange_tear_keep])
    mk('web', TW, s_vals, z_vals, lambda S, Z: np.stack([S, np.zeros_like(S), Z], 1), [far_end_keep, web_tear_keep])
    # Fillets (four): arcs between the web faces and the flange inner faces.
    phi = np.linspace(0.0, math.pi / 2, 7)
    ZI = D / 2 - TF
    for ysg in (1, -1):
        for zsg in (1, -1):
            Rm = RF + TFIL / 2

            def mapper(S, PH, ysg=ysg, zsg=zsg):
                cy, cz = ysg * (TW / 2 + RF), zsg * (ZI - RF)
                return np.stack([S, cy - ysg * Rm * np.cos(PH), cz + zsg * Rm * np.sin(PH)], 1)
            mk(f'fillet_{"p" if ysg > 0 else "n"}{"t" if zsg > 0 else "b"}', TFIL, s_vals, phi, mapper,
               [far_end_keep, web_tear_keep] if True else [])
    return sheets


# ------------------------------------------------------------------ plates, hardware, welds
HOLE_R = 0.0135
YP = 0.0045 + 0.0035   # centre line of a bead against the web


def polygon_keep(y, z):
    """Stiffener outline (y from the web, z): rectangle with the web-side and flange-side corners coped."""
    rect = np.minimum(np.minimum(0.0875 - y, y - 0.0045), 0.150 - np.abs(z))
    cope_web = (0.150 - np.abs(z)) + (y - 0.0045) - 0.024
    cope_tip = (0.150 - np.abs(z)) + (0.0875 - y) - 0.012
    return np.minimum(np.minimum(rect, cope_web), cope_tip)


def stiffener_points(s0, side, peel):
    ys = np.linspace(0.0045, 0.0875, 14)
    zs = np.linspace(-0.150, 0.150, 50)
    pts, uvs, tris = grid_mesh(ys, zs, lambda Y, Z: np.stack([np.full_like(Y, s0), side * Y, Z], 1))
    keep = polygon_keep(np.abs(pts[:, 1]), pts[:, 2])
    pts, uvs, tris = clip_mesh(pts, uvs, tris, keep)
    if peel:
        # Torn partly off the web: hinged at the web weld, swung outward and bowed.
        y0 = side * 0.0045
        d = pts[:, 1] - y0
        pts = pts.copy()
        pts[:, 0] = s0 + peel * np.abs(d) * math.sin(0.62) + 0.012 * np.sin(math.pi * (pts[:, 2] + 0.15) / 0.30) * np.abs(d) / 0.083
        pts[:, 1] = y0 + d * math.cos(0.62)
    return pts, tris


def build_hardware(blend, bpy):
    """Returns dict of Blender objects: end_plate, splice (list), stiffeners (list), bolts, welds."""
    out = {'plates': [], 'bolts': None, 'welds': None}
    # End plate: extended plate with eight bolt positions (one open, one sheared).
    bolt_pos = [(sy * 0.07, z) for sy in (-1, 1) for z in (-0.205, -0.08, 0.08, 0.205)]
    holes = [(y, z, HOLE_R, 20) for y, z in bolt_pos]
    v, t = blend.plate_mesh(blend.rounded_rect(0.26, 0.50, 0.014, 6), holes, lambda a, b: (-0.008, a, b))
    ep = blend.mesh_object('end_plate', v, t)
    blend.solidify(ep, 0.016)
    blend.bevel(ep, 0.0014, 2)
    out['plates'].append(ep)
    bverts, btris, off = [], [], 0

    def add_bolt(*a, **kw):
        nonlocal off
        v_, t_ = hardware.bolt(*a, **kw)
        bverts.append(v_)
        btris.append(t_ + off)
        off += len(v_)

    for k, (y, z) in enumerate(bolt_pos):
        if k == 1:
            continue                                        # open hole: the bolt is gone
        add_bolt((-0.016, y, z), (1, 0, 0), 0.016, seed=k, shank_sheared=0.060 if k == 6 else 0.0, with_nut=(k != 6))
    # Web splice: a plate each side of the web, 3 x 3 bolts through the web.
    sx = 1.05
    cols, rows = (0.88, 1.05, 1.22), (-0.085, 0.0, 0.085)
    for side in (1, -1):
        yc = side * (TW / 2 + 0.004)
        v, t = blend.plate_mesh(blend.rounded_rect(0.54, 0.27, 0.010, 5), [(c - sx, r, HOLE_R, 18) for c in cols for r in rows], lambda a, b, yc=yc: (sx + a, yc, b))
        sp = blend.mesh_object(f'splice_{"p" if side > 0 else "n"}', v, t)
        blend.solidify(sp, 0.008)
        blend.bevel(sp, 0.0012, 2)
        out['plates'].append(sp)
    for ci, c in enumerate(cols):
        for ri, r in enumerate(rows):
            add_bolt((c, TW / 2 + 0.008, r), (0, -1, 0), 0.025, seed=100 + ci * 3 + ri)
    # Stiffeners: near pair (intact) and far pair (one torn partly off).
    welds = []
    rng = np.random.default_rng(SEED + 70)
    for s0, peel_side in ((1.72, 0), (S_H + 0.58, 1)):
        for side in (1, -1):
            peel = 1.0 if (peel_side and side == 1) else 0.0
            pts, tris = stiffener_points(s0, side, peel)
            world = deform(pts).astype(np.float32)
            so = blend.mesh_object(f'stiffener_{s0:.2f}_{side}', world, tris)
            blend.solidify(so, 0.010)
            blend.bevel(so, 0.0012, 2)
            out['plates'].append(so)
            face = -1 if s0 < S_H else 1
            sb = s0 + face * (0.005 + 0.0035)
            zi = ZF - TF / 2 - 0.0035
            paths = [[(sb, side * (TW / 2 + 0.0035), z) for z in np.linspace(-0.125, 0.125, 40)]]
            if not peel:
                paths += [[(sb, side * y, sg * zi) for y in np.linspace(TW / 2 + RF, 0.084, 22)] for sg in (1, -1)]
            welds += [(np.asarray(p), s0) for p in paths]
    # End-plate welds around the beam section.
    ex = 0.0045
    ew = [[(ex, y, 0.1735) for y in np.linspace(-0.098, 0.098, 40)], [(ex, y, -0.1735) for y in np.linspace(-0.098, 0.098, 40)]]
    for sg in (1, -1):
        for ys in (1, -1):
            ew.append([(ex, ys * y, sg * (D / 2 - TF - 0.0035)) for y in np.linspace(TW / 2 + RF + 0.002, 0.097, 22)])
        ew.append([(ex, sg * (TW / 2 + 0.0035), z) for z in np.linspace(-0.14, 0.14, 40)])
    welds += [(np.asarray(p), 0.0) for p in ew]
    wv, wt, off = [], [], 0
    for k, (path, s0) in enumerate(welds):
        path = deform(path).astype(np.float64) if s0 > S_H else path
        scale = hardware.weld_path_radius(len(path), SEED + 200 + k) / 0.0045
        v_, t_, _ = rebar.sweep(path, 0.0045, ribbed=True, ring_step=0.0045, segs=6, pitch=0.0075, rib_amp=0.16, long_amp=0.0, radius_scale=scale)
        wv.append(v_)
        wt.append(t_ + off)
        off += len(v_)
    out['bolts'] = blend.mesh_object('bolts', np.concatenate(bverts), np.concatenate(btris))
    out['welds'] = blend.mesh_object('welds', np.concatenate(wv), np.concatenate(wt))
    return out


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument('--stage', default='full', choices=['geometry', 'full'])
    ap.add_argument('--bake-size', type=int, default=2048)
    ap.add_argument('--samples', type=int, default=24)
    ap.add_argument('--out', default=os.path.join('public', 'assets', 'models', 'candidates', 'steel_girder_premium.glb'))
    ap.add_argument('--bake-dir', default=os.path.join('test-results', 'pilot-bake'))
    args = ap.parse_args()
    t0 = time.time()
    from pylib import bake, blend, materials
    import bpy
    here = os.path.dirname(__file__)
    tex = lambda n: os.path.join(here, 'textures', n)  # noqa: E731
    sheets = build_sheets()
    blend.reset()
    objs = []
    for sh in sheets:
        obj = blend.mesh_object(sh.name, deform(sh.rest).astype(np.float32), sh.tris)
        blend.set_vertex_colors(obj, damage_colors(sh.rest), name='dmg')
        blend.solidify(obj, sh.thickness)
        objs.append(obj)
    hw = build_hardware(blend, bpy)
    for o in hw['plates']:
        blend.set_vertex_colors(o, np.tile(np.array([0, 0, 0, 1], dtype=np.float32), (len(o.data.vertices), 1)), name='dmg')
    painted = objs + hw['plates']
    bpy.ops.object.select_all(action='DESELECT')
    for o in painted:
        o.select_set(True)
    bpy.context.view_layer.objects.active = painted[0]
    bpy.ops.object.join()
    beam = bpy.context.view_layer.objects.active
    beam.name = 'steel_girder_premium'
    blend.shade_by_angle(beam, 30.0)
    blend.shade_by_angle(hw['bolts'], 40.0)
    blend.shade_by_angle(hw['welds'], 55.0)
    print('painted', len(beam.data.vertices), 'verts', len(beam.data.polygons), 'faces; bolts', len(hw['bolts'].data.polygons), 'welds', len(hw['welds'].data.polygons), f'{time.time() - t0:.1f}s', flush=True)

    # Constant-factor hardware materials (galvanised bolts, dark weld beads).
    def simple(obj, rgb, rough, metal):
        m = bpy.data.materials.new(obj.name)
        m.use_nodes = True
        b = m.node_tree.nodes['Principled BSDF']
        b.inputs['Base Color'].default_value = (*rgb, 1)
        b.inputs['Roughness'].default_value = rough
        b.inputs['Metallic'].default_value = metal
        obj.data.materials.append(m)
    simple(hw['bolts'], (0.48, 0.48, 0.50), 0.42, 0.95)
    simple(hw['welds'], (0.16, 0.16, 0.17), 0.58, 0.55)

    if args.stage == 'full':
        os.makedirs(args.bake_dir, exist_ok=True)
        bake.unwrap(beam)
        print('unwrapped', f'{time.time() - t0:.1f}s', flush=True)
        bake.setup_cycles(args.samples)
        wm = bake.WearMaterial('painted_steel_bake', tex('rebar_rust_diff_1k.jpg'), tex('rebar_rust_nor_gl_1k.jpg'))
        beam.data.materials.clear()
        beam.data.materials.append(wm.mat)
        paths = {}
        for kind, srgb in (('color', True), ('orm', False), ('normal', False)):
            paths[kind] = os.path.join(args.bake_dir, f'steel_girder_{kind}.png')
            wm.bake(beam, kind, args.bake_size, srgb, path=paths[kind])
            print('baked', kind, f'{time.time() - t0:.1f}s', flush=True)
        beam.data.materials.clear()
        beam.data.materials.append(materials.pbr_material('painted_steel', paths['color'], paths['normal'], paths['orm']))
    else:
        simple(beam, (0.45, 0.09, 0.07), 0.55, 0.3)
    # The 'dmg' colour layer only drives the bake; it must not ship as COLOR_0 (the viewer would multiply it into the paint).
    size = blend.export_glb(args.out, [beam, hw['bolts'], hw['welds']], extra={'export_vertex_color': 'NONE'})
    print(f'exported {args.out} {size / 1e6:.2f} MB in {time.time() - t0:.1f}s')


if __name__ == '__main__':
    main()
