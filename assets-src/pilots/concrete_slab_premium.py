"""Premium broken reinforced-concrete slab (pilot A).

Pipeline: signed-distance volume (cast slab, a stepped main fracture, a spalled
notch, chips, branching cracks, aggregate stones) -> surface nets at CELL metres ->
Blender (cleanup, flat-face dissolve, UVs, PBR materials, rebar) -> GLB.

Run (Blender 4.5 as a Python module in a venv outside the repository):
  C:/Users/aadit/bh6-bpy-venv/Scripts/python.exe assets-src/pilots/concrete_slab_premium.py [--cell 0.005] [--stage geometry|full]
Everything is seeded: the output is a pure function of SEED and the parameters.
"""
import argparse
import math
import os
import sys
import time

import numpy as np

sys.path.insert(0, os.path.dirname(__file__))
from pylib.noise import bilinear, fbm, hash01, smoothstep, vnoise, worley2  # noqa: E402
from pylib.surfacenets import surface_nets  # noqa: E402

SEED = 20261018
L, W, T = 2.60, 1.50, 0.24          # cast slab (metres): length x, width y, thickness z
EDGE_R = 0.007                       # cast arris radius


def unit(v):
    v = np.asarray(v, dtype=np.float64)
    return v / np.linalg.norm(v)


# ---------------------------------------------------------------- fracture relief
def fracture_relief(u_min, u_max, v_min, v_max, res, seed, a_warp=0.11, a_terrace=0.05, a_cells=0.016, a_fine=0.004, a_ridge=0.020):
    """Height (metres, along the fracture normal) over the fracture surface param grid (u, v=z).

    Layers: low-frequency undulation, plateau terraces with sharp risers, angular cells
    (Voronoi cones with creased boundaries) and fine grit."""
    us = np.arange(u_min, u_max, res)
    vs = np.arange(v_min, v_max, res)
    U0, V0 = np.meshgrid(us, vs, indexing='ij')
    # Sheared/rotated noise domain: facet creases run at oblique angles, not along the grid axes.
    ca, sa = math.cos(0.62), math.sin(0.62)
    U, V = U0 * ca - V0 * sa * 2.2, U0 * sa / 2.2 + V0 * ca
    warp = fbm(U / 0.5, V / 0.45, None, 3, seed=seed) * a_warp
    t = fbm(U / 0.22 + 5.0, V / 0.15, None, 3, seed=seed + 1)
    terrace = np.tanh(t * 3.6) * a_terrace
    f1, f2, cid, _, _ = worley2(U / 0.075, V / 0.075, seed + 2)
    cells = (0.42 - f1) * a_cells * 2.0 * (0.6 + 0.8 * cid)
    crease = -(1.0 - smoothstep(0.0, 0.06, f2 - f1)) * a_cells * 1.15
    # Ridged facets: sharp crests between planar-looking chunks (angular, not blobby).
    ridged = (1.0 - np.abs(fbm(U / 0.14 + 9.0, V / 0.10, None, 3, seed=seed + 4))) ** 3 * a_ridge
    fine = fbm(U / 0.014, V / 0.014, None, 3, seed=seed + 3) * a_fine
    return (warp + terrace + cells + crease + ridged + fine).astype(np.float32), u_min, v_min, res


def sample_relief(rel, u, v):
    grid, u_min, v_min, res = rel
    return bilinear(grid, (u - u_min) / res, (v - v_min) / res)


