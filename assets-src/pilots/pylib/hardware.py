"""Structural hardware meshes (numpy): hex-head bolts with washers, nuts and threads."""
import math

import numpy as np


def _frame(w):
    w = np.asarray(w, dtype=np.float64)
    w = w / np.linalg.norm(w)
    ref = np.array([0.0, 0.0, 1.0]) if abs(w[2]) < 0.9 else np.array([1.0, 0.0, 0.0])
    u = np.cross(w, ref)
    u /= np.linalg.norm(u)
    v = np.cross(w, u)
    return u, v, w


def _ring(c, u, v, r, n, rot=0.0):
    a = np.linspace(0, 2 * math.pi, n, endpoint=False) + rot
    return c[None, :] + r * (np.cos(a)[:, None] * u[None, :] + np.sin(a)[:, None] * v[None, :])


def loft(rings, cap_start=True, cap_end=True):
    """Quad strips between consecutive equal-sized rings, closed with centre fans. Outward winding for rings
    ordered along +w with counter-clockwise (u -> v) points."""
    n = len(rings[0])
    verts = np.concatenate(rings)
    tris = []
    for k in range(len(rings) - 1):
        a, b = k * n, (k + 1) * n
        for j in range(n):
            j2 = (j + 1) % n
            tris.append((a + j, a + j2, b + j2))
            tris.append((a + j, b + j2, b + j))
    extra = []
    if cap_start:
        c = rings[0].mean(axis=0)
        cid = len(verts) + len(extra)
        extra.append(c)
        for j in range(n):
            tris.append((cid, (j + 1) % n, j))
    if cap_end:
        c = rings[-1].mean(axis=0)
        cid = len(verts) + len(extra)
        extra.append(c)
        base = (len(rings) - 1) * n
        for j in range(n):
            tris.append((cid, base + j, base + (j + 1) % n))
    if extra:
        verts = np.concatenate([verts, np.asarray(extra)])
    return verts, np.asarray(tris, dtype=np.int64)


def bolt(origin, axis, grip, seed=0, with_nut=True, shank_sheared=0.0, head_r=0.0208, nut_side=True):
    """An M24-class hex bolt. `origin` is the head bearing face centre, `axis` points from the head into the joint,
    `grip` is the clamped thickness. The shank is cut short by `shank_sheared` (m) when the bolt has failed.

    Returns (verts float32, tris int32). Everything is generated in a local frame and moved to world space."""
    rng = np.random.default_rng(seed)
    u, v, w = _frame(axis)
    o = np.asarray(origin, dtype=np.float64)
    rot0 = rng.uniform(0, math.pi / 3)
    parts = []

    def add(p):
        parts.append(p)

    def P(depth):                 # point on the axis at `depth` into the joint (negative = toward the head)
        return o + w * depth

    # Head (toward -w from the bearing face): chamfered hex.
    hr = [(0.0, head_r), (-0.011, head_r), (-0.0155, head_r * 0.80)]
    add(loft([_ring(P(d), u, v, r, 6, rot0) for d, r in hr], cap_start=False, cap_end=True))
    # Washer under the head.
    add(loft([_ring(P(0.0), u, v, 0.0225, 16), _ring(P(0.004), u, v, 0.0225, 16)], True, True))
    d0 = 0.004
    shank_len = grip + 0.004 + (0.004 + 0.021 + 0.013 if with_nut else 0.0)
    end = max(0.02, shank_len - shank_sheared)
    rings = []
    z = d0
    while z < end:
        thread = z > grip + 0.012
        r = 0.0120 * (1.0 - 0.07 * (0.5 + 0.5 * math.sin(z / 0.0042 * 2 * math.pi)) if thread else 1.0)
        rings.append(_ring(P(z), u, v, r, 10))
        z += 0.0032 if thread else 0.02
    rings.append(_ring(P(end), u, v, 0.0112 if shank_sheared == 0 else 0.0115, 10))
    add(loft(rings, False, True))
    if with_nut and shank_sheared == 0:
        n0 = grip + 0.004
        add(loft([_ring(P(n0), u, v, 0.0225, 16), _ring(P(n0 + 0.004), u, v, 0.0225, 16)], True, True))
        nr = [(n0 + 0.004, head_r * 0.80), (n0 + 0.0075, head_r), (n0 + 0.0235, head_r), (n0 + 0.0275, head_r * 0.80)]
        add(loft([_ring(P(d), u, v, r, 6, rot0 + 0.4) for d, r in nr], True, True))
    verts, tris, off = [], [], 0
    for vv, tt in parts:
        vol = np.einsum('ij,ij->i', vv[tt[:, 0]], np.cross(vv[tt[:, 1]], vv[tt[:, 2]])).sum()
        if vol < 0:
            tt = tt[:, ::-1]
        verts.append(vv)
        tris.append(tt + off)
        off += len(vv)
    return np.concatenate(verts).astype(np.float32), np.concatenate(tris).astype(np.int32)


def weld_path_radius(n, seed, base=0.0045):
    """Radius modulation along a weld bead: ripple pattern with starts and stops."""
    rng = np.random.default_rng(seed)
    t = np.linspace(0, 1, n)
    return base * (0.85 + 0.15 * np.sin(t * 2 * math.pi * 9 + rng.uniform(0, 6))) * (0.6 + 0.4 * np.sin(np.pi * t) ** 0.4)
