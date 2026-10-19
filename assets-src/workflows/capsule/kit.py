"""Hard-surface capsule kit v2 (numpy core, Blender only for triangulation helpers and export).

Design language (Design/Object Designs, Abigail Callaghan transport capsule board):
 * a wide, low, heavy crew module: a broad spherical-cap heat shield that rolls over a large toroidal shoulder,
   a thick ablator lip, then a convex truncated-cone backshell and a small flat deck with a docking tunnel;
 * Overall ~3.9 m across the heat shield and ~2.8 m tall (deck 2.59 m, tunnel 2.78 m);
 * all shell sheets live in one (theta, s) parameter space (s = arc length along the meridian), meshed through a
   conformal planar map with adaptive constrained Delaunay triangulation so detail goes where the damage is.
Nothing here uses an unseeded random generator.
"""
import math
import os
import struct
import sys
import zlib

import numpy as np

HERE = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, os.path.join(HERE, '..', '..', 'pilots'))
from pylib.noise import fbm, vnoise, smoothstep, hash01, worley2  # noqa: E402,F401
from pylib.meshutil import vertex_normals  # noqa: E402,F401
from pylib.sheets import grid_mesh  # noqa: E402,F401

TAU = 2 * math.pi
SEED = 20261018

# ----------------------------------------------------------------------------------- profile
RS, R1, RT = 4.6, 1.56, 0.60          # heat-shield sphere radius, cap edge radius, shoulder torus radius
PHI_END = math.radians(18.0)          # heat shield ends 25 deg past its equator (turning in)
T_ABL = 0.060                          # ablator thickness at the lip
LEDGE = 0.034                          # backshell starts this far inside the ablator outer face
Z_DECK = 2.59
R_DECK = 0.771


def _profile():
    pts, tan, piece = [], [], []
    a1 = math.asin(R1 / RS)
    for a in np.linspace(0, a1, 90)[:-1]:
        pts.append((RS * math.sin(a), RS * (1 - math.cos(a)))); tan.append((math.cos(a), math.sin(a))); piece.append(0)
    C = np.array([R1 - RT * math.sin(a1), RS * (1 - math.cos(a1)) + RT * math.cos(a1)])
    for b in np.linspace(a1, math.pi / 2 + PHI_END, 80):
        pts.append(tuple(C + RT * np.array([math.sin(b), -math.cos(b)]))); tan.append((math.cos(b), math.sin(b))); piece.append(0)
    E = np.array(pts[-1])
    n_e = np.array([math.sin(math.pi / 2 + PHI_END), -math.cos(math.pi / 2 + PHI_END)])
    B0 = E - n_e * LEDGE
    # ledge (never meshed by surf(); the ablator rim covers it)
    pts.append(tuple(B0)); tan.append(tuple(np.array(tan[-1]))); piece.append(1)
    # backshell: quadratic Bezier, start 25 deg from vertical, end 42 deg
    d0 = np.array([-math.sin(PHI_END), math.cos(PHI_END)])
    P2 = np.array([0.90, 2.53])
    d2 = np.array([-math.sin(math.radians(48)), math.cos(math.radians(48))])
    A = np.array([d0, d2]).T
    ab = np.linalg.solve(A, P2 - B0)
    Pc = B0 + ab[0] * d0
    for t in np.linspace(0, 1, 160)[1:]:
        p = (1 - t) ** 2 * B0 + 2 * (1 - t) * t * Pc + t * t * P2
        d = 2 * (1 - t) * (Pc - B0) + 2 * t * (P2 - Pc)
        pts.append(tuple(p)); tan.append(tuple(d / np.linalg.norm(d))); piece.append(2)
    rf = 0.14
    Cf = P2 + rf * np.array([-math.cos(math.radians(48)), -math.sin(math.radians(48))])
    for g in np.linspace(math.radians(48), math.pi / 2, 24)[1:]:
        pts.append(tuple(Cf + rf * np.array([math.cos(g), math.sin(g)]))); tan.append((-math.sin(g), math.cos(g))); piece.append(2)
    P = np.array(pts)
    seg = np.hypot(*np.diff(P, axis=0).T)
    S = np.concatenate([[0], np.cumsum(seg)])
    return S, P[:, 0], P[:, 1], np.array(tan), np.array(piece)


PS, PR, PZ, PT, PPIECE = _profile()
S_E = float(PS[np.argmax(PPIECE == 1) - 1])     # end of heat shield (outer lip)
S_B0 = float(PS[np.argmax(PPIECE == 1)])        # start of backshell
STOT = float(PS[-1])                            # deck edge
S_HS = S_E
Z_DECK = float(PZ[-1])
R_DECK = float(PR[-1])
R_MAX = float(PR.max())
S_EQ = float(PS[int(np.argmax(PR))])


