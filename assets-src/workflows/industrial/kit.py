"""Industrial kit: numpy mesh primitives shared by every industrial_* assembler.

Everything is metres. A mesh part is `M(v, t, d)`: vertices, triangles (outward winding) and `d`, a per-vertex
damage pair (tear proximity, crumple) that drives the paint/rust bake. Parts are merged per material group by the
assemblers and finished by finish.py (bevel, UV atlas, Cycles wear bake, GLB, LODs).

Kit contents: box/boxes, hollow or solid swept tubes (pipes, scaffold tube, conduit), profile sweeps (I/H/channel/
angle sections with arbitrary deformation), solidified plates with holes (connection plates, flanges, base plates),
bolt assemblies, weld beads, torus beads (pipe seams), open grating, expanded noise helpers for tears."""
import math
import os
import sys

import numpy as np

sys.path.insert(0, os.path.join(os.path.dirname(__file__), '..', '..', 'pilots'))
from pylib import hardware, rebar  # noqa: E402
from pylib.noise import fbm, smoothstep, vnoise  # noqa: E402,F401


class M:
    def __init__(self, v, t, d=None):
        self.v = np.asarray(v, dtype=np.float64).reshape(-1, 3)
        self.t = np.asarray(t, dtype=np.int64).reshape(-1, 3)
        self.d = np.zeros((len(self.v), 2)) if d is None else np.asarray(d, dtype=np.float64).reshape(-1, 2)

    def copy(self):
        return M(self.v.copy(), self.t.copy(), self.d.copy())

    def xf(self, R=None, T=None):
        v = self.v if R is None else self.v @ np.asarray(R).T
        if T is not None:
            v = v + np.asarray(T)
        return M(v, self.t, self.d)

    def damage(self, tear=None, crumple=None):
        d = self.d.copy()
        if tear is not None:
            d[:, 0] = np.maximum(d[:, 0], tear)
        if crumple is not None:
            d[:, 1] = np.maximum(d[:, 1], crumple)
        return M(self.v, self.t, d)


def merge(parts):
    parts = [p for p in parts if p is not None and len(p.t)]
    off, vs, ts, ds = 0, [], [], []
    for p in parts:
        vs.append(p.v)
        ts.append(p.t + off)
        ds.append(p.d)
        off += len(p.v)
    return M(np.concatenate(vs), np.concatenate(ts), np.concatenate(ds))


# ------------------------------------------------------------------ frames
def basis(axis, ref=None):
    w = np.asarray(axis, float)
    w = w / np.linalg.norm(w)
    if ref is None:
        ref = np.array([0.0, 0.0, 1.0]) if abs(w[2]) < 0.9 else np.array([1.0, 0.0, 0.0])
    u = np.cross(ref, w)
    u /= np.linalg.norm(u)
    v = np.cross(w, u)
    return u, v, w


def rot_from_x(axis, up=None):
    """Rotation matrix taking local +x to `axis` and local +z toward `up` (default world z)."""
    x = np.asarray(axis, float)
    x = x / np.linalg.norm(x)
    up = np.array([0.0, 0.0, 1.0]) if up is None else np.asarray(up, float)
    y = np.cross(up, x)
    if np.linalg.norm(y) < 1e-6:
        y = np.cross(np.array([0.0, 1.0, 0.0]), x)
    y /= np.linalg.norm(y)
    z = np.cross(x, y)
    return np.stack([x, y, z], axis=1)


def rot_axis(axis, ang):
    a = np.asarray(axis, float)
    a = a / np.linalg.norm(a)
    c, s = math.cos(ang), math.sin(ang)
    K = np.array([[0, -a[2], a[1]], [a[2], 0, -a[0]], [-a[1], a[0], 0]])
    return np.eye(3) * c + s * K + (1 - c) * np.outer(a, a)