class FractureFace:
    """A rough plane: offset along its horizontal normal n as a function of (u along the face, z)."""

    def __init__(self, a, n, dip_deg, seed, extent=(-1.2, 1.2), ledge=None, **relief_kw):
        self.a = np.asarray(a, dtype=np.float64)
        self.n = unit(n)
        self.u_axis = np.array([-self.n[1], self.n[0]])
        self.tan = math.tan(math.radians(dip_deg))
        self.ledge = ledge  # (amplitude m, z0, wander) : a horizontal shear step in the face
        self.seed = seed
        self.rel = fracture_relief(extent[0], extent[1], -T / 2 - 0.05, T / 2 + 0.05, 0.003, seed, **relief_kw)

    def offset_from(self, X, Y, Z):
        """n . (p - a) minus the face position: negative on the solid side of a break-away face."""
        dx, dy = X - self.a[0], Y - self.a[1]
        s = self.n[0] * dx + self.n[1] * dy
        u = self.u_axis[0] * dx + self.u_axis[1] * dy
        shape = np.broadcast(u, Z).shape
        u, z = np.broadcast_to(u, shape), np.broadcast_to(Z, shape)
        pos = sample_relief(self.rel, u, z) + self.tan * z
        if self.ledge:
            amp, z0, wander = self.ledge
            zl = z0 + wander * fbm(u / 0.3 + 2.0, 0 * u, None, 2, seed=self.seed + 7)
            pos = pos + amp * smoothstep(-0.008, 0.008, z - zl)
        return s - pos


class Crack:
    """A tapering crack: a noisy sheet of finite length, width and depth below the top face."""

    def __init__(self, a, direction, length, w0, seed, depth=0.17, wander=0.02, dip_deg=0.0, lip_w=0.05, lip_depth=0.016):
        self.a = np.asarray(a, dtype=np.float64)
        self.d = unit(direction)
        self.nrm = np.array([-self.d[1], self.d[0]])
        self.length, self.w0, self.depth, self.wander, self.seed = length, w0, depth, wander, seed
        self.tan = math.tan(math.radians(dip_deg))
        self.lip_w, self.lip_depth = lip_w, lip_depth

    def coords(self, X, Y):
        dx, dy = X - self.a[0], Y - self.a[1]
        return self.d[0] * dx + self.d[1] * dy, self.nrm[0] * dx + self.nrm[1] * dy

    def inside(self, X, Y, Z):
        """Positive inside the crack void; a large negative value away from the crack."""
        u, s = self.coords(X, Y)
        shape = np.broadcast(u, s, Z).shape
        u, s, z = np.broadcast_to(u, shape), np.broadcast_to(s, shape), np.broadcast_to(Z, shape)
        out = np.full(shape, -0.05, dtype=np.float32)
        near = (np.abs(s) < 0.07 + self.wander + abs(self.tan) * 0.15) & (u > -0.03) & (u < self.length + 0.03)
        if not near.any():
            return out
        u, s, z = u[near].astype(np.float64), s[near].astype(np.float64), z[near].astype(np.float64)
        o = fbm(u / 0.3 + 3.1, z / 0.07, None, 3, seed=self.seed) * self.wander + self.tan * z
        t = np.clip(u / self.length, 0.0, 1.0)
        width = self.w0 * (1.0 - t) ** 0.7 * (0.75 + 0.5 * vnoise(u / 0.12, z / 0.05, None, self.seed + 5))
        side = width / 2 - np.abs(s - o)
        ends = np.minimum(u + 0.01, (self.length - u) * 0.35)
        zb = -T / 2 + (T - self.depth) + fbm(u / 0.2, 0 * u, None, 2, seed=self.seed + 9) * 0.03
        void = np.minimum(np.minimum(side, ends), (z - zb) * 0.8)
        # Flaking lip: the top surface spalls back from the crack edge in a bevel of irregular width.
        a_ = np.abs(s - o)
        wl = self.lip_w * (0.35 + 0.9 * vnoise(u / 0.09 + 11.0, 0 * u, None, self.seed + 21)) * smoothstep(0.0, 0.08, u) * (1.0 - 0.7 * t)
        dl = self.lip_depth * (0.4 + 1.0 * vnoise(u / 0.07 + 5.0, a_ / 0.03, None, self.seed + 22))
        frac = np.clip(a_ / np.maximum(wl, 1e-4), 0.0, 1.0)
        lip = ((z - (T / 2 - dl * (1.0 - frac) ** 0.8)) * 0.8) * (frac < 1.0) - 0.05 * (frac >= 1.0)
        out[near] = np.maximum(np.maximum(void, lip), -0.05)
        return out