def r_of(s):
    return np.interp(s, PS, PR)


def z_of(s):
    return np.interp(s, PS, PZ)


def tangent(s):
    return np.interp(s, PS, PT[:, 0]), np.interp(s, PS, PT[:, 1])


def surf(theta, s, off=0.0):
    """Revolved outer surface point (optionally offset along the outward normal)."""
    theta, s = np.asarray(theta, float), np.asarray(s, float)
    r, z = r_of(s), z_of(s)
    dr, dz = tangent(s)
    nr, nz = dz, -dr
    c, sn = np.cos(theta), np.sin(theta)
    return np.stack([(r + nr * off) * c, (r + nr * off) * sn, z + nz * off], axis=-1)


def surf_frame(theta, s):
    """Position, outward normal, unit tangent along theta, unit tangent along s."""
    theta, s = np.asarray(theta, float), np.asarray(s, float)
    P = surf(theta, s)
    dr, dz = tangent(s)
    c, sn = np.cos(theta), np.sin(theta)
    n = np.stack([dz * c, dz * sn, -dr], axis=-1)
    ts = np.stack([dr * c, dr * sn, dz], axis=-1)
    tt = np.stack([-sn, c, 0 * c], axis=-1)
    return P, n, tt, ts


def wrap_angle(d):
    return (np.asarray(d) + math.pi) % TAU - math.pi


def s_at_z(z):
    """Backshell station at height z."""
    i0 = int(np.argmax(PPIECE == 2))
    return float(np.interp(z, PZ[i0:], PS[i0:]))


# ----------------------------------------------------------------------------------- conformal planar maps
def _conformal(s_lo, s_hi, pole=False):
    m = (PS >= s_lo - 1e-9) & (PS <= s_hi + 1e-9)
    s = PS[m]
    r = PR[m]
    if pole:
        integ = np.where(s > 1e-6, 1.0 / np.maximum(r, 1e-9) - 1.0 / np.maximum(s, 1e-9), 0.0)
        F = np.concatenate([[0], np.cumsum(0.5 * (integ[1:] + integ[:-1]) * np.diff(s))])
        rho = np.where(s > 0, s * np.exp(F), 0.0)
    else:
        integ = 1.0 / r
        F = np.concatenate([[0], np.cumsum(0.5 * (integ[1:] + integ[:-1]) * np.diff(s))])
        rho = np.exp(F)
    S2 = np.linspace(s_lo, s_hi, 4000)
    R2 = np.interp(S2, s, rho)
    return S2, R2


class PlanarMap:
    """(theta, s) <-> plane (X, Y) = rho(s) (cos theta, sin theta); locally isotropic (conformal)."""

    def __init__(self, s_lo, s_hi, pole=False):
        self.s_lo, self.s_hi = s_lo, s_hi
        self.S, self.R = _conformal(s_lo, s_hi, pole)

    def rho(self, s):
        return np.interp(s, self.S, self.R)

    def s_of(self, rho):
        return np.interp(rho, self.R, self.S)

    def to_plane(self, th, s):
        rr = self.rho(s)
        return np.stack([rr * np.cos(th), rr * np.sin(th)], -1)

    def from_plane(self, XY):
        rr = np.hypot(XY[:, 0], XY[:, 1])
        return np.mod(np.arctan2(XY[:, 1], XY[:, 0]), TAU), self.s_of(rr)

    def scale(self, s):
        """plane length per surface metre"""
        return self.rho(s) / np.maximum(r_of(s), 1e-6)


