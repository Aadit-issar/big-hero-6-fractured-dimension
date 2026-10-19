"""Hard-surface kit for Baymax armour (numpy core; copied from the capsule workflow with the profile code removed).
Sheets are thickened along supplied analytic normals so seams can be welded afterwards."""
import math
import os
import sys
import zlib
import struct

import numpy as np

HERE = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, os.path.join(HERE, '..', '..', 'pilots'))
from pylib.noise import fbm, vnoise, smoothstep  # noqa: E402,F401
from pylib.meshutil import vertex_normals  # noqa: E402,F401
from pylib.sheets import grid_mesh, clip_mesh  # noqa: E402,F401

TAU = 2 * math.pi
SEED = 20261019


def wrap_angle(d):
    return (d + math.pi) % TAU - math.pi


# ----------------------------------------------------------------------------------- mesh container
class Mesh:
    """Triangle soup with per-corner UV and a material name per triangle."""

    def __init__(self, P, T, UV, mat):
        self.P = np.asarray(P, np.float32)
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
        if t is not None:
            P = P + np.asarray(t)
        return Mesh(P, self.T, self.UV, self.mat)


def rot(axis, ang):
    a = np.asarray(axis, float)
    a = a / np.linalg.norm(a)
    x, y, z = a
    c, s = math.cos(ang), math.sin(ang)
    C = 1 - c
    return np.array([[c + x * x * C, x * y * C - z * s, x * z * C + y * s], [y * x * C + z * s, c + y * y * C, y * z * C - x * s], [z * x * C - y * s, z * y * C + x * s, c + z * z * C]])


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
        uv[m, :, 0] = Q[m][:, :, ua] * sg[m][:, None] / tile
        uv[m, :, 1] = Q[m][:, :, va] / tile
    return uv


def solid(P, T, mat, tile=0.25):
    P = np.asarray(P, np.float32)
    T = np.asarray(T, np.int64)
    return Mesh(P, T, box_uv_corners(P, T, tile), mat)


def clean_tris(P, T, min_area=1e-10):
    a = np.cross(P[T[:, 1]] - P[T[:, 0]], P[T[:, 2]] - P[T[:, 0]])
    ok = np.linalg.norm(a, axis=1) > min_area * 2
    return T[ok], ok


# ----------------------------------------------------------------------------------- sheets with thickness
def thicken(P, UVp, T, thick, mats=('outer', 'inner', 'rim'), uv_mode='param', rim_tile=0.12, weld=False, normals=None):
    """Give a sheet real thickness along its vertex normals (inward).

    uv_mode 'param' uses the sheet parameters as UVs (u = theta/2pi, v = s/STOT); 'box' projects by position.
    Rim faces get position-projected UVs.  Returns a Mesh."""
    P = np.asarray(P, np.float64)
    T = np.asarray(T, np.int64)
    UVp = np.asarray(UVp, np.float64)
    if weld:
        q = np.round(P / 1e-5).astype(np.int64)
        _, idx, inv = np.unique(q, axis=0, return_index=True, return_inverse=True)
        P, UVp, T = P[idx], UVp[idx], inv.ravel()[T]
    T, _ = clean_tris(P, T)
    used = np.unique(T.ravel())
    remap = -np.ones(len(P), np.int64)
    remap[used] = np.arange(len(used))
    P, UVp, T = P[used], UVp[used], remap[T]
    if np.ndim(thick):
        thick = np.asarray(thick)[used]
    N = len(P)
    nrm = vertex_normals(P.astype(np.float32), T).astype(np.float64) if normals is None else np.asarray(normals, np.float64)[used]
    th = np.broadcast_to(np.asarray(thick, float), (N,))
    Pin = P - nrm * th[:, None]
    verts = np.concatenate([P, Pin])
    e = np.concatenate([T[:, [0, 1]], T[:, [1, 2]], T[:, [2, 0]]])
    key = np.minimum(e[:, 0], e[:, 1]) * N + np.maximum(e[:, 0], e[:, 1])
    uniq, inv, cnt = np.unique(key, return_inverse=True, return_counts=True)
    bnd = e[cnt[inv.ravel()] == 1]
    a, b = bnd[:, 0], bnd[:, 1]
    rim_t = np.concatenate([np.stack([a, b + N, b], 1), np.stack([a, a + N, b + N], 1)])
    tris = np.concatenate([T, T[:, ::-1] + N, rim_t])
    mid = np.concatenate([np.zeros(len(T), int), np.ones(len(T), int), np.full(len(rim_t), 2)])
    matname = np.array(mats, dtype=object)[mid]
    if uv_mode == 'param':
        uvv = UVp.astype(np.float32)
        uv_corner = np.concatenate([uvv[T], uvv[T[:, ::-1]]])
    else:
        uv_corner = box_uv_corners(verts.astype(np.float32), np.concatenate([T, T[:, ::-1] + N]), rim_tile * 2)
    V = verts[rim_t]
    uvr = np.stack([(V[:, :, 0] * 0.8 + V[:, :, 1] * 0.6) / rim_tile, V[:, :, 2] / rim_tile + (V[:, :, 0] - V[:, :, 1]) * 2.0], axis=-1).astype(np.float32)
    UV = np.concatenate([uv_corner, uvr])
    return Mesh(verts, tris, UV, matname)