def transport_frames(pts):
    tan = np.gradient(pts, axis=0)
    tan /= np.maximum(np.linalg.norm(tan, axis=1, keepdims=True), 1e-12)
    ref = np.array([0.0, 0.0, 1.0]) if abs(tan[0, 2]) < 0.9 else np.array([1.0, 0.0, 0.0])
    N = np.zeros_like(pts)
    N[0] = np.cross(ref, tan[0])
    N[0] /= np.linalg.norm(N[0])
    for i in range(1, len(pts)):
        ax = np.cross(tan[i - 1], tan[i])
        sn = np.linalg.norm(ax)
        if sn < 1e-9:
            N[i] = N[i - 1]
        else:
            ang = math.atan2(sn, float(np.dot(tan[i - 1], tan[i])))
            k = ax / sn
            v = N[i - 1]
            N[i] = v * math.cos(ang) + np.cross(k, v) * math.sin(ang) + k * np.dot(k, v) * (1 - math.cos(ang))
    B = np.cross(tan, N)
    return tan, N, B


def resample(path, step):
    path = np.asarray(path, float)
    seg = np.linalg.norm(np.diff(path, axis=0), axis=1)
    s = np.concatenate([[0], np.cumsum(seg)])
    n = max(2, int(math.ceil(s[-1] / step)) + 1)
    t = np.linspace(0, s[-1], n)
    return np.stack([np.interp(t, s, path[:, k]) for k in range(3)], axis=1), t


# ------------------------------------------------------------------ boxes
_CUBE_V = np.array([[x, y, z] for x in (-.5, .5) for y in (-.5, .5) for z in (-.5, .5)], float)
_CUBE_T = np.array([[0, 1, 3], [0, 3, 2], [4, 6, 7], [4, 7, 5], [0, 4, 5], [0, 5, 1], [2, 3, 7], [2, 7, 6], [0, 2, 6], [0, 6, 4], [1, 5, 7], [1, 7, 3]])


def boxes(centers, sizes, R=None):
    """Many axis-aligned boxes (vectorised). centers (n,3), sizes (n,3) or (3,). R rotates all about the origin."""
    centers = np.atleast_2d(np.asarray(centers, float))
    sizes = np.broadcast_to(np.asarray(sizes, float), centers.shape)
    v = _CUBE_V[None] * sizes[:, None, :] + centers[:, None, :]
    t = _CUBE_T[None] + (np.arange(len(centers)) * 8)[:, None, None]
    m = M(v.reshape(-1, 3), t.reshape(-1, 3))
    return m if R is None else m.xf(R)


def box(c, sx, sy, sz, R=None):
    return boxes([c], [(sx, sy, sz)], R)


