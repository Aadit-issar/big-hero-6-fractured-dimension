"""Concrete family builder. One generator, many parameterised outputs.

  C:/Users/aadit/bh6-bpy-venv/Scripts/python.exe assets-src/workflows/concrete/build.py --asset concrete_slab_rebar [--cell 0.005] [--stage field|full]

Hero assets (slab, wall): high-res signed-field mesh -> decimated low mesh + Cycles-baked normal/colour/AO/roughness atlas -> LODs.
Cheap assets (chunks, rubble): lower-res field -> decimated mesh with tiled shared PBR textures and vertex AO.
Take the heavy-job lock (see docs/PARALLEL_ASSET_BRIEF.md) for hero builds.
"""
import argparse
import json
import math
import os
import sys
import time

import numpy as np

HERE = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, HERE)
REPO = os.path.abspath(os.path.join(HERE, '..', '..', '..'))
TEX = os.path.join(REPO, 'assets-src', 'pilots', 'textures')
OUT = os.path.join(REPO, 'public', 'assets', 'models', 'candidates', 'concrete')
META = os.path.join(HERE, 'meta')

import designs  # noqa: E402
import fieldkit  # noqa: E402
from pylib.noise import fbm, smoothstep  # noqa: E402
from pylib.rebar import bent_path, sweep  # noqa: E402
from pylib.surfacenets import surface_nets  # noqa: E402

tex = lambda n: os.path.join(TEX, n)  # noqa: E731

# ------------------------------------------------------------------ recipes
SLAB_REBAR = dict(
    replaces='concrete_slab_rebar', label='Broken reinforced slab (stepped shear fracture, exposed rebar)', mode='hero', cell=0.005, target=56000, tex=2048,
    factory=lambda: designs.slab(
        'concrete_slab_rebar', L=2.7, W=1.55, T=0.24, seed=20261101, cracks=5, severity=1.0, spall=4, drop_mm=22, exposure=0.8,
        fractures=[dict(a=(0.84, 0.0), angle=-22, dip=-8, ledge=(-0.055, 0.015, 0.03)),
                   dict(a=(-1.02, 0.52), angle=128.5, dip=14, ledge=(0.04, -0.02, 0.025), relief=dict(a_warp=0.07, a_terrace=0.035, a_cells=0.014))]))
SLAB_PLAIN = dict(
    replaces='concrete_slab_plain', label='Long plain slab fragment (unreinforced, parallelogram break)', mode='hero', cell=0.006, target=30000, tex=1024, lods=False,
    factory=lambda: designs.slab(
        'concrete_slab_plain', L=3.4, W=1.1, T=0.20, seed=20261133, cracks=3, severity=0.6, spall=3, rebar=False, agg=1.1,
        fractures=[dict(a=(1.05, 0.0), angle=28, dip=6, ledge=(0.03, 0.0, 0.03)),
                   dict(a=(-1.18, 0.0), angle=191, dip=-7, ledge=(-0.035, 0.01, 0.03), relief=dict(a_warp=0.08, a_terrace=0.04))]))
WALL = dict(
    replaces='concrete_wall_breach', label='Wall section with blast breach and missing corner', mode='hero', cell=0.007, target=58000, tex=2048, rot=True,
    factory=lambda: designs.wall('concrete_wall_breach', L=3.4, W=2.4, T=0.26, seed=20261207, severity=1.0, exposure=1.2))


BIG_RELIEF = dict(a_warp=0.05, a_terrace=0.03, a_cells=0.011, a_ridge=0.014, a_fine=0.002, scale=0.8)


def _bars(*specs):
    return [dict(p0=s[0], d=s[1], rad=s[2], tail=s[3], bend=s[4], both=s[5] if len(s) > 5 else False) for s in specs]


CHUNK_A = dict(replaces='concrete_chunk_a', label='Compact faceted chunk with a bar stub', mode='cheap', cell=0.011, target=7000,
               factory=lambda: designs.chunk('concrete_chunk_a', 'a', 20261301, radii=(0.50, 0.40, 0.36), n_planes=12,
                                             bars=_bars(((0.0, 0.0, 0.0), (0.8, 0.3, 0.4), 0.011, 0.28, 50))))
