"""Parameterised concrete designs: slab, wall with breach, chunk polyhedra, rubble clusters.

Each factory returns a fieldkit.Design. Everything is a pure function of the arguments (seeded numpy rng).
Frame: x = length, y = width / height, z = thickness (the +z face carries the cracks).
"""
import math
import os
import sys

import numpy as np

sys.path.insert(0, os.path.dirname(__file__))
from fieldkit import Chip, Crack, Design, FractureFace, RoughPlane, box_field, hole_keep, unit  # noqa: E402
from pylib.noise import smoothstep  # noqa: E402


def _rebar_mats(L, W, T, spacing, dia, cover=0.035, edge=0.07):
    """Two mats (top, bottom): bars along x (dia[0]) then along y (dia[1]) inside them."""
    rx, ry = dia[0] / 2, dia[1] / 2
    ox = np.arange(-W / 2 + edge, W / 2 - 0.05, spacing[0])
    oy = np.arange(-L / 2 + edge + 0.03, L / 2 - 0.05, spacing[1])
    mats = []
    for sg in (1, -1):
        mats.append(('x', sg * (T / 2 - cover - rx), rx, ox))
        mats.append(('y', sg * (T / 2 - cover - 2 * rx - ry), ry, oy))
    return mats


def _anchor_cracks(rng, faces_info, count, severity, bbox, T, seed, around=None):
    """Cracks that start on a fracture line (or breach perimeter) and run inward, tapering to a tip."""
    cr = []
    tries = 0
    while len(cr) < count and tries < count * 12:
        tries += 1
        a, n = faces_info[rng.integers(len(faces_info))]
        u_axis = np.array([-n[1], n[0]])
        t = rng.uniform(-0.55, 0.55) * max(bbox[0], bbox[1])
        p = np.asarray(a) + u_axis * t
        if abs(p[0]) > bbox[0] - 0.12 or abs(p[1]) > bbox[1] - 0.12:
            continue
        ang = math.radians(rng.uniform(8, 38) * rng.choice([-1, 1]))
        d = -np.asarray(n)
        d = np.array([d[0] * math.cos(ang) - d[1] * math.sin(ang), d[0] * math.sin(ang) + d[1] * math.cos(ang)])
        length = rng.uniform(0.35, 1.0) * severity * min(bbox[0], bbox[1]) * 0.9
        w0 = rng.uniform(0.010, 0.026) * (0.6 + 0.4 * severity)
        depth = min(rng.uniform(0.55, 0.72) * T, T - 0.075)
        cr.append(Crack(p, d, length, w0, seed + 40 + len(cr), T, depth=depth, wander=0.02, dip_deg=float(rng.uniform(-6, 6))))
    return cr


def _edge_chips(rng, faces_info, count, severity, bbox, T, seed):
    chips = []
    for k in range(count):
        if k % 2 == 0 and faces_info:
            a, n = faces_info[rng.integers(len(faces_info))]
            u_axis = np.array([-n[1], n[0]])
            p = np.asarray(a) + u_axis * rng.uniform(-0.5, 0.5) * max(bbox[0], bbox[1]) - np.asarray(n) * rng.uniform(0.0, 0.07)
            z = rng.choice([-1, 1]) * T / 2
        else:   # a chipped cast arris
            side = rng.integers(4)
            if side < 2:
                p = np.array([rng.uniform(-0.8, 0.8) * bbox[0], (1 if side else -1) * bbox[1]])
            else:
                p = np.array([(1 if side == 2 else -1) * bbox[0], rng.uniform(-0.8, 0.8) * bbox[1]])
            z = rng.choice([-1, 1]) * T / 2
        r = rng.uniform(0.05, 0.13) * (0.6 + 0.5 * severity)
        chips.append(Chip((p[0], p[1], z), (r * rng.uniform(1.0, 1.7), r * rng.uniform(0.7, 1.1), r * 0.55), rng.uniform(0, 180), seed + 60 + k))
    chips = [c for c in chips if abs(c.c[0]) < bbox[0] + 0.05 and abs(c.c[1]) < bbox[1] + 0.05]
    return chips