class Chip:
    """A conchoidal chip or spall crater: a noisy ellipsoid removed from the solid."""

    def __init__(self, c, radii, yaw_deg, seed, amp=0.004):
        self.c = np.asarray(c, dtype=np.float64)
        self.r = np.asarray(radii, dtype=np.float64)
        self.cy, self.sy = math.cos(math.radians(yaw_deg)), math.sin(math.radians(yaw_deg))
        self.seed, self.amp = seed, amp

    def inside(self, X, Y, Z):
        dx, dy, dz = X - self.c[0], Y - self.c[1], Z - self.c[2]
        shape = np.broadcast(dx, dy, dz).shape
        dx, dy, dz = np.broadcast_to(dx, shape), np.broadcast_to(dy, shape), np.broadcast_to(dz, shape)
        out = np.full(shape, -0.05, dtype=np.float32)
        rmax = float(self.r.max()) * 1.35
        near = (np.abs(dx) < rmax) & (np.abs(dy) < rmax) & (np.abs(dz) < rmax)
        if not near.any():
            return out
        x, y, z = dx[near].astype(np.float64), dy[near].astype(np.float64), dz[near].astype(np.float64)
        xr, yr = self.cy * x + self.sy * y, -self.sy * x + self.cy * y
        q = np.sqrt((xr / self.r[0]) ** 2 + (yr / self.r[1]) ** 2 + (z / self.r[2]) ** 2)
        n = fbm(x / 0.05 + 1.3, y / 0.05, z / 0.05, 3, seed=self.seed)
        out[near] = np.maximum((1.0 - q) * float(self.r.min()) + n * self.amp, -0.05)
        return out


# ---------------------------------------------------------------- the slab design
def build_design(seed=SEED):
    rng = np.random.default_rng(seed)
    th = math.radians(-22)
    main = FractureFace(a=(0.80, 0.0), n=(math.cos(th), math.sin(th)), dip_deg=-8.0, seed=seed + 10, ledge=(-0.055, 0.015, 0.03))
    # The top-left corner has broken away along a second, steeper fracture; the bottom and lower-left
    # edges stay cast (with arris), so the original manufactured form is still legible.
    corner = FractureFace(a=(-0.98, 0.50), n=(-0.62, 0.78), dip_deg=14.0, seed=seed + 15, ledge=(0.04, -0.02, 0.025), a_warp=0.07, a_terrace=0.035, a_cells=0.014)
    # Irregular spalled notch in the +y edge: tangent planes of a perturbed ellipse (outward normals).
    c, ax, ay, K = np.array([0.06, 0.675]), 0.36, 0.27, 7
    notch = []
    for k in range(K):
        t = 2 * math.pi * (k + 0.5) / K + rng.uniform(-0.22, 0.22)
        r = 1 + rng.uniform(-0.15, 0.12)
        a = c + np.array([ax * math.cos(t), ay * math.sin(t)]) * r
        n = unit(np.array([math.cos(t) / ax, math.sin(t) / ay]) + rng.normal(0, 0.16, 2))
        notch.append(FractureFace(a=a, n=n, dip_deg=float(rng.uniform(-12, 12)), seed=seed + 20 + k, extent=(-0.9, 0.9), a_warp=0.04, a_terrace=0.025, a_cells=0.012))
    cracks = [
        Crack((-0.30, 0.47), (-0.25, -1.0), 1.25, 0.028, seed + 40, depth=0.20),
        Crack((0.78, -0.14), (-1.0, 0.16), 1.00, 0.020, seed + 41, depth=0.18),
        Crack((-0.36, 0.04), (-1.0, -0.42), 0.80, 0.015, seed + 42, depth=0.15),
        Crack((0.20, 0.40), (0.20, -1.0), 0.70, 0.016, seed + 43, depth=0.17),
        Crack((-1.05, -0.50), (0.9, 0.5), 0.45, 0.007, seed + 44, depth=0.12),
        Crack((0.40, -0.30), (-0.3, -1.0), 0.40, 0.008, seed + 45, depth=0.12),
    ]
    chips = [
        Chip((0.64, 0.10, 0.12), (0.12, 0.10, 0.07), 20, seed + 60),
        Chip((0.72, -0.42, 0.12), (0.10, 0.08, 0.06), -30, seed + 61),
        Chip((-1.30, -0.30, 0.12), (0.07, 0.06, 0.05), 0, seed + 64),
        Chip((0.98, 0.34, -0.12), (0.10, 0.12, 0.05), 0, seed + 69),
        Chip((0.86, -0.22, -0.12), (0.11, 0.08, 0.05), 10, seed + 65),
        Chip((0.55, -0.75, -0.02), (0.20, 0.07, 0.07), 0, seed + 66),
        Chip((-0.78, 0.74, 0.12), (0.09, 0.05, 0.05), 0, seed + 67),
    ]
    return main, notch, cracks, chips, corner