CHUNK_B = dict(replaces='concrete_chunk_b', label='Slab-edge strip fragment with two bars', mode='cheap', cell=0.010, target=7000,
               factory=lambda: designs.chunk('concrete_chunk_b', 'b', 20261302, radii=(0.82, 0.38, 0.30), n_planes=9, relief=BIG_RELIEF,
                                             cast_faces=[(2, 1, 0.12), (2, -1, 0.12), (1, -1, 0.17)],
                                             bars=_bars(((0.0, -0.04, 0.062), (1.0, 0.06, 0.0), 0.011, 0.34, 40, True), ((0.1, 0.05, -0.062), (-1.0, 0.0, 0.02), 0.011, 0.2, 55))))
CHUNK_C = dict(replaces='concrete_chunk_c', label='Thin broad plate shard with cast corner', mode='cheap', cell=0.009, target=6500,
               factory=lambda: designs.chunk('concrete_chunk_c', 'c', 20261303, radii=(0.80, 0.62, 0.2), n_planes=8, relief=BIG_RELIEF,
                                             cast_faces=[(2, 1, 0.095), (2, -1, 0.095)],
                                             bars=_bars(((0.1, 0.0, 0.0), (0.2, -1.0, 0.0), 0.010, 0.2, 60, True))))
RUB_A = dict(replaces='rubble_cluster_a', label='Rubble cluster (broken pieces 10-40 cm)', mode='cheap', cell=0.012, target=9000,
             factory=lambda: designs.rubble('concrete_rubble_cluster_a', 20261401, pieces=13, spread=0.5))
RUB_B = dict(replaces='rubble_cluster_b', label='Rubble cluster with bar offcuts', mode='cheap', cell=0.012, target=9000,
             factory=lambda: designs.rubble('concrete_rubble_cluster_b', 20261402, pieces=17, spread=0.62, big=(0.2, 0.28), small=(0.07, 0.17), z_spread=0.14,
                                            bars=_bars(((0.0, 0.0, 0.05), (1.0, 0.4, 0.2), 0.009, 0.25, 45), ((0.0, 0.1, 0.0), (-0.7, -1.0, 0.1), 0.009, 0.18, 60))))
RECIPES = {'concrete_slab_rebar': SLAB_REBAR, 'concrete_slab_plain': SLAB_PLAIN, 'concrete_wall_breach': WALL,
           'concrete_chunk_a': CHUNK_A, 'concrete_chunk_b': CHUNK_B, 'concrete_chunk_c': CHUNK_C,
           'concrete_rubble_cluster_a': RUB_A, 'concrete_rubble_cluster_b': RUB_B}


# ------------------------------------------------------------------ shared steps
def build_field(d, cell):
    t0 = time.time()
    f_cast, f_nc, f_break, origin = fieldkit.evaluate(d, cell)
    f = np.minimum(f_cast, f_break)
    nb = fieldkit.add_aggregate(f, f_cast, f_break, origin, cell, d.seed, agg=d.agg)
    f = fieldkit.lowpass(f)
    print(f'field {f.shape} band {nb} {time.time() - t0:.1f}s', flush=True)
    return f, f_cast, f_nc, f_break, origin


def chunk_bar_paths(f, origin, cell, specs, seed):
    from pylib.meshutil import sample_field
    rng = np.random.default_rng(seed)
    out = []
    for sp in specs:
        for sgn in ((1, -1) if sp['both'] else (1,)):
            d = fieldkit.unit(sp['d']) * sgn
            p0 = np.asarray(sp['p0'], dtype=np.float64)
            s = np.arange(0, 3.0, 0.004)
            P = p0 + s[:, None] * d
            v = sample_field(f, origin, cell, P)
            out_idx = np.flatnonzero(v <= 0.0015)
            if len(out_idx) == 0 or out_idx[0] < 12:
                continue
            e = int(out_idx[0])
            base = P[max(e - 9, 0):e + 1]
            tail = bent_path(P[e], d, sp['tail'] * (1.0 if sgn > 0 else 0.7), rng, sp['bend'])
            out.append((np.concatenate([base, tail[1:]]), sp['rad'], float(rng.uniform(20, 40)), None))
    return out