def adaptive_sheet(pm, h_fn, h_max, extra_loops=()):
    """Adaptive triangulation of the band s in [pm.s_lo, pm.s_hi].

    h_fn(theta, s) -> desired edge length (m). Returns (theta, s, tris)."""
    from mathutils import geometry
    r_in, r_out = pm.rho(pm.s_lo), pm.rho(pm.s_hi)
    pts = []
    # boundary circles
    loops = []
    for s_b in ((pm.s_lo,) if pm.s_lo > 1e-6 else ()) + (pm.s_hi,):
        n = max(24, int(math.ceil(TAU * float(r_of(s_b)) / max(0.004, float(np.min(h_fn(np.linspace(0, TAU, 720), np.full(720, s_b))))))))
        th = np.linspace(0, TAU, n, endpoint=False)
        loops.append(pm.to_plane(th, np.full(n, s_b)))
    # quadtree
    cells = [np.array([[0.0, 0.0]]), ]
    half = r_out * 1.001
    centres = np.array([[0.0, 0.0]])
    size = 2 * half
    leaves = []
    while len(centres):
        th, s = pm.from_plane(centres)
        hp = h_fn(th, s) * pm.scale(s)
        rr = np.hypot(centres[:, 0], centres[:, 1])
        diag = size * 0.7072
        inside = (rr - diag < r_out) & (rr + diag > r_in)
        centres = centres[inside]
        hp = hp[inside]
        split = hp * 1.4 < size
        if size < 1e-3:
            split[:] = False
        leaves.append((centres[~split], size))
        q = size / 4
        c = centres[split]
        centres = np.concatenate([c + [-q, -q], c + [q, -q], c + [-q, q], c + [q, q]]) if len(c) else np.zeros((0, 2))
        size /= 2
    P = []
    for c, sz in leaves:
        if len(c) == 0:
            continue
        h2 = sz / 2
        P += [c + [-h2, -h2], c + [h2, -h2], c + [-h2, h2], c + [h2, h2]]
    P = np.concatenate(P)
    P = np.unique(np.round(P, 7), axis=0)
    rr = np.hypot(P[:, 0], P[:, 1])
    th, s = pm.from_plane(P)
    hp = np.minimum(h_fn(th, s), h_max) * pm.scale(s)
    keep = (rr > r_in + 0.45 * hp) & (rr < r_out - 0.45 * hp)
    P = P[keep]
    for lp in loops:
        P = np.concatenate([P, lp])
    for lp in extra_loops:
        P = np.concatenate([P, lp])
    edges = []
    off = len(P) - sum(len(l) for l in loops) - sum(len(l) for l in extra_loops)
    for lp in list(loops) + list(extra_loops):
        n = len(lp)
        edges += [(off + i, off + (i + 1) % n) for i in range(n)]
        off += n
    from mathutils import Vector
    vco = [Vector((float(x), float(y))) for x, y in P]
    out = geometry.delaunay_2d_cdt(vco, edges, [], 0, 1e-7)
    V = np.array([tuple(v) for v in out[0]])
    F = [f for f in out[2] if len(f) == 3]
    T = np.array(F, np.int64)
    cen = V[T].mean(1)
    rc = np.hypot(cen[:, 0], cen[:, 1])
    T = T[(rc > r_in) & (rc < r_out)]
    # orient CCW in the plane
    a, b, c = V[T[:, 0]], V[T[:, 1]], V[T[:, 2]]
    cr = (b[:, 0] - a[:, 0]) * (c[:, 1] - a[:, 1]) - (b[:, 1] - a[:, 1]) * (c[:, 0] - a[:, 0])
    T[cr < 0] = T[cr < 0][:, ::-1]
    used = np.unique(T)
    remap = -np.ones(len(V), np.int64)
    remap[used] = np.arange(len(used))
    V = V[used]
    T = remap[T]
    th, s = pm.from_plane(V)
    s = np.clip(s, pm.s_lo, pm.s_hi)
    return th, s, T


# ----------------------------------------------------------------------------------- mesh container
class Mesh:
    """Triangle soup with per-corner UV and a material name per triangle."""

    def __init__(self, P, T, UV, mat):
        self.P = np.asarray(P, np.float64)
        self.T = np.asarray(T, np.int64).reshape(-1, 3)
        self.UV = np.asarray(UV, np.float32).reshape(-1, 3, 2)
        self.mat = np.asarray(mat, dtype=object) if isinstance(mat, (list, np.ndarray)) else np.array([mat] * len(self.T), dtype=object)

    @staticmethod
    def concat(ms):
        ms = [m for m in ms if m is not None and len(m.T)]
        off, P, T, UV, M = 0, [], [], [], []
        for m in ms:
            P.append(m.P); T.append(m.T + off); UV.append(m.UV); M.append(m.mat)
            off += len(m.P)
        return Mesh(np.concatenate(P), np.concatenate(T), np.concatenate(UV), np.concatenate(M))

    def transformed(self, R=None, t=None, scale=1.0):
        P = self.P.astype(np.float64) * scale
        if R is not None:
            P = P @ np.asarray(R).T
            if np.linalg.det(np.asarray(R)) < 0:
                return Mesh(P + (0 if t is None else np.asarray(t)), self.T[:, ::-1], self.UV[:, ::-1], self.mat)
        if t is not None:
            P = P + np.asarray(t)
        return Mesh(P, self.T, self.UV, self.mat)

    def remat(self, old, new):
        m = self.mat.copy()
        m[m == old] = new
        return Mesh(self.P, self.T, self.UV, m)

    def setmat(self, new):
        return Mesh(self.P, self.T, self.UV, np.array([new] * len(self.T), dtype=object))

    @property
    def ntri(self):
        return len(self.T)