def slab(name='slab', L=2.6, W=1.5, T=0.24, seed=1, fractures=None, cracks=5, severity=1.0, spall=4, rebar=True,
         rebar_spacing=(0.20, 0.25), rebar_dia=(0.020, 0.016), exposure=1.0, agg=1.0, drop_mm=0.0):
    """fractures: list of dicts(a=(x, y), angle=deg of the outward normal, dip=deg, ledge=(amp, z0, wander) or None, relief={...})."""
    rng = np.random.default_rng(seed)
    ext = (-max(L, W) * 1.1, max(L, W) * 1.1)
    faces, info = [], []
    for k, fr in enumerate(fractures or []):
        th = math.radians(fr['angle'])
        n = (math.cos(th), math.sin(th))
        faces.append(FractureFace(fr['a'], n, fr.get('dip', 0.0), seed + 10 + 5 * k, T, extent=ext, ledge=fr.get('ledge'), **fr.get('relief', {})))
        info.append((fr['a'], n))
    bbox = (L / 2, W / 2)
    crs = _anchor_cracks(rng, info, int(round(cracks)), severity, bbox, T, seed) if info and cracks else []
    chips = _edge_chips(rng, info, int(spall), severity, bbox, T, seed)
    half = (L / 2, W / 2, T / 2)
    drop_fn = None
    if drop_mm > 0 and crs:
        c1 = crs[0]

        def drop_fn(X, Y, Z):
            u, s = c1.coords(X, Y)
            fade = np.clip(1.0 - np.maximum(u, 0) / (c1.length * 1.05), 0, 1) * np.exp(-np.abs(s) / 0.55) * smoothstep(-0.02, 0.0, u)
            return drop_mm * 1e-3 * fade * smoothstep(-0.006, 0.006, s)

    cast = lambda X, Y, Z, drop: box_field(X, Y, Z, half, drop=drop)  # noqa: E731
    d = Design(name, half, cast, [f.keep for f in faces], crs, chips, drop_fn, seed, agg)
    if rebar:
        d.rebar = dict(extent=(L, W), mats=_rebar_mats(L, W, T, rebar_spacing, rebar_dia), exposure=exposure)
    return d


def wall(name='wall', L=3.4, W=2.4, T=0.26, seed=1, severity=1.0, breach=(-0.25, -0.05, 0.62, 0.55), n_planes=9, cracks=6, spall=5,
         rebar_spacing=(0.20, 0.22), rebar_dia=(0.018, 0.016), exposure=1.0, agg=1.0, plinth=(0.16, 0.10)):
    """A standing wall segment (length x, height y, thickness z) with a blast breach and a missing top corner.
    plinth=(height, extra thickness each side): a cast upstand at the base that keeps the original form legible."""
    rng = np.random.default_rng(seed)
    ext = (-max(L, W) * 1.1, max(L, W) * 1.1)
    cx, cy, ax, ay = breach
    holes = []
    info = []
    for k in range(n_planes):
        t = 2 * math.pi * (k + 0.5) / n_planes + rng.uniform(-0.2, 0.2)
        r = 1 + rng.uniform(-0.14, 0.18)
        a = np.array([cx + ax * math.cos(t) * r, cy + ay * math.sin(t) * r])
        n = unit(np.array([math.cos(t) / ax, math.sin(t) / ay]) + rng.normal(0, 0.18, 2))
        holes.append(FractureFace(a, n, float(rng.uniform(6, 24)), seed + 20 + k, T, extent=(-1.2, 1.2), a_warp=0.05, a_terrace=0.03, a_cells=0.013, a_ridge=0.014))
        info.append((a, n))
    # missing upper-right corner (stepped shear) and a ragged left edge
    th = math.radians(38)
    corner = FractureFace((L / 2 - 0.85, W / 2 - 0.1), (math.cos(th), math.sin(th)), -10.0, seed + 15, T, extent=ext, ledge=(0.045, 0.0, 0.03))
    th2 = math.radians(168)
    left = FractureFace((-L / 2 + 0.12, 0.0), (math.cos(th2), math.sin(th2)), 12.0, seed + 16, T, extent=ext, ledge=(-0.03, 0.02, 0.03), a_warp=0.06)
    faces_info = info + [((L / 2 - 0.85, W / 2 - 0.1), (math.cos(th), math.sin(th)))]
    crs = _anchor_cracks(rng, faces_info, cracks, severity, (L / 2, W / 2), T, seed)
    chips = _edge_chips(rng, faces_info[-1:], spall, severity, (L / 2, W / 2), T, seed)
    half = (L / 2, W / 2, T / 2 + plinth[1])
    ph, pe = plinth

    def cast(X, Y, Z, drop):
        w = box_field(X, Y, Z, (L / 2, W / 2, T / 2), edge_r=0.008)
        # base upstand: wider in z, only the bottom `ph` metres
        up = box_field(X, Y, Z, (L / 2, ph / 2, T / 2 + pe), centre=(0, -W / 2 + ph / 2, 0), edge_r=0.012)
        return np.maximum(w, up)

    breaks = [hole_keep(holes), corner.keep, left.keep]
    d = Design(name, half, cast, breaks, crs, chips, None, seed, agg)
    d.rebar = dict(extent=(L, W), mats=_wall_mats(L, W, T, rebar_spacing, rebar_dia), exposure=exposure)
    return d