def rebar_geometry(d, f, f_nc, origin, cell, lod=0):
    """Return (verts, tris, uv) for all visible bars, or None."""
    import rebar_plan
    if not d.rebar:
        return None
    r = d.rebar
    if r.get('chunk'):
        segs = chunk_bar_paths(f, origin, cell, r['bars'], d.seed + 500)
    else:
        segs = rebar_plan.plan_bars(f, f_nc, origin, cell, r['extent'], r['mats'], d.seed + 500, exposure=r['exposure'])
    sw = [dict(segs=6, ring_step=0.006, pitch=0.026, ribbed=True), dict(segs=5, ring_step=0.03, pitch=0.026, ribbed=False), dict(segs=4, ring_step=0.08, pitch=0.026, ribbed=False)][lod]
    rv, rt, ruv, off = [], [], [], 0
    for pts, rad, end_cut, start_cut in segs:
        v_, t_, uv_ = sweep(pts, rad, ribbed=sw['ribbed'], end_cut_deg=end_cut, start_cut_deg=start_cut, ring_step=sw['ring_step'], segs=sw['segs'], pitch=sw['pitch'], rib_amp=0.09, long_amp=0.06)
        rv.append(v_), rt.append(t_ + off), ruv.append(uv_)
        off += len(v_)
    if not rv:
        return None
    return np.concatenate(rv), np.concatenate(rt), np.concatenate(ruv)


def save_meta(rid, entry):
    os.makedirs(META, exist_ok=True)
    json.dump(entry, open(os.path.join(META, rid + '.json'), 'w'), indent=1)


def tri_count(objs):
    return int(sum(len(o.data.polygons) for o in objs))


def bounds_of(objs):
    import bpy
    pts = []
    for o in objs:
        v = np.empty(len(o.data.vertices) * 3, dtype=np.float32)
        o.data.vertices.foreach_get('co', v)
        pts.append(v.reshape(-1, 3))
    p = np.concatenate(pts)
    return [round(float(x), 3) for x in (p.max(axis=0) - p.min(axis=0))]


def rotate_x90(objs):
    import bpy
    for o in objs:
        o.rotation_euler = (math.pi / 2, 0, 0)
    bpy.ops.object.select_all(action='DESELECT')
    for o in objs:
        o.select_set(True)
    bpy.context.view_layer.objects.active = objs[0]
    bpy.ops.object.transform_apply(location=False, rotation=True, scale=False)


def rebar_object(name, rg, lod=0):
    import bpy
    from pylib import blend, materials
    rv, rt, ruv = rg
    robj = blend.mesh_object(name, rv, rt)
    blend.shade_by_angle(robj, 55.0)
    blend.set_loop_uvs(robj, ruv[rt].reshape(-1, 2))
    robj.data.materials.append(materials.pbr_material('rebar_steel', tex('rebar_rust_diff_1k.jpg'), tex('rebar_rust_nor_gl_1k.jpg'), tex('rebar_rust_arm_1k.jpg')))
    return robj


def classify_cast(f_cast, f_break, origin, cell, verts, tris, chunk=500000):
    from pylib.meshutil import sample_field
    out = np.empty(len(tris), dtype=bool)
    for i in range(0, len(tris), chunk):
        cen = verts[tris[i:i + chunk]].mean(axis=1)
        out[i:i + chunk] = sample_field(f_cast, origin, cell, cen) < sample_field(f_break, origin, cell, cen) + 0.004
    return out