# ------------------------------------------------------------------ tubes
def tube(path, r_out, r_in=None, segs=14, step=0.05, r_scale=None, end_jag=None, cap_start=True, cap_end=True, rot0=0.0, oval=None):
    """Swept tube. Hollow when r_in is given (real wall thickness, annular ends). `end_jag(ring_index, theta_array)`
    may return a tangent-direction displacement (m) for the end rings (torn ends). r_scale(s01) scales the radius."""
    pts, s = resample(path, step)
    n = len(pts)
    tan, N, B = transport_frames(pts)
    th = np.linspace(0, 2 * math.pi, segs, endpoint=False) + rot0
    ct, st = np.cos(th), np.sin(th)
    sc = np.ones(n) if r_scale is None else np.array([r_scale(x) for x in s / max(s[-1], 1e-9)])

    ov = None if oval is None else np.array([oval(x) for x in s / max(s[-1], 1e-9)])   # (n, 2): radius factors along N and B

    def ring(r, k):
        kn, kb = (1.0, 1.0) if ov is None else ov[k]
        p = pts[k][None] + (r * sc[k]) * (kn * ct[:, None] * N[k][None] + kb * st[:, None] * B[k][None])
        if end_jag is not None and k == n - 1:
            p = p + end_jag(k, th)[:, None] * tan[k][None]
        return p
    outer = np.stack([ring(r_out, k) for k in range(n)])
    verts = [outer.reshape(-1, 3)]
    hollow = r_in is not None
    if hollow:
        inner = np.stack([ring(r_in, k) for k in range(n)])
        verts.append(inner.reshape(-1, 3))
    V = np.concatenate(verts)
    io = lambda k, j: k * segs + (j % segs)  # noqa: E731
    ii = lambda k, j: n * segs + k * segs + (j % segs)  # noqa: E731
    T = []
    for k in range(n - 1):
        for j in range(segs):
            T += [(io(k, j), io(k, j + 1), io(k + 1, j + 1)), (io(k, j), io(k + 1, j + 1), io(k + 1, j))]
            if hollow:
                T += [(ii(k, j), ii(k + 1, j + 1), ii(k, j + 1)), (ii(k, j), ii(k + 1, j), ii(k + 1, j + 1))]
    extra = []
    for k, flag, sign in ((0, cap_start, -1), (n - 1, cap_end, 1)):
        if not flag:
            continue
        if not hollow:
            ci = len(V) + len(extra)
            extra.append(pts[k])
        for j in range(segs):
            if hollow:
                a, b, c, d = io(k, j), io(k, j + 1), ii(k, j + 1), ii(k, j)
                T += [(a, b, c), (a, c, d)] if sign > 0 else [(a, d, c), (a, c, b)]
            else:
                T += [(ci, io(k, j), io(k, j + 1))] if sign > 0 else [(ci, io(k, j + 1), io(k, j))]
    if extra:
        V = np.concatenate([V, np.asarray(extra)])
    return M(V, np.asarray(T))


def fix_cap_centres(m):  # kept for API symmetry: tube() appends exactly one centre per solid cap
    return m


def torus(c, axis, R, r, segs_u=40, segs_v=6, rot=0.0):
    u, v, w = basis(axis)
    a = np.linspace(0, 2 * math.pi, segs_u, endpoint=False)
    path = np.stack([c[0] + R * (np.cos(a) * u[0] + np.sin(a) * v[0]), c[1] + R * (np.cos(a) * u[1] + np.sin(a) * v[1]), c[2] + R * (np.cos(a) * u[2] + np.sin(a) * v[2])], 1)
    return closed_tube(path, r, segs_v)


def closed_tube(path, r, segs=6, r_mod=None):
    """Closed swept loop with circular section (torus-like, for seams and rings)."""
    path = np.asarray(path, float)
    n = len(path)
    tan = np.roll(path, -1, 0) - np.roll(path, 1, 0)
    tan /= np.linalg.norm(tan, axis=1, keepdims=True)
    cen = path.mean(axis=0)
    N = path - cen
    N -= (N * tan).sum(1, keepdims=True) * tan
    N /= np.maximum(np.linalg.norm(N, axis=1, keepdims=True), 1e-12)
    B = np.cross(tan, N)
    th = np.linspace(0, 2 * math.pi, segs, endpoint=False)
    rr = np.full(n, r) if r_mod is None else r * r_mod
    V = path[:, None, :] + rr[:, None, None] * (np.cos(th)[None, :, None] * N[:, None, :] + np.sin(th)[None, :, None] * B[:, None, :])
    V = V.reshape(-1, 3)
    T = []
    for k in range(n):
        k2 = (k + 1) % n
        for j in range(segs):
            j2 = (j + 1) % segs
            a, b, c, d = k * segs + j, k * segs + j2, k2 * segs + j2, k2 * segs + j
            # N points outward from the loop centre, B = tan x N: ring runs CCW about tan; walls wind outward
            T += [(a, d, c), (a, c, b)]
    m = M(V, T)
    return orient_outward(m)


def orient_outward(m):
    """Flip all triangles if the closed mesh has negative signed volume."""
    vol = np.einsum('ij,ij->i', m.v[m.t[:, 0]], np.cross(m.v[m.t[:, 1]], m.v[m.t[:, 2]])).sum()
    return m if vol >= 0 else M(m.v, m.t[:, ::-1], m.d)