def rot(axis, ang):
    a = np.asarray(axis, float)
    a = a / np.linalg.norm(a)
    x, y, z = a
    c, s = math.cos(ang), math.sin(ang)
    C = 1 - c
    return np.array([[c + x * x * C, x * y * C - z * s, x * z * C + y * s], [y * x * C + z * s, c + y * y * C, y * z * C - x * s], [z * x * C - y * s, z * y * C + x * s, c + z * z * C]])


def frame_from_normal(n, ref=None):
    """Columns (x, y, n): a right-handed frame whose z column is n."""
    n = np.asarray(n, float)
    n = n / np.linalg.norm(n)
    if ref is None:
        ref = np.array([0, 0, 1.0]) if abs(n[2]) < 0.9 else np.array([1.0, 0, 0])
    x = np.cross(ref, n)
    x /= np.linalg.norm(x)
    y = np.cross(n, x)
    return np.stack([x, y, n], 1)


def surface_basis(th, s):
    """Rotation whose columns are (tangent theta, tangent s, outward normal) at (th, s)."""
    P, n, tt, ts = surf_frame(th, s)
    return P, np.stack([tt, ts, n], 1)


def box_uv_corners(P, T, tile=0.25):
    """Per-corner box-projected UVs (1 uv unit = tile metres) from the dominant normal axis."""
    P = np.asarray(P, np.float64)
    n = np.cross(P[T[:, 1]] - P[T[:, 0]], P[T[:, 2]] - P[T[:, 0]])
    ax = np.argmax(np.abs(n), axis=1)
    sg = np.where(np.take_along_axis(n, ax[:, None], axis=1)[:, 0] >= 0, 1.0, -1.0)
    Q = P[T]
    uv = np.empty((len(T), 3, 2), np.float32)
    for a, (ua, va) in enumerate([(1, 2), (0, 2), (0, 1)]):
        m = ax == a
        flip = np.array([1.0, -1.0, 1.0])[a]
        uv[m, :, 0] = Q[m][:, :, ua] * sg[m][:, None] * flip / tile
        uv[m, :, 1] = Q[m][:, :, va] / tile
    return uv


def solid(P, T, mat, tile=0.25, uv=None):
    P = np.asarray(P, np.float64)
    T = np.asarray(T, np.int64)
    return Mesh(P, T, box_uv_corners(P, T, tile) if uv is None else uv, mat)


def clean_tris(P, T, min_area=1e-10):
    a = np.cross(P[T[:, 1]] - P[T[:, 0]], P[T[:, 2]] - P[T[:, 0]])
    ok = np.linalg.norm(a, axis=1) > min_area * 2
    ok &= (T[:, 0] != T[:, 1]) & (T[:, 1] != T[:, 2]) & (T[:, 0] != T[:, 2])
    return T[ok], ok