# ------------------------------------------------------------------ hero (baked)
def run_hero(rid, R, cell, stage):
    import bpy
    from pylib import blend, materials, meshutil
    import bakelib
    t0 = time.time()
    d = R['factory']()
    f, f_cast, f_nc, f_break, origin = build_field(d, cell)
    rg = rebar_geometry(d, f, f_nc, origin, cell, 0)
    rg1 = rebar_geometry(d, f, f_nc, origin, cell, 1)
    rg2 = rebar_geometry(d, f, f_nc, origin, cell, 2)
    verts, tris = surface_nets(f, origin, cell)
    print(f'mesh {len(verts)} v {len(tris)} t {time.time() - t0:.1f}s; rebar {None if rg is None else len(rg[1])} tris', flush=True)
    blend.reset()
    hi = blend.mesh_object('hi', verts, tris)
    del verts, tris
    print('clean', blend.clean_mesh(hi), flush=True)
    blend.dissolve_flat_and_triangulate(hi)
    print('clean2', blend.clean_mesh(hi), 'hi tris', len(hi.data.polygons), f'{time.time() - t0:.1f}s', flush=True)
    hv, ht = materials.read_triangles(hi)
    is_cast = classify_cast(f_cast, f_break, origin, cell, hv, ht)
    materials.set_material_indices(hi, np.where(is_cast, 0, 1))
    del hv, ht
    hm_cast = bakelib.HiMat('hi_cast', tex('concrete_wall_007_diff_1k.jpg'), tex('concrete_wall_007_arm_1k.jpg'), 1.6)
    hm_frac = bakelib.HiMat('hi_frac', tex('concrete_debris_diff_1k.jpg'), tex('concrete_debris_arm_1k.jpg'), 0.9)
    hi.data.materials.append(hm_cast.mat)
    hi.data.materials.append(hm_frac.mat)
    # low mesh
    low = hi.copy()
    low.data = hi.data.copy()
    low.name = R['replaces'] + '_low'
    bpy.context.scene.collection.objects.link(low)
    print('decimated to', blend.decimate(low, R['target']), flush=True)
    print('low clean', blend.clean_mesh(low), blend.validate_clean(low), flush=True)
    blend.shade_by_angle(low, 42.0)
    bakelib.unwrap_smart(low)
    node = bakelib.target_material(low)
    print(f'unwrapped {time.time() - t0:.1f}s', flush=True)
    if stage == 'mesh':
        return
    size = R['tex']
    bakelib.setup(samples=6)
    imgs = {}
    for kind, srgb in (('normal', False), ('ao', False)):
        imgs[kind] = bakelib.bake(low, hi, node, kind, size, srgb)
        print('baked', kind, f'{time.time() - t0:.1f}s', flush=True)
    for kind, srgb in (('color', True), ('rough', False)):
        hm_cast.set(kind), hm_frac.set(kind)
        imgs[kind] = bakelib.bake(low, hi, node, kind, size, srgb)
        print('baked', kind, f'{time.time() - t0:.1f}s', flush=True)
    # compose
    ao = bakelib.pixels(imgs['ao'])[:, 0]
    col = bakelib.pixels(imgs['color'])
    rough = bakelib.pixels(imgs['rough'])[:, 0]
    shade = (0.40 + 0.60 * ao) ** 1.1
    col[:, :3] *= shade[:, None]
    col[:, 3] = 1.0
    orm = np.stack([ao, rough, np.zeros_like(ao), np.ones_like(ao)], axis=1)
    c_img = bakelib.make_image('col', col, size, True, 'JPEG')
    o_img = bakelib.make_image('orm', orm, size, False, 'JPEG')
    n_img = imgs['normal']
    n_img.file_format = 'JPEG'
    mat = bakelib.final_material(R['replaces'] + '_baked', c_img, o_img, n_img)
    bpy.data.objects.remove(hi)
    low.data.materials.clear()
    low.data.materials.append(mat)
    low.name = R['replaces']
    objs0 = [low] + ([rebar_object('rebar', rg)] if rg else [])
    # LODs
    lods = {}
    if R.get('lods', True):
        for lod, tgt, ts, rgx in ((1, 12000, 1024, rg1), (2, 2000, 512, rg2)):
            m = low.copy()
            m.data = low.data.copy()
            m.name = f"{R['replaces']}_lod{lod}"
            bpy.context.scene.collection.objects.link(m)
            blend.decimate(m, tgt)
            blend.shade_by_angle(m, 45.0)
            lm = bakelib.final_material(f'lod{lod}', bakelib.downscaled(c_img, ts, f'c{lod}', 'JPEG'), bakelib.downscaled(o_img, ts, f'o{lod}', 'JPEG'), bakelib.downscaled(n_img, ts, f'n{lod}', 'JPEG'))
            m.data.materials.clear()
            m.data.materials.append(lm)
            lods[lod] = [m] + ([rebar_object(f'rebar_lod{lod}', rgx, lod)] if rgx else [])
    if R.get('rot'):
        rotate_x90(objs0 + [o for v in lods.values() for o in v])
    export_set(rid, R, objs0, lods, t0)