# ------------------------------------------------------------------ profile sweeps (beams, channels, angles)
def ear_clip(poly):
    """Triangulate a simple CCW polygon (n,2): returns index triples."""
    idx = list(range(len(poly)))
    out = []
    P = np.asarray(poly, float)

    def cross(a, b, c):
        return (P[b, 0] - P[a, 0]) * (P[c, 1] - P[a, 1]) - (P[b, 1] - P[a, 1]) * (P[c, 0] - P[a, 0])

    def inside(p, a, b, c):
        return cross(a, b, p) >= -1e-12 and cross(b, c, p) >= -1e-12 and cross(c, a, p) >= -1e-12
    guard = 0
    while len(idx) > 3 and guard < 10000:
        guard += 1
        for k in range(len(idx)):
            a, b, c = idx[k - 1], idx[k], idx[(k + 1) % len(idx)]
            if cross(a, b, c) <= 1e-14:
                continue
            if any(inside(o, a, b, c) for o in idx if o not in (a, b, c)):
                continue
            out.append((a, b, c))
            idx.pop(k)
            break
        else:
            break
    if len(idx) == 3:
        out.append(tuple(idx))
    return out


def subdivide_outline(poly, h):
    """Insert points so no edge is longer than h (closed polygon, CCW)."""
    out = []
    n = len(poly)
    for i in range(n):
        a, b = np.asarray(poly[i], float), np.asarray(poly[(i + 1) % n], float)
        m = max(1, int(math.ceil(np.linalg.norm(b - a) / h)))
        for k in range(m):
            out.append(a + (b - a) * (k / m))
    return np.array(out)


def i_outline(depth, bf, tf, tw, chamfer=0.0015, root=0.0):
    """Rolled I/H section in (y, z), CCW viewed from +x. depth along z, flange width along y."""
    hd, hb, hw = depth / 2, bf / 2, tw / 2
    c = chamfer
    pts = [
        (hw, -hd + tf), (hb - c, -hd + tf), (hb, -hd + tf - c) if False else (hb, -hd + tf), (hb, -hd + c), (hb - c, -hd), (-hb + c, -hd), (-hb, -hd + c), (-hb, -hd + tf), (-hw, -hd + tf),
        (-hw, hd - tf), (-hb, hd - tf), (-hb, hd - c), (-hb + c, hd), (hb - c, hd), (hb, hd - c), (hb, hd - tf), (hw, hd - tf),
    ]
    return np.array(pts)


def channel_outline(depth, bf, tf, tw):
    hd = depth / 2
    return np.array([(0, -hd), (bf, -hd), (bf, -hd + tf), (tw, -hd + tf), (tw, hd - tf), (bf, hd - tf), (bf, hd), (0, hd)])


def angle_outline(a, b, t):
    return np.array([(0, 0), (a, 0), (a, t), (t, t), (t, b), (0, b)])


def profile_sweep(outline, s_vals, deform, cap_start=True, cap_end=True, sub=0.03, jag_end=None):
    """Sweep a closed section (y, z) along rest-space stations s_vals; deform(P (n,3 as s, y, z)) -> world (n,3).
    `jag_end(y, z)` -> extra rest-space s displacement of the end ring (torn ends); applied to the last/first ring AND cap."""
    poly = subdivide_outline(outline, sub)
    m = len(poly)
    n = len(s_vals)
    S = np.repeat(np.asarray(s_vals, float), m)
    Y = np.tile(poly[:, 0], n)
    Z = np.tile(poly[:, 1], n)
    if jag_end is not None:
        j0, j1 = jag_end
        if j0 is not None:
            S[:m] += j0(poly[:, 0], poly[:, 1])
        if j1 is not None:
            S[-m:] += j1(poly[:, 0], poly[:, 1])
    rest = np.stack([S, Y, Z], 1)
    V = deform(rest)
    T = []
    ring = np.arange(n * m).reshape(n, m)
    a = ring[:-1]
    b = ring[1:]
    a2 = np.roll(a, -1, axis=1)
    b2 = np.roll(b, -1, axis=1)
    T = np.concatenate([np.stack([a, a2, b2], -1).reshape(-1, 3), np.stack([a, b2, b], -1).reshape(-1, 3)])
    tri2d = np.array(ear_clip(poly))
    caps = []
    if cap_start:
        caps.append(ring[0][tri2d][:, ::-1])
    if cap_end:
        caps.append(ring[-1][tri2d])
    T = np.concatenate([T] + caps)
    mm = M(V, T)
    return mm, rest


