"""Signed-field building blocks for the concrete family (numpy only, no bpy).

Derived from assets-src/pilots/concrete_slab_premium.py. Convention: every `keep`/`inside` function
returns a field in metres that is POSITIVE inside the material. Designs combine them with min (intersection)
and max (union).
"""
import math
import os
import sys

import numpy as np

sys.path.insert(0, os.path.dirname(__file__))
from pylib.noise import bilinear, fbm, hash01, smoothstep, vnoise, worley2  # noqa: E402


def unit(v):
    v = np.asarray(v, dtype=np.float64)
    return v / np.linalg.norm(v)


# ---------------------------------------------------------------- fracture relief
def fracture_relief(u_min, u_max, v_min, v_max, res, seed, a_warp=0.11, a_terrace=0.05, a_cells=0.016, a_fine=0.004, a_ridge=0.020, scale=1.0):
    """Height (metres, along the fracture normal) over a param grid (u, v).

    Layers: low-frequency undulation, plateau terraces with sharp risers, angular cells (Voronoi cones
    with creased boundaries), ridged facets and fine grit. `scale` shrinks the spatial scales for small pieces."""
    us = np.arange(u_min, u_max, res)
    vs = np.arange(v_min, v_max, res)
    U0, V0 = np.meshgrid(us, vs, indexing='ij')
    U0, V0 = U0 / scale, V0 / scale
    ca, sa = math.cos(0.62), math.sin(0.62)
    U, V = U0 * ca - V0 * sa * 2.2, U0 * sa / 2.2 + V0 * ca
    warp = fbm(U / 0.5, V / 0.45, None, 3, seed=seed) * a_warp
    t = fbm(U / 0.22 + 5.0, V / 0.15, None, 3, seed=seed + 1)
    terrace = np.tanh(t * 3.6) * a_terrace
    f1, f2, cid, _, _ = worley2(U / 0.075, V / 0.075, seed + 2)
    cells = (0.42 - f1) * a_cells * 2.0 * (0.6 + 0.8 * cid)
    crease = -(1.0 - smoothstep(0.0, 0.06, f2 - f1)) * a_cells * 1.15
    ridged = (1.0 - np.abs(fbm(U / 0.14 + 9.0, V / 0.10, None, 3, seed=seed + 4))) ** 3 * a_ridge
    fine = fbm(U / 0.014, V / 0.014, None, 3, seed=seed + 3) * a_fine
    return (warp + terrace + cells + crease + ridged + fine).astype(np.float32), u_min, v_min, res


def sample_relief(rel, u, v):
    grid, u_min, v_min, res = rel
    return bilinear(grid, (u - u_min) / res, (v - v_min) / res)


class FractureFace:
    """A rough plane with a horizontal normal n, dipping through the thickness (z).

    keep() is positive on the solid side of the break-away face."""

    def __init__(self, a, n, dip_deg, seed, thick, extent=(-1.2, 1.2), ledge=None, res=0.003, **relief_kw):
        self.a = np.asarray(a, dtype=np.float64)
        self.n = unit(n)
        self.u_axis = np.array([-self.n[1], self.n[0]])
        self.tan = math.tan(math.radians(dip_deg))
        self.ledge = ledge  # (amplitude m, z0, wander): a horizontal shear step in the face
        self.seed = seed
        self.rel = fracture_relief(extent[0], extent[1], -thick / 2 - 0.05, thick / 2 + 0.05, res, seed, **relief_kw)

    def offset_from(self, X, Y, Z):
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

    def keep(self, X, Y, Z):
        return -self.offset_from(X, Y, Z)


def hole_keep(faces):
    """Keep-field of a through-opening bounded by outward-facing FractureFace planes."""
    def f(X, Y, Z):
        body = None
        for face in faces:
            d = face.offset_from(X, Y, Z)
            body = d if body is None else np.maximum(body, d)
        return body
    return f