def export_set(rid, R, objs0, lods, t0):
    from pylib import blend
    meta = dict(file=f'/assets/models/candidates/concrete/{rid}.glb', replaces=R['replaces'], category='rubble' if 'rubble' in rid else 'concrete',
                label=R['label'], state='Review candidate. Parameterised concrete family; shared textures.', source='assets-src/workflows/concrete/build.py')
    extra = {'export_vertex_color': 'ACTIVE' if R['mode'] == 'cheap' else 'NONE', 'export_image_format': 'JPEG'}
    size = blend.export_glb(os.path.join(OUT, rid + '.glb'), objs0, extra=extra)
    meta.update(triangles=tri_count(objs0), bytes=size, bounds_m=bounds_of(objs0), lods={})
    for lod, objs in lods.items():
        p = os.path.join(OUT, f'{rid}_lod{lod}.glb')
        sz = blend.export_glb(p, objs, extra=extra)
        meta['lods'][str(lod)] = dict(file=f'/assets/models/candidates/concrete/{rid}_lod{lod}.glb', triangles=tri_count(objs), bytes=sz)
    save_meta(rid, meta)
    print(json.dumps(meta), f'done {time.time() - t0:.1f}s', flush=True)


# ------------------------------------------------------------------ cheap (tiled textures)
def run_cheap(rid, R, cell, stage):
    import bpy
    from pylib import blend, materials, meshutil
    t0 = time.time()
    d = R['factory']()
    f, f_cast, f_nc, f_break, origin = build_field(d, cell)
    off = getattr(d, 'centre', np.zeros(3))
    rg = rebar_geometry(d, f, f_nc, origin, cell, 0)
    verts, tris = surface_nets(f, origin, cell)
    blend.reset()
    obj = blend.mesh_object('concrete', verts, tris)
    print('clean', blend.clean_mesh(obj, min_island_fraction=0.0 if 'rubble' in rid else 0.04), flush=True)
    blend.dissolve_flat_and_triangulate(obj)
    blend.clean_mesh(obj, min_island_fraction=0.0 if 'rubble' in rid else 0.04)
    print('decimated to', blend.decimate(obj, R['target']), flush=True)
    blend.clean_mesh(obj, min_island_fraction=0.0 if 'rubble' in rid else 0.02)
    blend.validate_clean(obj)
    blend.shade_by_angle(obj, 40.0)
    verts, tris = materials.read_triangles(obj)
    cen = verts[tris].mean(axis=1)
    is_cast = meshutil.sample_field(f_cast, origin, cell, cen) < meshutil.sample_field(f_break, origin, cell, cen) + 0.004
    materials.set_material_indices(obj, np.where(is_cast, 0, 1))
    ax, sign = meshutil.face_axes_smoothed(verts, tris)
    tile = np.where(is_cast, 1.6, 0.9).astype(np.float32)
    blend.set_loop_uvs(obj, meshutil.box_uv(verts, tris, ax, sign, tile))
    nrm = meshutil.vertex_normals(verts, tris)
    ao = np.clip(meshutil.cavity_ao(f, origin, cell, verts.astype(np.float64), nrm), 0, 1)
    base_v = (0.32 + 0.68 * ao) ** 1.15
    w = verts.astype(np.float64)
    tint = 0.92 + 0.08 * fbm(w[:, 0] / 0.5, w[:, 1] / 0.5, w[:, 2] / 0.4, 3, seed=d.seed + 300) + 0.04 * fbm(w[:, 0] / 0.06, w[:, 1] / 0.06, w[:, 2] / 0.06, 2, seed=d.seed + 301)
    col = np.stack([base_v * tint, base_v * tint * 0.996, base_v * tint * 0.99, np.ones_like(base_v)], axis=1)
    blend.set_vertex_colors(obj, col.astype(np.float32))
    me = obj.data
    me.materials.append(materials.pbr_material('concrete_cast', tex('concrete_wall_007_diff_1k.jpg'), tex('concrete_wall_007_nor_gl_1k.jpg'), tex('concrete_wall_007_arm_1k.jpg'), vertex_color=True))
    me.materials.append(materials.pbr_material('concrete_fracture', tex('concrete_debris_diff_1k.jpg'), tex('concrete_debris_nor_gl_1k.jpg'), tex('concrete_debris_arm_1k.jpg'), vertex_color=True))
    obj.name = R['replaces']
    objs = [obj] + ([rebar_object('rebar', rg)] if rg else [])
    if off.any():   # recentre rubble clusters on their lattice centre (the field is already centred); nothing to do
        pass
    export_set(rid, R, objs, {}, t0)


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument('--asset', required=True)
    ap.add_argument('--cell', type=float, default=None)
    ap.add_argument('--stage', default='full')
    a = ap.parse_args()
    R = RECIPES[a.asset]
    cell = a.cell or R['cell']
    (run_hero if R['mode'] == 'hero' else run_cheap)(a.asset, R, cell, a.stage)


if __name__ == '__main__':
    main()