# ------------------------------------------------------------------ solid plates
def boundary_edges(tris):
    e = np.concatenate([tris[:, [0, 1]], tris[:, [1, 2]], tris[:, [2, 0]]])
    key = np.sort(e, axis=1)
    k = key[:, 0] * (tris.max() + 1) + key[:, 1]
    _, inv, cnt = np.unique(k, return_inverse=True, return_counts=True)
    return e[cnt[inv] == 1]


def vnormals(v, t):
    n = np.zeros_like(v)
    fn = np.cross(v[t[:, 1]] - v[t[:, 0]], v[t[:, 2]] - v[t[:, 0]])
    for k in range(3):
        np.add.at(n, t[:, k], fn)
    ln = np.linalg.norm(n, axis=1, keepdims=True)
    return n / np.maximum(ln, 1e-12)


def solidify(m, thickness, offset=0.0):
    """Give a sheet real thickness (numpy Solidify): front/back shells plus a stitched rim at the open boundary."""
    n = vnormals(m.v, m.t)
    nv = len(m.v)
    front = m.v + n * (thickness * (0.5 + offset * 0.5))
    back = m.v - n * (thickness * (0.5 - offset * 0.5))
    V = np.concatenate([front, back])
    D = np.concatenate([m.d, m.d])
    T = [m.t, m.t[:, ::-1] + nv]
    be = boundary_edges(m.t)
    if len(be):
        a, b = be[:, 0], be[:, 1]
        T.append(np.stack([a, a + nv, b + nv], 1))
        T.append(np.stack([a, b + nv, b], 1))
    return M(V, np.concatenate(T), D)


def plate(outline, holes, thickness, origin, ax_u, ax_v, edge_h=None):
    """Flat plate with circular holes: outline (n,2) CCW; holes [(cx, cy, r, nseg)]; plane spanned by ax_u, ax_v at origin.
    Triangulated with Blender's constrained fill, then solidified."""
    from pylib import blend
    o, u, v = np.asarray(origin, float), np.asarray(ax_u, float), np.asarray(ax_v, float)
    verts, tris = blend.plate_mesh(np.asarray(outline), holes, lambda a, b: tuple(o + a * u + b * v))
    m = M(verts, tris)
    nrm = np.cross(u, v)
    if np.dot(vnormals(m.v, m.t).mean(axis=0), nrm) < 0:
        m = M(m.v, m.t[:, ::-1], m.d)
    return solidify(m, thickness)


def circle(r, n=32, cx=0.0, cy=0.0):
    a = np.linspace(0, 2 * math.pi, n, endpoint=False)
    return np.stack([cx + r * np.cos(a), cy + r * np.sin(a)], 1)


def rrect(w, h, r, n=4):
    from pylib import blend
    return blend.rounded_rect(w, h, r, n)