def box_field(X, Y, Z, drop):
    """Cast slab with rounded arrises. Positive inside. `drop` shifts z for the dropped block."""
    qx = np.abs(X) - (L / 2 - EDGE_R)
    qy = np.abs(Y) - (W / 2 - EDGE_R)
    qz = np.abs(Z + drop) - (T / 2 - EDGE_R)
    ox, oy, oz = np.maximum(qx, 0), np.maximum(qy, 0), np.maximum(qz, 0)
    outside = np.sqrt(ox * ox + oy * oy + oz * oz)
    inside = np.minimum(np.maximum(np.maximum(qx, qy), qz), 0)
    return -(outside + inside - EDGE_R)


def evaluate(design, cell, pad=0.045):
    main, notch, cracks, chips, corner = design
    nx, ny, nz = [int(round((s + 2 * pad) / cell)) + 1 for s in (L, W, T)]
    origin = np.array([-L / 2 - pad, -W / 2 - pad, -T / 2 - pad])
    xs = (origin[0] + np.arange(nx) * cell).astype(np.float32)
    ys = (origin[1] + np.arange(ny) * cell).astype(np.float32)
    zs = (origin[2] + np.arange(nz) * cell).astype(np.float32)
    f_cast = np.empty((nx, ny, nz), dtype=np.float32)
    f_break = np.empty((nx, ny, nz), dtype=np.float32)
    c1 = cracks[0]
    step = 48
    for i0 in range(0, nx, step):
        i1 = min(nx, i0 + step)
        X, Y, Z = xs[i0:i1][:, None, None], ys[None, :, None], zs[None, None, :]
        # The block beyond crack 1 has dropped by ~12 mm (fading toward the crack tip).
        u, s = c1.coords(X, Y)
        fade = np.clip(1.0 - np.maximum(u, 0) / (c1.length * 1.05), 0, 1) * np.exp(-np.abs(s) / 0.55) * smoothstep(-0.02, 0.0, u)
        drop = 0.022 * fade * smoothstep(-0.006, 0.006, s)
        f_cast[i0:i1] = box_field(X, Y, Z, drop)
        fb = -main.offset_from(X, Y, Z)
        body = None
        for face in notch:
            d = face.offset_from(X, Y, Z)
            body = d if body is None else np.maximum(body, d)
        # offset_from is negative inside each plane: the notch interior is where all are negative,
        # so max(offsets) is the solid-side field (positive outside the notch).
        fb = np.minimum(fb, body)
        fb = np.minimum(fb, -corner.offset_from(X, Y, Z))
        for cr in cracks:
            fb = np.minimum(fb, -cr.inside(X, Y, Z))
        for ch in chips:
            fb = np.minimum(fb, -ch.inside(X, Y, Z))
        f_break[i0:i1] = fb
    return f_cast, f_break, origin


def stone_field(P, seed, cell=0.030, prob=0.8, rmin=0.006, rmax=0.014):
    """Aggregate stones: ellipsoids on a jittered lattice. Positive inside a stone (metres)."""
    g = P / cell
    gi = np.floor(g).astype(np.int64)
    best = np.full(len(P), -1.0)
    for dx in (-1, 0, 1):
        for dy in (-1, 0, 1):
            for dz in (-1, 0, 1):
                cx, cy, cz = gi[:, 0] + dx, gi[:, 1] + dy, gi[:, 2] + dz
                present = hash01(cx, cy, cz, seed) < prob
                ctr = np.stack([cx + 0.5 + (hash01(cx, cy, cz, seed + 1) - 0.5) * 0.8, cy + 0.5 + (hash01(cx, cy, cz, seed + 2) - 0.5) * 0.8,
                                cz + 0.5 + (hash01(cx, cy, cz, seed + 3) - 0.5) * 0.8], axis=1) * cell
                r = rmin + (rmax - rmin) * hash01(cx, cy, cz, seed + 4)
                sq = 0.7 + 0.5 * hash01(cx, cy, cz, seed + 5)
                d = P - ctr
                dist = np.sqrt(d[:, 0] ** 2 + d[:, 1] ** 2 + (d[:, 2] / sq) ** 2)
                val = np.where(present, r - dist, -1.0)
                best = np.maximum(best, val)
    return best


