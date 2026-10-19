"""Armour sheets (smooth rounded shells), welded seams, ribs and mechanical internals for the Baymax kit."""
import math

import numpy as np

import kit
from kit import (Mesh, TAU, SEED, thicken, solid, cylinder, sweep, lathe, fbm, vnoise, smoothstep, grid_mesh, clip_mesh,
                 box_uv_corners, rot)


# ------------------------------------------------------------------ helpers
def axis(lo, hi, base, fine=None, zones=()):
    """Non-uniform parameter axis: step `fine` inside the (a, b) zones, `base` elsewhere."""
    out, x = [lo], lo
    while x < hi - 1e-9:
        step = fine if (fine and any(a <= x <= b for a, b in zones)) else base
        x = min(x + step, hi)
        out.append(x)
    return np.array(out)


def unit(v):
    v = np.asarray(v, float)
    return v / (np.linalg.norm(v, axis=-1, keepdims=True) + 1e-12)


def numeric_normal(f, s, t, centre_fn):
    e = 1e-4
    ds = f(s + e, t) - f(s - e, t)
    dt = f(s, t + e) - f(s, t - e)
    n = np.cross(ds, dt)
    ln = np.linalg.norm(n, axis=-1, keepdims=True)
    P = f(s, t)
    fall = unit(P - centre_fn(P))
    ok = ln > 1e-9
    n = n / (ln + 1e-30)
    sgn = np.sign(np.median(np.einsum('ij,ij->i', n[ok[:, 0]], fall[ok[:, 0]])))
    n = n * (sgn if sgn != 0 else 1.0)
    return np.where(ok, n, fall)


def weld_mesh(m, tol=3e-4):
    """Merge coincident vertices (closing the periodic seam of a wrapped sheet) and drop the internal
    face pairs that the seam rim leaves behind. Per-corner UVs are kept, so texture seams stay intact."""
    P = m.P.astype(np.float64)
    q = np.round(P / tol).astype(np.int64)
    _, idx, inv = np.unique(q, axis=0, return_index=True, return_inverse=True)
    inv = inv.ravel()
    T = inv[m.T]
    ok = (T[:, 0] != T[:, 1]) & (T[:, 1] != T[:, 2]) & (T[:, 0] != T[:, 2])
    key = np.sort(T, axis=1)
    k = key[:, 0] * 1000003 + key[:, 1]
    k = k * 1000003 + key[:, 2]
    uniq, cinv, cnt = np.unique(k, return_inverse=True, return_counts=True)
    dup = cnt[cinv.ravel()] > 1
    keep = ok & ~dup
    return Mesh(P[idx], T[keep], m.UV[keep], m.mat[keep])


def sheet(f, S, T, keep, deform=None, thick=0.012, mats=('paint', 'inner', 'rim'), centre=None, offset=0.0, uvmode='param', weld=True):
    """Clip a parametric surface f(s, t) with keep(s, t, P) > 0, deform it, and thicken it inward.

    keep is a metric-ish signed field (metres, > 0 inside)."""
    centre = centre or (lambda P: np.zeros_like(P))
    pts, uv, Tri = grid_mesh(S, T, lambda U, V: f(U, V))
    pts, uv, Tri = clip_mesh(pts, uv, Tri, keep(uv[:, 0], uv[:, 1], pts))
    s, t = uv[:, 0], uv[:, 1]
    n = numeric_normal(f, s, t, centre)
    P = f(s, t) + n * offset
    if deform is not None:
        P = deform(P, s, t, n)
    a, b, c = P[Tri[:, 0]], P[Tri[:, 1]], P[Tri[:, 2]]
    flip = np.einsum('ij,ij->i', np.cross(b - a, c - a), n[Tri].mean(axis=1)) < 0
    Tri = Tri.copy()
    Tri[flip] = Tri[flip][:, ::-1]
    th = thick(s, t) if callable(thick) else thick
    m = thicken(P, uv, Tri, th, mats=mats, uv_mode=uvmode, normals=n)
    return weld_mesh(m) if weld else m


# ------------------------------------------------------------------ damage vocabulary
def jag(P, amp=0.03, seed=0, f1=7.0, f2=15.0):
    """Angular tear-edge perturbation (metres): broad wander plus sharp shard teeth."""
    a = fbm(P[:, 0] * f1, P[:, 1] * f1, P[:, 2] * f1, 3, seed=SEED + seed)
    b = 1.0 - 2.0 * np.abs(fbm(P[:, 0] * f2, P[:, 1] * f2, P[:, 2] * f2, 2, seed=SEED + seed + 5))
    return amp * (0.85 * a + 0.30 * b)


def lip_deform(m_fn, amp=0.02, width=0.07, seed=0):
    """Sheet-metal curl along a torn edge: lifts the edge in/out with a noisy sign."""
    def d(P, s, t, n):
        m = m_fn(s, t, P)
        lip = smoothstep(width, 0.0, m)
        sg = np.sign(fbm(P[:, 0] * 9, P[:, 1] * 9, P[:, 2] * 9, 2, seed=SEED + seed + 30) + 0.05)
        off = sg * amp * (0.4 + 0.6 * vnoise(P[:, 0] * 14, P[:, 1] * 14, P[:, 2] * 14, SEED + seed + 31)) * lip
        return P + n * off[:, None]
    return d