# ------------------------------------------------------------------ hardware
def bolt_assy(origin, axis, grip, scale=1.0, seed=0, nut=True, sheared=0.0, detail=False):
    """Hex bolt + washer (+ nut). detail=True uses the pilot hardware with modelled thread rings (hero shots);
    the default is a cheap bolt (~90 tris) for assemblies with many fasteners. `scale` 0.5 ~ M12, 1.0 ~ M24."""
    o = np.asarray(origin, float)
    if detail:
        v, t = hardware.bolt(tuple(origin), tuple(axis), grip / scale, seed=seed, with_nut=nut, shank_sheared=sheared / scale)
        v = (v.astype(np.float64) - o) * scale + o
        return M(v, t)
    rng = np.random.default_rng(seed)
    u, v_, w = hardware._frame(axis)
    rot0 = rng.uniform(0, math.pi / 3)
    k = scale
    P = lambda d: o + w * (d * k)  # noqa: E731
    parts = []
    hr = 0.0208
    parts.append(hardware.loft([hardware._ring(P(d), u, v_, r * k, 6, rot0) for d, r in [(0.0, hr), (-0.011, hr), (-0.0155, hr * 0.8)]], False, True))
    parts.append(hardware.loft([hardware._ring(P(0.0), u, v_, 0.0225 * k, 10), hardware._ring(P(0.004), u, v_, 0.0225 * k, 10)], True, True))
    shank = grip / k + 0.004 + (0.004 + 0.021 + 0.013 if nut else 0.012)
    end = max(0.02, shank - sheared / k)
    parts.append(hardware.loft([hardware._ring(P(d), u, v_, 0.0118 * k, 8) for d in (0.004, end * 0.5, end)], False, True))
    if nut and sheared == 0:
        n0 = grip / k + 0.004
        parts.append(hardware.loft([hardware._ring(P(d), u, v_, r * k, 6, rot0 + 0.4) for d, r in [(n0, hr * 0.8), (n0 + 0.004, hr), (n0 + 0.0235, hr), (n0 + 0.0275, hr * 0.8)]], True, True))
    vs, ts, off = [], [], 0
    for vv, tt in parts:
        vol = np.einsum('ij,ij->i', vv[tt[:, 0]], np.cross(vv[tt[:, 1]], vv[tt[:, 2]])).sum()
        if vol < 0:
            tt = tt[:, ::-1]
        vs.append(vv)
        ts.append(tt + off)
        off += len(vv)
    return M(np.concatenate(vs), np.concatenate(ts))


def weld(path, seed, r=0.0045, step=0.008, segs=5):
    path = np.asarray(path, float)
    rs = hardware.weld_path_radius(len(path), seed, r) / r
    v, t, _ = rebar.sweep(path, r, ribbed=True, ring_step=step, segs=segs, pitch=0.0075, rib_amp=0.16, long_amp=0.0, radius_scale=rs)
    return M(v, t)


# ------------------------------------------------------------------ grating
def grating(length, width, bar_h=0.03, bar_t=0.003, pitch_b=0.035, pitch_c=0.10, seg=0.5, missing=None):
    """Open steel grating panel in z = 0 (x along length, y along width): bearing bars on edge along x (in `seg`-long
    pieces so a later bend/warp has vertices to bend), cross bars, and a perimeter band. `missing(x, y)` -> bool array
    removes bars (damage)."""
    ys = np.arange(pitch_b / 2, width, pitch_b) - width / 2
    nseg = max(1, int(round(length / seg)))
    sl = length / nseg
    cs, ss = [], []
    for y in ys:
        for k in range(nseg):
            cs.append((-length / 2 + sl * (k + 0.5), y, 0))
            ss.append((sl * 1.002, bar_t, bar_h))
    for x in np.arange(pitch_c / 2, length, pitch_c) - length / 2:
        cs.append((x, 0, -bar_h * 0.15))
        ss.append((bar_t * 1.2, width, bar_t * 1.6))
    for sgn in (-1, 1):
        cs.append((sgn * (length / 2 - bar_t / 2), 0, 0))
        ss.append((bar_t, width, bar_h))
    cs, ss = np.array(cs), np.array(ss)
    if missing is not None:
        keep = ~missing(cs[:, 0], cs[:, 1])
        cs, ss = cs[keep], ss[keep]
    return boxes(cs, ss)


def jag(seed, amp, freq):
    """Tear-edge displacement function of a parameter array (smooth, with a rougher secondary)."""
    def f(a):
        return amp * (0.6 * np.tanh(2.0 * fbm(a * freq, 0 * a + 3.1, None, 3, seed=seed)) + 0.4 * vnoise(a * freq * 3.1, 0 * a, None, seed + 1))
    return f