def add_aggregate(f, f_cast, f_break, origin, cell, seed):
    """Roughen every fracture surface with grit and protruding aggregate stones in a thin band."""
    band = (np.abs(f) < 0.012) & (f_break < f_cast - 0.0005)
    idx = np.argwhere(band)
    P = origin + idx * cell
    fv = f[band].astype(np.float64)
    grit = fbm(P[:, 0] / 0.02, P[:, 1] / 0.02, P[:, 2] / 0.02, 3, seed=seed) * 0.0022
    stone = stone_field(P, seed + 100)
    fv = fv + grit
    f[band] = np.maximum(fv - 0.0016, np.minimum(stone, fv + 0.0050)).astype(np.float32)
    return int(band.sum())


def lowpass(f, w=0.07):
    """Light 7-point blur: removes sub-voxel slivers (non-manifold surface-net cells) without softening creases."""
    out = f * (1 - 6 * w)
    for ax in range(3):
        a = np.roll(f, 1, axis=ax)
        b = np.roll(f, -1, axis=ax)
        out += w * (a + b)
    # np.roll wraps: restore the (empty) outer shell.
    out[0], out[-1], out[:, 0], out[:, -1], out[:, :, 0], out[:, :, -1] = f[0], f[-1], f[:, 0], f[:, -1], f[:, :, 0], f[:, :, -1]
    return out