def _wall_mats(L, W, T, spacing, dia, cover=0.04):
    # x bars run horizontally (offsets in y = height); y bars run vertically (offsets in x)
    return _rebar_mats(L, W, T, spacing, dia, cover=cover, edge=0.09)


# ---------------------------------------------------------------- chunks and rubble
def _unit_dirs(n, rng):
    i = np.arange(n) + 0.5
    phi = np.arccos(1 - 2 * i / n)
    th = math.pi * (1 + 5 ** 0.5) * i
    d = np.stack([np.cos(th) * np.sin(phi), np.sin(th) * np.sin(phi), np.cos(phi)], axis=1)
    d = d + rng.normal(0, 0.16, d.shape)
    return d / np.linalg.norm(d, axis=1, keepdims=True)


def _poly_planes(rng, centre, radii, n_planes, seed, relief, rot=None, shrink=(0.82, 1.0), half=0.9):
    """Tangent planes of a (rotated) ellipsoid, each with a rough fracture relief."""
    planes = []
    dirs = _unit_dirs(n_planes, rng)
    radii = np.asarray(radii)
    for k, nrm in enumerate(dirs):
        nl = nrm if rot is None else rot.T @ nrm        # normal in ellipsoid frame
        h = math.sqrt(float(np.sum((radii * nl) ** 2)))
        pt = np.asarray(centre) + nrm * h * rng.uniform(*shrink)
        planes.append(RoughPlane(pt, nrm, seed + 7 * k, half=half, **relief))
    return planes


def chunk(name, kind, seed, cast_faces=(), radii=(0.5, 0.4, 0.3), n_planes=11, bars=(), relief=None):
    """A polyhedral fragment: rough fracture planes around an ellipsoid, optionally cut from a cast block.

    cast_faces: list of (axis, sign, offset) cast planes (axis 0-2; solid is on the -sign side of offset)."""
    rng = np.random.default_rng(seed)
    relief = relief or dict(a_warp=0.016, a_terrace=0.009, a_cells=0.005, a_ridge=0.006, a_fine=0.0015, scale=0.8)
    rad = np.asarray(radii)
    planes = _poly_planes(rng, (0, 0, 0), rad, n_planes, seed + 100, relief, shrink=(0.62, 1.0), half=float(rad.max()) * 1.6)

    def keep(X, Y, Z):
        out = None
        for p in planes:
            v = p.keep(X, Y, Z)
            out = v if out is None else np.minimum(out, v)
        return out

    cf = list(cast_faces)

    def cast(X, Y, Z, drop):
        out = np.full(np.broadcast(X, Y, Z).shape, 1.0, dtype=np.float32)
        for axis, sign, off in cf:
            P = (X, Y, Z)[axis]
            out = np.minimum(out, (off - sign * P).astype(np.float32))
        return out

    half = rad * 1.18 + 0.02
    d = Design(name, half, cast, [keep], [], [], None, seed, 1.0)
    d.rebar = dict(bars=list(bars), chunk=True)
    return d