# ----------------------------------------------------------------------------------- sheets with thickness
def thicken(P, T, thick, mats=('outer', 'inner', 'rim'), uv_outer=None, rim_tile=0.10, inner_keep=None, nrm=None,
            inner_tile=0.3, rim_uv='box'):
    """Give a sheet real thickness along its vertex normals (inward).

    uv_outer: per-corner (T,3,2) uvs of the outer face (else box projected).  inner_keep: bool per triangle,
    drops hidden back faces.  Rim faces are box projected."""
    P = np.asarray(P, np.float64)
    T = np.asarray(T, np.int64)
    T, ok = clean_tris(P, T)
    if uv_outer is not None:
        uv_outer = np.asarray(uv_outer)[ok]
    if inner_keep is not None:
        inner_keep = np.asarray(inner_keep)[ok]
    N = len(P)
    if nrm is None:
        nrm = vertex_normals(P.astype(np.float64), T)
    th = np.broadcast_to(np.asarray(thick, float), (N,))
    Pin = P - nrm * th[:, None]
    verts = np.concatenate([P, Pin])
    e = np.concatenate([T[:, [0, 1]], T[:, [1, 2]], T[:, [2, 0]]])
    key = np.minimum(e[:, 0], e[:, 1]) * N + np.maximum(e[:, 0], e[:, 1])
    uniq, inv, cnt = np.unique(key, return_inverse=True, return_counts=True)
    bnd = e[cnt[inv.ravel()] == 1]
    a, b = bnd[:, 0], bnd[:, 1]
    rim_t = np.concatenate([np.stack([a, b + N, b], 1), np.stack([a, a + N, b + N], 1)])
    Tin = T[:, ::-1] + N
    if inner_keep is not None:
        Tin = Tin[inner_keep]
    tris = np.concatenate([T, Tin, rim_t])
    mid = np.concatenate([np.zeros(len(T), int), np.ones(len(Tin), int), np.full(len(rim_t), 2)])
    matname = np.array(mats, dtype=object)[mid]
    uo = uv_outer if uv_outer is not None else box_uv_corners(verts, T, inner_tile)
    ui = box_uv_corners(verts, Tin, inner_tile)
    # rim: u along the edge (arc length), v across the thickness
    if rim_uv == 'edge':
        L = np.linalg.norm(P[b] - P[a], axis=1)
        u0 = np.cumsum(np.concatenate([[0], L[:-1]])) / rim_tile
        u1 = u0 + L / rim_tile
        tv = th[a] / rim_tile
        ur = np.concatenate([np.stack([np.stack([u0, 0 * u0], 1), np.stack([u1, tv], 1), np.stack([u1, 0 * u0], 1)], 1),
                             np.stack([np.stack([u0, 0 * u0], 1), np.stack([u0, tv], 1), np.stack([u1, tv], 1)], 1)])
    else:
        ur = box_uv_corners(verts, rim_t, rim_tile)
    UV = np.concatenate([uo, ui, ur]).astype(np.float32)
    return Mesh(verts, tris, UV, matname)


# ----------------------------------------------------------------------------------- primitives
def box(center, size, bevel=0.0, rotation=None, mat='gunmetal', tile=0.3, seg=2):
    import bmesh
    bm = bmesh.new()
    bmesh.ops.create_cube(bm, size=1.0)
    for v in bm.verts:
        v.co.x *= size[0]; v.co.y *= size[1]; v.co.z *= size[2]
    if bevel and bevel > 0:
        bmesh.ops.bevel(bm, geom=bm.verts[:] + bm.edges[:] + bm.faces[:], offset=min(bevel, min(size) * 0.45), segments=seg, affect='EDGES', profile=0.5)
    bmesh.ops.triangulate(bm, faces=bm.faces[:])
    bm.verts.ensure_lookup_table()
    P = np.array([v.co[:] for v in bm.verts], np.float64)
    T = np.array([[v.index for v in f.verts] for f in bm.faces], np.int64)
    bm.free()
    if rotation is not None:
        P = P @ np.asarray(rotation).T
    P = P + np.asarray(center)
    return solid(P, T, mat, tile)


def lathe(profile, n=48, a0=0.0, a1=TAU, mat='gunmetal', tile=0.3, frame=None, origin=None, uv_mode='box'):
    """Revolve an (r, z) polyline about local z; profile order sets the winding (outside to the right = outward).
    Optional frame (3x3 columns) / origin place it in world space."""
    prof = np.asarray(profile, float)
    full = abs((a1 - a0) - TAU) < 1e-9
    ang = np.linspace(a0, a1, n + 1)
    m = len(prof)
    P = np.stack([prof[None, :, 0] * np.cos(ang)[:, None], prof[None, :, 0] * np.sin(ang)[:, None], np.broadcast_to(prof[None, :, 1], (n + 1, m))], axis=-1).reshape(-1, 3)
    idx = np.arange((n + 1) * m).reshape(n + 1, m)
    a, b, c, d = idx[:-1, :-1].ravel(), idx[1:, :-1].ravel(), idx[1:, 1:].ravel(), idx[:-1, 1:].ravel()
    T = np.concatenate([np.stack([a, b, c], 1), np.stack([a, c, d], 1)])
    uv = None
    if uv_mode == 'cyl':
        L = np.concatenate([[0], np.cumsum(np.hypot(*np.diff(prof, axis=0).T))])
        rmax = max(prof[:, 0].max(), 1e-3)
        UVv = np.stack([np.repeat(ang, m) * rmax / tile, np.tile(L, n + 1) / tile], 1)
        uv = UVv[T]
    T, ok = clean_tris(P, T)
    if uv is not None:
        uv = uv[ok]
    if frame is not None:
        P = P @ np.asarray(frame).T
    if origin is not None:
        P = P + np.asarray(origin)
    return solid(P, T, mat, tile, uv)