def dents(P, n, items):
    """Impact dents: items = [(centre(3), radius, depth)] -> displaced points (pit with a slightly raised crumple rim)."""
    out = P.copy()
    for c, R, dep in items:
        d = np.linalg.norm(P - np.asarray(c), axis=1) / R
        prof = np.exp(-(d * 1.6) ** 2) - 0.35 * np.exp(-((d - 1.1) * 3.0) ** 2)
        out = out - n * (dep * prof)[:, None]
    return out


# ------------------------------------------------------------------ interior structure
def stringer_band(f, keep, fixed, along, lo, hi, depth, step=0.02, thick=0.007, centre=None, mat='liner', hole=None):
    """A frame rib standing inside a shell: fixed = ('s'|'t', value). Cut by the shell's own keep field."""
    centre = centre or (lambda P: np.zeros_like(P))
    ax = axis(lo, hi, step)
    dv = np.linspace(0.012, depth, 4)

    def g(U, V):
        s = U if along == 's' else np.full_like(U, fixed)
        t = U if along == 't' else np.full_like(U, fixed)
        n = numeric_normal(f, s, t, centre)
        return f(s, t) - n * V[:, None]
    pts, uv, T = grid_mesh(ax, dv, lambda U, V: g(U, V))

    def mk(U, V, P):
        s = U if along == 's' else np.full_like(U, fixed)
        t = U if along == 't' else np.full_like(U, fixed)
        k = keep(s, t, f(s, t)) - 0.02
        k = np.minimum(k, (depth - V) * 4.0 + 0.0 * k) if False else k
        if hole is not None:
            k = np.minimum(k, hole(U, V))
        return k
    pts, uv, T = clip_mesh(pts, uv, T, mk(uv[:, 0], uv[:, 1], pts))
    s = uv[:, 0] if along == 's' else np.full(len(uv), fixed)
    t = uv[:, 0] if along == 't' else np.full(len(uv), fixed)
    n = numeric_normal(f, s, t, centre)
    P = f(s, t) - n * uv[:, 1:2]
    ref = np.cross((f(s + 1e-3, t) - f(s - 1e-3, t)) if along == 's' else (f(s, t + 1e-3) - f(s, t - 1e-3)), n)
    a, b, c = P[T[:, 0]], P[T[:, 1]], P[T[:, 2]]
    flip = np.einsum('ij,ij->i', np.cross(b - a, c - a), ref[T].mean(axis=1)) < 0
    T = T.copy()
    T[flip] = T[flip][:, ::-1]
    return thicken(P, np.zeros((len(P), 2)), T, thick, mats=(mat, mat, 'rim'), uv_mode='box')


# ------------------------------------------------------------------ mechanical vocabulary
def align_to(axis_vec):
    z = np.array([0, 0, 1.0])
    a = unit(axis_vec)
    c = float(np.dot(z, a))
    if c > 0.99999:
        return np.eye(3)
    if c < -0.99999:
        return rot([1, 0, 0], math.pi)
    return rot(np.cross(z, a), math.acos(c))


def lathe_part(profile, origin, axis_vec, mat, n=48, tile=0.25, scale=1.0):
    """Revolve an (r, z) profile about z, then orient the z axis along axis_vec at origin."""
    prof = np.asarray(profile, float) * scale
    m = lathe(prof, n=n, mat=mat, tile=tile)
    return m.transformed(R=align_to(axis_vec), t=origin)


def ring_profile(r_in, r_out, z0, z1, ch=0.004):
    """Closed chamfered ring section (r, z), outward winding for the lathe."""
    return [(r_in, z0), (r_out - ch, z0), (r_out, z0 + ch), (r_out, z1 - ch), (r_out - ch, z1), (r_in, z1), (r_in, z0)]


def bolt_ring(origin, axis_vec, radius, z, count, r_bolt=0.009, h=0.008, mat='steel', phase=0.0):
    R = align_to(axis_vec)
    out = []
    for k in range(count):
        a = phase + TAU * k / count
        c = origin + R @ np.array([radius * math.cos(a), radius * math.sin(a), z])
        out.append(cylinder(c, c + R @ np.array([0, 0, h]), r_bolt, n=8, mat=mat, r1=r_bolt * 0.88, tile=0.1))
    return out