def build_mesh(cell, seed=SEED, f_out=None):
    t0 = time.time()
    design = build_design(seed)
    f_cast, f_break, origin = evaluate(design, cell)
    f = np.minimum(f_cast, f_break)
    n_band = add_aggregate(f, f_cast, f_break, origin, cell, seed)
    f = lowpass(f)
    if f_out is not None:
        f_out['f'] = f
    print(f'field {f.shape} band {n_band} in {time.time() - t0:.1f}s', flush=True)
    verts, tris = surface_nets(f, origin, cell)
    print(f'mesh {len(verts)} verts {len(tris)} tris in {time.time() - t0:.1f}s', flush=True)
    return verts, tris, f_cast, f_break, origin


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument('--cell', type=float, default=0.005)
    ap.add_argument('--target', type=int, default=110000, help='concrete triangle budget after decimation')
    ap.add_argument('--out', default=os.path.join('public', 'assets', 'models', 'candidates', 'concrete_slab_premium.glb'))
    args = ap.parse_args()
    t0 = time.time()
    from pylib import blend, materials, meshutil, rebar
    here = os.path.dirname(__file__)
    tex = lambda n: os.path.join(here, 'textures', n)  # noqa: E731

    holder = {}
    verts, tris, f_cast, f_break, origin = build_mesh(args.cell, f_out=holder)
    f = holder['f']
    blend.reset()
    obj = blend.mesh_object('concrete', verts, tris)
    print('clean', blend.clean_mesh(obj), flush=True)
    blend.dissolve_flat_and_triangulate(obj)
    print('clean2', blend.clean_mesh(obj), flush=True)
    print('decimated to', blend.decimate(obj, args.target), 'tris', flush=True)
    print('post-decimate clean', blend.clean_mesh(obj), 'validate changed:', blend.validate_clean(obj), flush=True)
    blend.shade_by_angle(obj, 42.0)
    me = obj.data
    verts, tris = materials.read_triangles(obj)
    print('final concrete', len(verts), 'verts', len(tris), 'tris', flush=True)

    # Classify faces: original cast surface vs fresh fracture.
    cen = verts[tris].mean(axis=1)
    is_cast = meshutil.sample_field(f_cast, origin, args.cell, cen) < meshutil.sample_field(f_break, origin, args.cell, cen) + 0.004
    materials.set_material_indices(obj, np.where(is_cast, 0, 1))
    ax, sign = meshutil.face_axes_smoothed(verts, tris)
    tile = np.where(is_cast, 1.6, 0.9).astype(np.float32)
    blend.set_loop_uvs(obj, meshutil.box_uv(verts, tris, ax, sign, tile))

    # Rebar: only where exposed.
    solid_f = lambda P: meshutil.sample_field(f, origin, args.cell, P)  # noqa: E731
    segs = rebar.plan_bars(solid_f, SEED + 500, (L, W))
    rv, rt, ruv, off = [], [], [], 0
    for pts, rad, end_cut, start_cut in segs:
        if len(pts) < 3:
            continue
        v_, t_, uv_ = rebar.sweep(pts, rad, ribbed=True, end_cut_deg=end_cut, start_cut_deg=start_cut)
        rv.append(v_), rt.append(t_ + off), ruv.append(uv_)
        off += len(v_)
    rv, rt, ruv = np.concatenate(rv), np.concatenate(rt), np.concatenate(ruv)
    print('rebar', len(segs), 'segments', len(rv), 'verts', len(rt), 'tris', flush=True)

    # Neutral AO + rust staining near exposed bars -> vertex colours (COLOR_0 multiplies base colour).
    nrm = meshutil.vertex_normals(verts, tris)
    ao = np.clip(meshutil.cavity_ao(f, origin, args.cell, verts.astype(np.float64), nrm), 0, 1)
    base_v = (0.30 + 0.70 * ao) ** 1.15
    # Mottling: two scales of cement-paste variation plus slow weathering streaks (darker toward the underside).
    tint = 0.90 + 0.10 * fbm(verts[:, 0] / 0.6, verts[:, 1] / 0.6, verts[:, 2] / 0.4, 3, seed=SEED + 300) + 0.05 * fbm(verts[:, 0] / 0.06, verts[:, 1] / 0.06, verts[:, 2] / 0.06, 2, seed=SEED + 301)
    tint = tint * (0.93 + 0.07 * smoothstep(-0.12, 0.12, verts[:, 2]))
    col = np.stack([base_v * tint, base_v * tint * 0.995, base_v * tint * 0.985, np.ones_like(base_v)], axis=1)
    bar_pts = rv[::7].astype(np.float64)
    d2 = np.full(len(verts), 9.0)
    for i0 in range(0, len(bar_pts), 400):
        d2 = np.minimum(d2, np.linalg.norm(verts[:, None, :] - bar_pts[None, i0:i0 + 400, :], axis=2).min(axis=1))
    w = np.exp(-(d2 / 0.045) ** 2) * 0.8
    col[:, :3] = col[:, :3] * (1 - w[:, None]) + (col[:, :3] * np.array([0.70, 0.42, 0.28])) * w[:, None]
    blend.set_vertex_colors(obj, col.astype(np.float32))

    me.materials.append(materials.pbr_material('concrete_cast', tex('concrete_wall_007_diff_1k.jpg'), tex('concrete_wall_007_nor_gl_1k.jpg'), tex('concrete_wall_007_arm_1k.jpg'), vertex_color=True))
    me.materials.append(materials.pbr_material('concrete_fracture', tex('concrete_debris_diff_1k.jpg'), tex('concrete_debris_nor_gl_1k.jpg'), tex('concrete_debris_arm_1k.jpg'), vertex_color=True, normal_strength=1.0))
    robj = blend.mesh_object('rebar', rv, rt)
    blend.shade_by_angle(robj, 55.0)
    blend.set_loop_uvs(robj, ruv[rt].reshape(-1, 2))
    robj.data.materials.append(materials.pbr_material('rebar_steel', tex('rebar_rust_diff_1k.jpg'), tex('rebar_rust_nor_gl_1k.jpg'), tex('rebar_rust_arm_1k.jpg')))

    obj.name = 'concrete_slab_premium'
    size = blend.export_glb(args.out, [obj, robj])
    print(f'exported {args.out} {size / 1e6:.2f} MB in {time.time() - t0:.1f}s')


if __name__ == '__main__':
    main()