def sweep(path, radius, n=8, mat='cable_black', tile=0.2, cap=True, profile=None, twist=0.0):
    """Tube along a polyline path (K,3); radius scalar or per-point; optional custom 2D profile (n,2)."""
    path = np.asarray(path, float)
    K = len(path)
    rad = np.broadcast_to(np.asarray(radius, float), (K,))
    tan = np.gradient(path, axis=0)
    tan /= np.linalg.norm(tan, axis=1, keepdims=True) + 1e-12
    ref = np.array([0, 0, 1.0]) if abs(tan[0, 2]) < 0.9 else np.array([1.0, 0, 0])
    u = np.cross(tan[0], ref); u /= np.linalg.norm(u)
    if profile is None:
        a = np.linspace(0, TAU, n, endpoint=False)
        prof = np.stack([np.cos(a), np.sin(a)], 1)
    else:
        prof = np.asarray(profile, float)
        n = len(prof)
    rings = []
    Ls = np.concatenate([[0], np.cumsum(np.linalg.norm(np.diff(path, axis=0), axis=1))])
    for k in range(K):
        v = np.cross(tan[k], u); v /= np.linalg.norm(v) + 1e-12
        u = np.cross(v, tan[k]); u /= np.linalg.norm(u) + 1e-12
        ca, sa = math.cos(twist * k), math.sin(twist * k)
        uu, vv = ca * u + sa * v, -sa * u + ca * v
        rings.append(path[k] + rad[k] * (prof[:, :1] * uu + prof[:, 1:] * vv))
    P = np.concatenate(rings)
    T = []
    UV = []
    for k in range(K - 1):
        for j in range(n):
            j2 = (j + 1) % n
            a, b = k * n + j, k * n + j2
            T += [(a, b, b + n), (a, b + n, a + n)]
            u0, u1 = j / n, (j + 1) / n
            v0, v1 = Ls[k] / tile, Ls[k + 1] / tile
            UV += [[(u0, v0), (u1, v0), (u1, v1)], [(u0, v0), (u1, v1), (u0, v1)]]
    if cap:
        for k, flip in ((0, True), (K - 1, False)):
            c = len(P)
            P = np.concatenate([P, path[k][None]])
            for j in range(n):
                a, b = k * n + j, k * n + (j + 1) % n
                T.append((c, b, a) if flip else (c, a, b))
                UV.append([(0.5, 0.5), (0.5 + prof[j, 0] * 0.1, 0.5 + prof[j, 1] * 0.1), (0.5, 0.6)])
    return Mesh(P, np.asarray(T), np.asarray(UV, np.float32), mat)


def cylinder(p0, p1, r, n=16, mat='gunmetal', r1=None, tile=0.3, caps=True):
    p0, p1 = np.asarray(p0, float), np.asarray(p1, float)
    ax = p1 - p0
    ax = ax / np.linalg.norm(ax)
    ref = np.array([0, 0, 1.0]) if abs(ax[2]) < 0.9 else np.array([1.0, 0, 0])
    u = np.cross(ax, ref); u /= np.linalg.norm(u)
    v = np.cross(ax, u)
    a = np.linspace(0, TAU, n, endpoint=False)
    c, s = np.cos(a)[:, None], np.sin(a)[:, None]
    r1 = r if r1 is None else r1
    P = np.concatenate([p0 + r * (c * u + s * v), p1 + r1 * (c * u + s * v)])
    T = []
    for j in range(n):
        j2 = (j + 1) % n
        T += [(j, j2 + n, j2), (j, j + n, j2 + n)]
    if caps:
        P = np.concatenate([P, [p0, p1]])
        for j in range(n):
            j2 = (j + 1) % n
            T += [(2 * n, j2, j), (2 * n + 1, j + n, j2 + n)]
    T = np.asarray(T)
    # make outward
    cen = P[:2 * n].mean(0)
    fc = P[T].mean(1)
    fn = np.cross(P[T[:, 1]] - P[T[:, 0]], P[T[:, 2]] - P[T[:, 0]])
    if np.einsum('ij,ij->i', fn, fc - cen).sum() < 0:
        T = T[:, ::-1]
    return solid(P, T, mat, tile)


def orient_outward(m, centre=None):
    """Flip a closed-ish mesh to outward winding (by signed volume)."""
    P, T = m.P, m.T
    vol = np.einsum('ij,ij->i', P[T[:, 0]], np.cross(P[T[:, 1]], P[T[:, 2]])).sum()
    if vol < 0:
        return Mesh(P, T[:, ::-1], m.UV[:, ::-1], m.mat)
    return m