class RoughPlane:
    """A fully 3D rough plane for chunk polyhedra. keep() positive on the solid (back) side."""

    def __init__(self, a, n, seed, half=0.7, res=0.005, **relief_kw):
        self.a = np.asarray(a, dtype=np.float64)
        self.n = unit(n)
        ref = np.array([0, 0, 1.0]) if abs(self.n[2]) < 0.9 else np.array([1.0, 0, 0])
        self.t1 = unit(np.cross(self.n, ref))
        self.t2 = np.cross(self.n, self.t1)
        self.rel = fracture_relief(-half, half, -half, half, res, seed, **relief_kw)

    def keep(self, X, Y, Z):
        dx, dy, dz = X - self.a[0], Y - self.a[1], Z - self.a[2]
        s = self.n[0] * dx + self.n[1] * dy + self.n[2] * dz
        u = self.t1[0] * dx + self.t1[1] * dy + self.t1[2] * dz
        v = self.t2[0] * dx + self.t2[1] * dy + self.t2[2] * dz
        shape = np.broadcast(s, u, v).shape
        u, v, s = np.broadcast_to(u, shape), np.broadcast_to(v, shape), np.broadcast_to(s, shape)
        return sample_relief(self.rel, u, v) - s


class Crack:
    """A tapering crack from the +z face: a noisy sheet of finite length, width and depth, with a flaking lip."""

    def __init__(self, a, direction, length, w0, seed, thick, depth=0.15, wander=0.02, dip_deg=0.0, lip_w=0.05, lip_depth=0.016):
        self.a = np.asarray(a, dtype=np.float64)
        self.d = unit(direction)
        self.nrm = np.array([-self.d[1], self.d[0]])
        self.length, self.w0, self.depth, self.wander, self.seed = length, w0, depth, wander, seed
        self.T = thick
        self.tan = math.tan(math.radians(dip_deg))
        self.lip_w, self.lip_depth = lip_w, lip_depth

    def coords(self, X, Y):
        dx, dy = X - self.a[0], Y - self.a[1]
        return self.d[0] * dx + self.d[1] * dy, self.nrm[0] * dx + self.nrm[1] * dy

    def inside(self, X, Y, Z):
        T = self.T
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
        zb = T / 2 - self.depth + fbm(u / 0.2, 0 * u, None, 2, seed=self.seed + 9) * 0.03
        void = np.minimum(np.minimum(side, ends), (z - zb) * 0.8)
        a_ = np.abs(s - o)
        wl = self.lip_w * (0.35 + 0.9 * vnoise(u / 0.09 + 11.0, 0 * u, None, self.seed + 21)) * smoothstep(0.0, 0.08, u) * (1.0 - 0.7 * t)
        dl = self.lip_depth * (0.4 + 1.0 * vnoise(u / 0.07 + 5.0, a_ / 0.03, None, self.seed + 22))
        frac = np.clip(a_ / np.maximum(wl, 1e-4), 0.0, 1.0)
        lip = ((z - (T / 2 - dl * (1.0 - frac) ** 0.8)) * 0.8) * (frac < 1.0) - 0.05 * (frac >= 1.0)
        out[near] = np.maximum(np.maximum(void, lip), -0.05)
        return out


class Chip:
    """An angular conchoidal spall: a noisy super-ellipsoid removed from the solid (centre it on an arris)."""

    def __init__(self, c, radii, yaw_deg, seed, amp=0.006, p=1.7):
        self.c = np.asarray(c, dtype=np.float64)
        self.r = np.asarray(radii, dtype=np.float64)
        self.cy, self.sy = math.cos(math.radians(yaw_deg)), math.sin(math.radians(yaw_deg))
        self.seed, self.amp, self.p = seed, amp, p

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
        p = self.p
        q = (np.abs(xr / self.r[0]) ** p + np.abs(yr / self.r[1]) ** p + np.abs(z / self.r[2]) ** p) ** (1.0 / p)
        n = fbm(x / 0.05 + 1.3, y / 0.05, z / 0.05, 3, seed=self.seed)
        out[near] = np.maximum((1.0 - q) * float(self.r.min()) + n * self.amp, -0.05)
        return out