# ------------------------------------------------------------------ deformation helpers
def tri_wave(x):
    """Triangle wave in [-1, 1]: sharp creases between flat facets (folded sheet metal, not sine ripples)."""
    return np.arcsin(np.sin(x)) * (2.0 / math.pi)


def tent(d, w):
    return np.maximum(0.0, 1.0 - np.abs(d) / w)


def gauss(s, c, w):
    return np.exp(-(((s - c) / w) ** 2))


class Centerline:
    """Planar (x, z) centreline from a curvature profile: kinks = [(station, angle_rad, width)]."""

    def __init__(self, L, kinks, n=6001):
        self.ss = np.linspace(0.0, L + 1.0, n)
        kappa = np.zeros_like(self.ss)
        for c, ang, w in kinks:
            kappa += (ang / (w * math.sqrt(math.pi))) * np.exp(-(((self.ss - c) / w) ** 2))
        d = np.diff(self.ss)
        self.theta = np.concatenate([[0.0], np.cumsum(0.5 * (kappa[1:] + kappa[:-1]) * d)])
        self.x = np.concatenate([[0.0], np.cumsum(0.5 * (np.cos(self.theta[1:]) + np.cos(self.theta[:-1])) * d)])
        self.z = np.concatenate([[0.0], np.cumsum(0.5 * (np.sin(self.theta[1:]) + np.sin(self.theta[:-1])) * d)])

    def apply(self, s, y, z, pivot=0.0):
        """Place section points (offsets y, z from the centroid) on the bent centreline. Bending pivots about z = pivot."""
        th = np.interp(s, self.ss, self.theta)
        cx, cz = np.interp(s, self.ss, self.x), np.interp(s, self.ss, self.z)
        nx, nz = -np.sin(th), np.cos(th)
        return np.stack([cx + (z - pivot) * nx, y, cz + (z - pivot) * nz + pivot], 1)


def twist_yz(y, z, phi):
    c, s = np.cos(phi), np.sin(phi)
    return y * c - z * s, y * s + z * c


def stations(L, hot, base=0.35, fine=0.02, slope=0.2):
    """Ring stations: `fine` spacing near the stations in `hot` [(centre, half-width)], growing to `base` away from them."""
    out, s = [0.0], 0.0
    while s < L:
        d = min(max(abs(s - c) - w, 0.0) for c, w in hot)
        s += min(base, fine + slope * d)
        out.append(min(s, L))
    return np.unique(np.asarray(out))


def grid_sheet(origin, du, dv, nu, nv, thickness=None):
    """Flat sheet mid-surface: origin + a*du + b*dv, a in [0,1] with nu cells, b in [0,1] with nv cells; solidified if thickness."""
    o, du, dv = (np.asarray(x, float) for x in (origin, du, dv))
    a = np.linspace(0, 1, nu + 1)
    b = np.linspace(0, 1, nv + 1)
    A, B = np.meshgrid(a, b, indexing='ij')
    V = o + A.reshape(-1, 1) * du + B.reshape(-1, 1) * dv
    idx = np.arange((nu + 1) * (nv + 1)).reshape(nu + 1, nv + 1)
    p, q, r, s = idx[:-1, :-1].ravel(), idx[1:, :-1].ravel(), idx[1:, 1:].ravel(), idx[:-1, 1:].ravel()
    T = np.concatenate([np.stack([p, q, r], 1), np.stack([p, r, s], 1)])
    m = M(V, T)
    if np.dot(vnormals(m.v, m.t).mean(axis=0), np.cross(du, dv)) < 0:
        m = M(m.v, m.t[:, ::-1])
    return solidify(m, thickness) if thickness else m


def curve_cable(path, r, segs=8, step=0.06, **kw):
    return tube(path, r, None, segs=segs, step=step, **kw)