def hub_assembly(origin, axis_vec, scale=1.0, length=0.2, lens=True, tag=0):
    """A joint hub: layered bearing rings, flange with bolts, ribbed collar, shaft and optional blue lens.

    The stack runs along +axis from `origin`. Dimensions are authored for scale 1 (outer radius 0.15 m)."""
    parts = []
    s = scale
    o = np.asarray(origin, float)
    ax = unit(axis_vec)
    L = length * s
    # outer bearing ring (gunmetal) with chamfers and a grooved band
    pr = [(0.04, 0.0), (0.150, 0.0), (0.156, 0.006), (0.156, 0.050), (0.148, 0.056), (0.148, 0.064), (0.156, 0.070), (0.156, 0.090), (0.150, 0.098),
          (0.12, 0.098), (0.12, 0.080), (0.04, 0.080), (0.04, 0.0)]
    parts.append(lathe_part(pr, o, ax, 'gunmetal', n=56, scale=s))
    # steel race inside
    pr2 = [(0.06, 0.07), (0.115, 0.07), (0.115, 0.12), (0.108, 0.126), (0.07, 0.126), (0.06, 0.07)]
    parts.append(lathe_part(pr2, o, ax, 'steel', n=48, scale=s))
    # red accent band (anodised ring)
    pr3 = [(0.1, 0.118), (0.138, 0.118), (0.138, 0.131), (0.1, 0.131), (0.1, 0.118)]
    parts.append(lathe_part(pr3, o, ax, 'cable_red', n=48, scale=s))
    # ribbed collar
    rib = []
    for k in range(7):
        z0 = 0.132 + k * 0.011
        rib += ring_profile(0.05, 0.088 - 0.002 * k, z0, z0 + 0.007, 0.002)
    for k in range(7):
        z0 = 0.132 + k * 0.011
        parts.append(lathe_part(ring_profile(0.05, 0.088 - 0.002 * k, z0, z0 + 0.007, 0.002), o, ax, 'gunmetal' if k % 2 == 0 else 'steel', n=40, scale=s))
    # shaft
    parts.append(lathe_part([(0.0, 0.0), (0.045, 0.0), (0.045, L / s), (0.0, L / s), (0.0, 0.0)], o + ax * 0.0, ax, 'steel', n=28, scale=s))
    if lens:
        zl = 0.132 + 7 * 0.011
        parts.append(lathe_part([(0.0, zl), (0.062, zl), (0.062, zl + 0.012), (0.05, zl + 0.034), (0.0, zl + 0.040), (0.0, zl)], o, ax, 'lens_blue', n=36, scale=s))
        parts.append(lathe_part(ring_profile(0.062, 0.078, zl - 0.004, zl + 0.022, 0.004), o, ax, 'gunmetal', n=40, scale=s))
    parts += bolt_ring(o, ax, 0.134 * s, 0.098 * s, 10, r_bolt=0.0075 * s, h=0.008 * s, phase=0.2 + tag)
    return parts


def cable(path, r=0.012, mat='cable_black', n=8, smooth=3):
    """Smooth tube along a polyline: Catmull-Rom resampled, with ferrule collars at both ends."""
    P = np.asarray(path, float)
    for _ in range(smooth):
        Q = [P[0]]
        for i in range(len(P) - 1):
            Q += [0.75 * P[i] + 0.25 * P[i + 1], 0.25 * P[i] + 0.75 * P[i + 1]]
        Q.append(P[-1])
        P = np.array(Q)
    out = [sweep(P, r, n=n, mat=mat, tile=0.1)]
    for e, d in ((0, 1), (len(P) - 1, len(P) - 2)):
        a = P[e]
        v = unit(P[d] - P[e])
        out.append(cylinder(a - v * 0.004, a + v * 0.034, r * 1.45, n=10, mat='steel', tile=0.1))
    return out


def piston(p0, p1, r=0.02, mat_sleeve='gunmetal'):
    p0, p1 = np.asarray(p0, float), np.asarray(p1, float)
    v = p1 - p0
    mid = p0 + v * 0.45
    return [cylinder(p0, mid, r * 1.25, n=20, mat=mat_sleeve, tile=0.15), cylinder(mid, p1, r * 0.55, n=14, mat='steel', tile=0.15),
            cylinder(p0 + v * 0.30, p0 + v * 0.36, r * 1.5, n=20, mat='cable_red', tile=0.15)]


def droop_cable(p0, p1, sag=0.08, r=0.011, mat='cable_black', wob=0.02, seed=0):
    """Cable hanging between two points with gravity-free slack: a bowed spline."""
    p0, p1 = np.asarray(p0, float), np.asarray(p1, float)
    pts = []
    for k in range(6):
        u = k / 5
        p = p0 + (p1 - p0) * u
        p = p + np.array([0, 0, -sag]) * math.sin(math.pi * u) + wob * np.array([math.sin(3 * u + seed), math.cos(2 * u + seed), 0.0]) * math.sin(math.pi * u)
        pts.append(p)
    return cable(pts, r, mat)


def ball_joint(origin, r=0.13, mat='steel'):
    prof = [(0.0, -r)] + [(r * math.sin(a), -r * math.cos(a)) for a in np.linspace(0.12, math.pi - 0.12, 20)] + [(0.0, r)]
    return lathe_part(prof[::-1], np.asarray(origin, float), [0, 0, 1], mat, n=40)