def box_field(X, Y, Z, half, centre=(0, 0, 0), edge_r=0.007, drop=0.0):
    """Rounded-arris box, positive inside. `drop` shifts z for the dropped block."""
    qx = np.abs(X - centre[0]) - (half[0] - edge_r)
    qy = np.abs(Y - centre[1]) - (half[1] - edge_r)
    qz = np.abs(Z - centre[2] + drop) - (half[2] - edge_r)
    ox, oy, oz = np.maximum(qx, 0), np.maximum(qy, 0), np.maximum(qz, 0)
    outside = np.sqrt(ox * ox + oy * oy + oz * oz)
    inside = np.minimum(np.maximum(np.maximum(qx, qy), qz), 0)
    return -(outside + inside - edge_r)


# ---------------------------------------------------------------- aggregate / filter
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
                best = np.maximum(best, np.where(present, r - dist, -1.0))
    return best


def add_aggregate(f, f_cast, f_break, origin, cell, seed, agg=1.0, grit=0.0022):
    """Roughen every fracture surface with grit and protruding aggregate stones in a thin band."""
    band = (np.abs(f) < 0.014) & (f_break < f_cast - 0.0005)
    idx = np.argwhere(band)
    P = origin + idx * cell
    fv = f[band].astype(np.float64)
    g = fbm(P[:, 0] / 0.02, P[:, 1] / 0.02, P[:, 2] / 0.02, 3, seed=seed) * grit
    stone = stone_field(P, seed + 100, cell=0.032 * agg, rmin=0.0075 * agg, rmax=0.0155 * agg)
    fv = fv + g
    f[band] = np.maximum(fv - 0.0016, np.minimum(stone, fv + 0.0060)).astype(np.float32)
    return int(band.sum())


def lowpass(f, w=0.07):
    """Light 7-point blur: removes sub-voxel slivers without softening creases."""
    out = f * (1 - 6 * w)
    for ax in range(3):
        out += w * (np.roll(f, 1, axis=ax) + np.roll(f, -1, axis=ax))
    out[0], out[-1], out[:, 0], out[:, -1], out[:, :, 0], out[:, :, -1] = f[0], f[-1], f[:, 0], f[:, -1], f[:, :, 0], f[:, :, -1]
    return out


# ---------------------------------------------------------------- the design container + evaluation
class Design:
    """Everything the pipeline needs: a cast shape, break-away carvers, cracks, chips, rebar layout."""

    def __init__(self, name, half, cast, breaks, cracks=(), chips=(), drop_fn=None, seed=1, agg=1.0, rebar=None, tint=1.0):
        self.name, self.half, self.cast = name, np.asarray(half, dtype=np.float64), cast
        self.breaks, self.cracks, self.chips = list(breaks), list(cracks), list(chips)
        self.drop_fn, self.seed, self.agg, self.rebar = drop_fn, seed, agg, rebar
        self.tint = tint


def evaluate(d, cell, pad=0.045, step=48):
    nx, ny, nz = [int(round((2 * h + 2 * pad) / cell)) + 1 for h in d.half]
    origin = -d.half - pad
    xs = (origin[0] + np.arange(nx) * cell).astype(np.float32)
    ys = (origin[1] + np.arange(ny) * cell).astype(np.float32)
    zs = (origin[2] + np.arange(nz) * cell).astype(np.float32)
    f_cast = np.empty((nx, ny, nz), dtype=np.float32)
    f_nc = np.empty((nx, ny, nz), dtype=np.float32)    # cast + fractures, no cracks or chips
    f_break = np.empty((nx, ny, nz), dtype=np.float32)  # everything that carves
    for i0 in range(0, nx, step):
        i1 = min(nx, i0 + step)
        X, Y, Z = xs[i0:i1][:, None, None], ys[None, :, None], zs[None, None, :]
        drop = d.drop_fn(X, Y, Z) if d.drop_fn else 0.0
        fc = d.cast(X, Y, Z, drop)
        f_cast[i0:i1] = fc
        fb = None
        for brk in d.breaks:
            v = brk(X, Y, Z)
            fb = v if fb is None else np.minimum(fb, v)
        if fb is None:
            fb = np.full(fc.shape, 1.0, dtype=np.float32)
        f_nc[i0:i1] = np.minimum(fc, fb)
        for cr in d.cracks:
            fb = np.minimum(fb, -cr.inside(X, Y, Z))
        for ch in d.chips:
            fb = np.minimum(fb, -ch.inside(X, Y, Z))
        f_break[i0:i1] = fb
    return f_cast, f_nc, f_break, origin