def rubble(name, seed, pieces=12, spread=0.55, big=(0.30, 0.38), small=(0.08, 0.20), bars=(), z_spread=0.22):
    """A loose cluster of fractured pieces (10-50 cm each) resting against one another."""
    rng = np.random.default_rng(seed)
    parts = []   # (centre, radius, planes)
    sizes = [rng.uniform(*big) for _ in range(2)] + [rng.uniform(*small) for _ in range(pieces - 2)]
    relief = dict(a_warp=0.010, a_terrace=0.006, a_cells=0.004, a_ridge=0.004, a_fine=0.0012, scale=0.4, res=0.006)
    for i, r in enumerate(sizes):
        for _ in range(60):
            if i == 0:
                c = np.zeros(3)
            else:
                j = rng.integers(len(parts))
                dirv = unit(rng.normal(0, 1, 3) * np.array([1, 1, 0.6]))
                c = parts[j][0] + dirv * (parts[j][1] + r) * rng.uniform(0.62, 0.85)
            c[2] = np.clip(c[2], -z_spread, z_spread)
            if np.linalg.norm(c[:2]) < spread * 1.35:
                break
        rad = np.array([r * rng.uniform(0.9, 1.3), r * rng.uniform(0.7, 1.0), r * rng.uniform(0.5, 0.9)])
        yaw, pitch = rng.uniform(0, 2 * math.pi), rng.uniform(-0.6, 0.6)
        cy_, sy_, cp, sp = math.cos(yaw), math.sin(yaw), math.cos(pitch), math.sin(pitch)
        rot = np.array([[cy_, -sy_, 0], [sy_, cy_, 0], [0, 0, 1]]) @ np.array([[cp, 0, sp], [0, 1, 0], [-sp, 0, cp]])
        # planes tangent to the rotated ellipsoid: normals in world; support in the ellipsoid frame
        planes = _poly_planes(rng, c, rad, 7 + int(r * 14), seed + 1000 + 31 * i, relief, rot=rot, shrink=(0.60, 1.0), half=float(rad.max()) * 1.5)
        parts.append((c, float(rad.max()) * 1.05, planes))
    allc = np.array([p[0] for p in parts])
    lo = (allc - np.array([[p[1]] for p in parts])).min(axis=0) - 0.05
    hi = (allc + np.array([[p[1]] for p in parts])).max(axis=0) + 0.05
    centre = (lo + hi) / 2
    half = (hi - lo) / 2

    def union(X, Y, Z):
        shape = np.broadcast(X, Y, Z).shape
        out = np.full(shape, -0.05, dtype=np.float32)
        xs, ys, zs = np.broadcast_to(X, shape)[:, 0, 0] + centre[0], np.broadcast_to(Y, shape)[0, :, 0] + centre[1], np.broadcast_to(Z, shape)[0, 0, :] + centre[2]
        for c, r, planes in parts:
            ix = np.flatnonzero(np.abs(xs - c[0]) < r * 1.4)
            iy = np.flatnonzero(np.abs(ys - c[1]) < r * 1.4)
            iz = np.flatnonzero(np.abs(zs - c[2]) < r * 1.4)
            if not (len(ix) and len(iy) and len(iz)):
                continue
            sl = np.ix_(ix, iy, iz)
            Xs, Ys, Zs = xs[ix][:, None, None], ys[iy][None, :, None], zs[iz][None, None, :]
            k = None
            for p in planes:
                v = p.keep(Xs, Ys, Zs)
                k = v if k is None else np.minimum(k, v)
            sub = out[sl]
            out[sl] = np.maximum(sub, np.maximum(k, -0.05).astype(np.float32))
        return out

    cast = lambda X, Y, Z, drop: np.full(np.broadcast(X, Y, Z).shape, 1.0, dtype=np.float32)  # noqa: E731
    d = Design(name, half, cast, [union], [], [], None, seed, 1.0)
    d.centre = centre
    d.rebar = dict(bars=list(bars), chunk=True)
    return d