# ----------------------------------------------------------------------------------- primitives
def box(center, size, bevel=0.0, rotation=None, mat='housing', tile=0.3, seg=2):
    import bmesh
    bm = bmesh.new()
    bmesh.ops.create_cube(bm, size=1.0)
    for v in bm.verts:
        v.co.x *= size[0]; v.co.y *= size[1]; v.co.z *= size[2]
    if bevel and bevel > 0:
        bmesh.ops.bevel(bm, geom=bm.verts[:] + bm.edges[:] + bm.faces[:], offset=bevel, segments=seg, affect='EDGES')
    bmesh.ops.triangulate(bm, faces=bm.faces[:])
    bm.verts.ensure_lookup_table()
    P = np.array([v.co[:] for v in bm.verts], np.float64)
    T = np.array([[v.index for v in f.verts] for f in bm.faces], np.int64)
    bm.free()
    if rotation is not None:
        P = P @ np.asarray(rotation).T
    P = P + np.asarray(center)
    return solid(P, T, mat, tile)


def lathe(profile, n=48, a0=0.0, a1=TAU, mat='metal', tile=0.3):
    """Revolve an (r, z) polyline about z; profile order sets the face winding (outside to the right = outward)."""
    prof = np.asarray(profile, float)
    ang = np.linspace(a0, a1, n + 1)
    m = len(prof)
    P = np.stack([prof[None, :, 0] * np.cos(ang)[:, None], prof[None, :, 0] * np.sin(ang)[:, None], np.broadcast_to(prof[None, :, 1], (n + 1, m))], axis=-1).reshape(-1, 3)
    idx = np.arange((n + 1) * m).reshape(n + 1, m)
    a, b, c, d = idx[:-1, :-1].ravel(), idx[1:, :-1].ravel(), idx[1:, 1:].ravel(), idx[:-1, 1:].ravel()
    T = np.concatenate([np.stack([a, b, c], 1), np.stack([a, c, d], 1)])
    T, _ = clean_tris(P, T)
    return solid(P, T, mat, tile)


def sweep(path, radius, n=8, mat='cable', tile=0.2, cap=True):
    """Tube along a polyline path (K,3); radius scalar or per-point."""
    path = np.asarray(path, float)
    K = len(path)
    rad = np.broadcast_to(np.asarray(radius, float), (K,))
    tan = np.gradient(path, axis=0)
    tan /= np.linalg.norm(tan, axis=1, keepdims=True) + 1e-12
    ref = np.array([0, 0, 1.0]) if abs(tan[0, 2]) < 0.9 else np.array([1.0, 0, 0])
    u = np.cross(tan[0], ref); u /= np.linalg.norm(u)
    rings = []
    for k in range(K):
        v = np.cross(tan[k], u); v /= np.linalg.norm(v) + 1e-12
        u = np.cross(v, tan[k]); u /= np.linalg.norm(u) + 1e-12
        a = np.linspace(0, TAU, n, endpoint=False)
        rings.append(path[k] + rad[k] * (np.cos(a)[:, None] * u + np.sin(a)[:, None] * v))
    P = np.concatenate(rings)
    T = []
    for k in range(K - 1):
        for j in range(n):
            j2 = (j + 1) % n
            a, b = k * n + j, k * n + j2
            T += [(a, b, b + n), (a, b + n, a + n)]
    if cap:
        for k, flip in ((0, True), (K - 1, False)):
            c = len(P)
            P = np.concatenate([P, path[k][None]])
            for j in range(n):
                a, b = k * n + j, k * n + (j + 1) % n
                T.append((c, b, a) if flip else (c, a, b))
    return solid(P, np.asarray(T), mat, tile)


def cylinder(p0, p1, r, n=16, mat='metal', r1=None, tile=0.3, caps=True):
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
        T += [(j, j2, j2 + n), (j, j2 + n, j + n)]
    if caps:
        P = np.concatenate([P, [p0, p1]])
        for j in range(n):
            j2 = (j + 1) % n
            T += [(2 * n, j2, j), (2 * n + 1, j + n, j2 + n)]
    return solid(P, np.asarray(T), mat, tile)


# ----------------------------------------------------------------------------------- PNG writer
def write_png(path, arr):
    arr = np.asarray(arr)
    if arr.dtype != np.uint8:
        arr = np.clip(arr * 255 + 0.5, 0, 255).astype(np.uint8)
    h, w, c = arr.shape
    raw = b''.join(b'\x00' + arr[i].tobytes() for i in range(h))

    def chunk(t, d):
        return struct.pack('>I', len(d)) + t + d + struct.pack('>I', zlib.crc32(t + d) & 0xffffffff)
    ct = {1: 0, 3: 2, 4: 6}[c]
    png = b'\x89PNG\r\n\x1a\n' + chunk(b'IHDR', struct.pack('>IIBBBBB', w, h, 8, ct, 0, 0, 0)) + chunk(b'IDAT', zlib.compress(raw, 6)) + chunk(b'IEND', b'')
    os.makedirs(os.path.dirname(path), exist_ok=True)
    with open(path, 'wb') as f:
        f.write(png)