# ----------------------------------------------------------------------------------- PNG writer
def write_png(path, arr):
    arr = np.asarray(arr)
    if arr.dtype != np.uint8:
        arr = np.clip(arr * 255 + 0.5, 0, 255).astype(np.uint8)
    if arr.ndim == 2:
        arr = arr[..., None]
    h, w, c = arr.shape
    raw = b''.join(b'\x00' + arr[i].tobytes() for i in range(h))

    def chunk(t, d):
        return struct.pack('>I', len(d)) + t + d + struct.pack('>I', zlib.crc32(t + d) & 0xffffffff)
    ct = {1: 0, 3: 2, 4: 6}[c]
    png = b'\x89PNG\r\n\x1a\n' + chunk(b'IHDR', struct.pack('>IIBBBBB', w, h, 8, ct, 0, 0, 0)) + chunk(b'IDAT', zlib.compress(raw, 6)) + chunk(b'IEND', b'')
    os.makedirs(os.path.dirname(path), exist_ok=True)
    with open(path, 'wb') as f:
        f.write(png)


# ----------------------------------------------------------------------------------- clean clipping
def clip_mesh(pts, uvs, tris, mask):
    """Keep the part of a triangle mesh where mask > 0, cutting triangles at the mask = 0 isoline.

    Unlike pylib.sheets.clip_mesh, each cut edge gets exactly one new vertex (shared by both neighbours), so the
    result has no duplicated seam vertices; crossings are exact (no clamping)."""
    pts = np.asarray(pts, float); uvs = np.asarray(uvs, float); tris = np.asarray(tris, np.int64)
    mask = np.asarray(mask, float)
    inside = mask > 0
    tf = inside[tris]
    count = tf.sum(1)
    N = len(pts)
    # all crossing edges, one new vertex each
    e = np.concatenate([tris[:, [0, 1]], tris[:, [1, 2]], tris[:, [2, 0]]])
    e = e[inside[e[:, 0]] != inside[e[:, 1]]]
    lo, hi = np.minimum(e[:, 0], e[:, 1]), np.maximum(e[:, 0], e[:, 1])
    key = np.unique(lo * N + hi)
    ea, eb = key // N, key % N
    t = mask[ea] / (mask[ea] - mask[eb])
    newp = pts[ea] + t[:, None] * (pts[eb] - pts[ea])
    newu = uvs[ea] + t[:, None] * (uvs[eb] - uvs[ea])

    def ev(a, b):
        k = np.minimum(a, b) * N + np.maximum(a, b)
        return N + np.searchsorted(key, k)
    out = [tris[count == 3]]
    sel = tris[count == 1]
    if len(sel):
        f = tf[count == 1]
        r = np.argmax(f, 1)
        i = np.arange(len(sel))
        v0, v1, v2 = sel[i, r], sel[i, (r + 1) % 3], sel[i, (r + 2) % 3]
        out.append(np.stack([v0, ev(v0, v1), ev(v0, v2)], 1))
    sel = tris[count == 2]
    if len(sel):
        f = tf[count == 2]
        r = np.argmin(f, 1)
        i = np.arange(len(sel))
        c, a, b = sel[i, r], sel[i, (r + 1) % 3], sel[i, (r + 2) % 3]
        ea_, eb_ = ev(a, c), ev(b, c)
        out.append(np.stack([a, b, eb_], 1))
        out.append(np.stack([a, eb_, ea_], 1))
    P = np.concatenate([pts, newp]); U = np.concatenate([uvs, newu])
    T = np.concatenate(out)
    used = np.unique(T)
    remap = -np.ones(len(P), np.int64); remap[used] = np.arange(len(used))
    return P[used], U[used], remap[T]


def _boundary_edges(T, n):
    e = np.concatenate([T[:, [0, 1]], T[:, [1, 2]], T[:, [2, 0]]])
    k = np.minimum(e[:, 0], e[:, 1]) * n + np.maximum(e[:, 0], e[:, 1])
    u, inv, c = np.unique(k, return_inverse=True, return_counts=True)
    return e[c[inv.ravel()] == 1]


def _sarea(Q, T):
    a, b, c = Q[T[:, 0]], Q[T[:, 1]], Q[T[:, 2]]
    return (b[:, 0] - a[:, 0]) * (c[:, 1] - a[:, 1]) - (b[:, 1] - a[:, 1]) * (c[:, 0] - a[:, 0])


def clip_clean(XY, T, mask, smooth=3, collapse=0.4):
    """Clip a planar triangulation at mask = 0 without slivers or zig-zags.

    Exact crossings, then short boundary edges are collapsed and the boundary is relaxed along itself with an
    inversion guard.  XY (N,2) plane coords, CCW triangles."""
    XY = np.asarray(XY, float)
    m = np.asarray(mask, float)
    pts = np.concatenate([XY, np.zeros((len(XY), 1))], 1)
    P2, _, T2 = clip_mesh(pts, XY.copy(), np.asarray(T, np.int64), m)
    P2 = P2[:, :2].copy()
    sg = 1.0 if np.median(_sarea(XY, np.asarray(T))) > 0 else -1.0
    for _ in range(6):
        be = _boundary_edges(T2, len(P2))
        L = np.linalg.norm(P2[be[:, 0]] - P2[be[:, 1]], axis=1)
        e = np.concatenate([T2[:, [0, 1]], T2[:, [1, 2]]])
        le = np.linalg.norm(P2[e[:, 0]] - P2[e[:, 1]], axis=1)
        hloc = np.zeros(len(P2))
        np.maximum.at(hloc, e[:, 0], le); np.maximum.at(hloc, e[:, 1], le)
        short = np.where(L < collapse * 0.5 * (hloc[be[:, 0]] + hloc[be[:, 1]]))[0]
        if not len(short):
            break
        inc = [[] for _ in range(len(P2))]
        for ti, tri in enumerate(T2):
            for v in tri:
                inc[v].append(ti)
        alive = np.ones(len(T2), bool)
        touched = np.zeros(len(P2), bool)
        changed = False
        for k in short:
            a, b = be[k]
            if touched[a] or touched[b]:
                continue
            ts = set(inc[a]) | set(inc[b])
            ts = [t for t in ts if alive[t]]
            mid = 0.5 * (P2[a] + P2[b])
            ok = True
            new = []
            for t in ts:
                tri = [a if v == b else v for v in T2[t]]
                if len(set(tri)) < 3:
                    new.append((t, None)); continue
                Q = np.array([mid if v == a else P2[v] for v in tri])
                ar = ((Q[1, 0] - Q[0, 0]) * (Q[2, 1] - Q[0, 1]) - (Q[1, 1] - Q[0, 1]) * (Q[2, 0] - Q[0, 0])) * sg
                if ar <= 1e-14:
                    ok = False; break
                new.append((t, tri))
            if not ok:
                continue
            P2[a] = mid
            for t, tri in new:
                if tri is None:
                    alive[t] = False
                else:
                    T2[t] = tri
            for t in ts:
                for v in T2[t]:
                    touched[v] = True
            changed = True
        T2 = T2[alive]
        if not changed:
            break
    # remove needle ears (triangles with two boundary edges and a tiny angle)
    for _ in range(4):
        be = _boundary_edges(T2, len(P2))
        bset = set(map(tuple, np.sort(be, 1).tolist()))
        e3 = np.sort(np.stack([T2[:, [0, 1]], T2[:, [1, 2]], T2[:, [2, 0]]], 1), 2)
        nb = np.array([[tuple(x) in bset for x in tri] for tri in e3.tolist()]).sum(1)
        a, b, c = P2[T2[:, 0]], P2[T2[:, 1]], P2[T2[:, 2]]
        la, lb, lc = np.linalg.norm(b - c, axis=1), np.linalg.norm(c - a, axis=1), np.linalg.norm(a - b, axis=1)
        A = np.abs(_sarea(P2, T2)) * 0.5
        q = 4 * math.sqrt(3) * A / (la * la + lb * lb + lc * lc + 1e-30)
        ear = (nb >= 2) & (q < 0.25)
        if not ear.any():
            break
        T2 = T2[~ear]
    A0 = np.abs(_sarea(P2, T2))
    be = _boundary_edges(T2, len(P2))
    for _ in range(smooth):
        acc = np.zeros_like(P2); n = np.zeros(len(P2))
        np.add.at(acc, be[:, 0], P2[be[:, 1]]); np.add.at(n, be[:, 0], 1)
        np.add.at(acc, be[:, 1], P2[be[:, 0]]); np.add.at(n, be[:, 1], 1)
        sel = n == 2
        prev = P2.copy()
        P2[sel] = P2[sel] * 0.5 + 0.5 * acc[sel] / 2
        for _r in range(10):
            bad = _sarea(P2, T2) * sg <= A0 * 0.02
            if not bad.any():
                break
            vb = np.unique(T2[bad])
            P2[vb] = prev[vb]
    used = np.unique(T2)
    remap = -np.ones(len(P2), np.int64); remap[used] = np.arange(len(used))
    return P2[used], remap[T2]
