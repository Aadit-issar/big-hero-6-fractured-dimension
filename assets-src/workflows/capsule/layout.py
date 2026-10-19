"""Shared parametric layout of the capsule: panel rows, windows, hatches, ports and the impact breach.

All positions are in the shell parameter space (theta rad, s metres along the meridian), so geometry and the
painted texture atlases agree exactly.  Azimuth plan (Blender z-up; glTF front view looks at theta = -pi/2):
  main window  -pi/2 (front)        breach   0 (+x, faces the gallery 'side' and the right of the hero view)
  rear engine bay  +pi/2 (rear)     crew hatch  pi (-x)
"""
import math

import numpy as np

import kit
from kit import TAU, S_E, S_B0, STOT, r_of, z_of, fbm, vnoise, smoothstep, wrap_angle, hash01, worley2

SEED = kit.SEED
TH_F = -math.pi / 2
TH_B = 0.0
TH_REAR = math.pi / 2
TH_HATCH = math.pi

# ---- panel layout (backshell) ----------------------------------------------------------------------
ROW_EDGES = [S_B0, S_B0 + 0.40, S_B0 + 0.80, S_B0 + 1.16, S_B0 + 1.50, S_B0 + 1.80, STOT - 0.06]
ROW_GORES = [24, 24, 20, 18, 16, 12]
ROW_OFF = [0.0, 0.5, 0.25, 0.0, 0.5, 0.0]
# heat-shield ablator blocks: rows of constant s, block counts
HS_ROWS = [0.0, 0.55, 1.05, 1.45, 1.80, 2.10, S_E + 0.01]
HS_COUNT = [1, 8, 16, 24, 30, 36]


def panel_ids(th, s):
    """Row index, gore index, distance to nearest vertical seam (m), distance to nearest row seam (m)."""
    th = np.mod(th, TAU)
    row = np.clip(np.searchsorted(ROW_EDGES, s, side='right') - 1, 0, len(ROW_GORES) - 1)
    G = np.array(ROW_GORES)[row]
    off = np.array(ROW_OFF)[row]
    ph = th / TAU * G - off
    gi = np.floor(ph).astype(int) % G
    f = ph - np.floor(ph)
    dv = np.minimum(f, 1 - f) * TAU / G * r_of(s)
    dh = np.min([np.abs(s - e) for e in ROW_EDGES], axis=0)
    return row, gi, dv, dh


# ---- windows ---------------------------------------------------------------------------------------
S_WIN = kit.s_at_z(1.72)


def rounded_poly(poly, rad, n=6):
    """Rounded convex polygon (CCW), corner radius rad (scalar or per corner)."""
    poly = np.asarray(poly, float)
    k = len(poly)
    rads = np.broadcast_to(np.asarray(rad, float), (k,))
    out = []
    for i in range(k):
        a, b, c = poly[i - 1], poly[i], poly[(i + 1) % k]
        d1 = (a - b) / np.linalg.norm(a - b)
        d2 = (c - b) / np.linalg.norm(c - b)
        ang = math.acos(np.clip(np.dot(d1, d2), -1, 1))
        t = rads[i] / math.tan(ang / 2)
        bis = (d1 + d2) / np.linalg.norm(d1 + d2)
        cen = b + bis * (rads[i] / math.sin(ang / 2))
        p1, p2 = b + d1 * t, b + d2 * t
        a1 = math.atan2(*(p1 - cen)[::-1])
        a2 = math.atan2(*(p2 - cen)[::-1])
        da = (a2 - a1 + math.pi) % TAU - math.pi
        for j in range(n + 1):
            aa = a1 + da * j / n
            out.append(cen + rads[i] * np.array([math.cos(aa), math.sin(aa)]))
    return np.array(out)


MAIN_WIN = rounded_poly([(-0.47, -0.25), (0.47, -0.25), (0.40, 0.22), (-0.40, 0.22)], [0.07, 0.07, 0.10, 0.10])
SIDE_WIN = rounded_poly([(-0.13, -0.24), (0.13, -0.24), (0.11, 0.20), (-0.11, 0.20)], [0.05, 0.05, 0.06, 0.06])
TOP_WIN = rounded_poly([(-0.10, -0.08), (0.10, -0.08), (0.09, 0.08), (-0.09, 0.08)], 0.035)
WINDOWS = [
    ('main', TH_F, S_WIN, MAIN_WIN),
    ('side_r', TH_F + 0.64, S_WIN - 0.04, SIDE_WIN),
    ('side_l', TH_F - 0.64, S_WIN - 0.04, SIDE_WIN),
    ('top_r', TH_F + 0.42, STOT - 0.36, TOP_WIN),
    ('top_l', TH_F - 0.42, STOT - 0.36, TOP_WIN),
]

# ---- hatches, housings and ports ---------------------------------------------------------------------
# flush access panels (texture + slight geometry): (name, theta, s, w, h)
ACCESS = [
    ('a1', TH_F + 1.02, S_B0 + 0.22, 0.30, 0.20), ('a2', TH_F - 1.05, S_B0 + 0.28, 0.36, 0.22),
    ('a3', TH_HATCH + 0.62, S_B0 + 0.95, 0.26, 0.26), ('a4', TH_REAR + 0.55, S_B0 + 1.15, 0.30, 0.20),
    ('a5', TH_F + 0.30, S_B0 + 0.25, 0.22, 0.16), ('a6', TH_HATCH - 0.75, S_B0 + 0.30, 0.40, 0.24),
    ('a7', TH_REAR - 0.95, S_B0 + 1.40, 0.24, 0.18), ('a8', 0.62, S_B0 + 1.30, 0.28, 0.20),
    ('a9', TH_F - 0.20, STOT - 0.62, 0.20, 0.14), ('a10', TH_REAR + 0.15, STOT - 0.55, 0.26, 0.16),
]
HATCH = ('crew', TH_HATCH, S_B0 + 0.86, 0.78, 0.86)          # crew side hatch (raised frame, hinges, porthole)
ENGINE_BAY = (TH_REAR, S_B0 + 0.40, 1.30, 0.58)              # rear housing with three nozzles
HOUSINGS = [('box_l', TH_REAR - 0.78, S_B0 + 0.95, 0.24, 0.42), ('box_r', TH_REAR + 0.78, S_B0 + 0.95, 0.24, 0.42),
            ('box_f', TH_F + 1.30, S_B0 + 0.62, 0.30, 0.22)]
RCS = [(-0.62, S_B0 + 1.20), (TH_F - 1.12, S_B0 + 1.28), (0.95, S_B0 + 0.72), (TH_HATCH + 0.85, S_B0 + 1.42),
       (TH_REAR - 0.30, STOT - 0.30), (TH_F + 1.20, STOT - 0.28)]
VENTS = [(TH_F + 0.95, S_B0 + 1.42, 0.14, 0.07), (TH_HATCH - 0.62, S_B0 + 1.20, 0.16, 0.08), (TH_REAR - 0.62, S_B0 + 0.30, 0.18, 0.08),
         (1.25, S_B0 + 0.32, 0.14, 0.07)]
CAMERA_PORT = (TH_F + 0.98, S_WIN - 0.02)                    # replaces the old grey placeholder disc
RAILS = [(TH_HATCH - 0.36, S_B0 + 0.86, 0.42, 'v'), (TH_HATCH + 0.36, S_B0 + 0.86, 0.42, 'v'), (TH_HATCH, S_B0 + 1.42, 0.40, 'h')]
ID_TEXT = ('RE-01', TH_F + 1.00, S_WIN - 0.30, 0.085)
STENCILS = [  # small generic technical stencils: (text, theta, s, height)
    ('RE-01', TH_HATCH, S_B0 + 1.36 - 0.06, 0.05), ('A-07', TH_F + 1.02, S_B0 + 0.36, 0.026), ('H2O', TH_REAR - 0.95, S_B0 + 1.52, 0.024),
    ('N2 - 3000', TH_REAR + 0.55, S_B0 + 1.29, 0.022), ('NO STEP', TH_F - 0.95, S_B0 + 0.48, 0.03), ('C-12', 0.62, S_B0 + 1.43, 0.024),
    ('RCS 4', -0.62, S_B0 + 1.33, 0.022), ('RCS 2', 0.95, S_B0 + 0.85, 0.022), ('A-03', TH_HATCH - 0.75, S_B0 + 0.46, 0.026),
    ('RESCUE', TH_HATCH, S_B0 + 0.33, 0.04),
]


def rect_sdf(th, s, th0, s0, w, h, rad=0.015):
    x = np.abs(wrap_angle(np.asarray(th) - th0) * r_of(np.clip(s, 0.2, STOT))) - (w / 2 - rad)
    y = np.abs(np.asarray(s) - s0) - (h / 2 - rad)
    return np.hypot(np.maximum(x, 0), np.maximum(y, 0)) + np.minimum(np.maximum(x, y), 0) - rad


def poly_sdf(px, py, poly):
    """Signed distance (m) to a convex CCW polygon: negative inside."""
    px, py = np.asarray(px, float), np.asarray(py, float)
    n = len(poly)
    d = np.full(px.shape, 1e9)
    inside = np.ones(px.shape, bool)
    for i in range(n):
        a, b = poly[i], poly[(i + 1) % n]
        e = b - a
        wx, wy = px - a[0], py - a[1]
        t = np.clip((wx * e[0] + wy * e[1]) / np.dot(e, e), 0, 1)
        d = np.minimum(d, np.hypot(wx - t * e[0], wy - t * e[1]))
        inside &= (e[0] * wy - e[1] * wx) >= 0
    return np.where(inside, -d, d)


def local_xy(th, s, th0, s0):
    return wrap_angle(np.asarray(th) - th0) * r_of(np.clip(s, 0.05, STOT)), np.asarray(s) - s0


def window_sdf(win, th, s):
    name, th0, s0, poly = win
    x, y = local_xy(th, s, th0, s0)
    return poly_sdf(x, y, poly)


def windows_sdf(th, s):
    d = np.full(np.shape(th), 9.0)
    for w in WINDOWS:
        d = np.minimum(d, window_sdf(w, th, s))
    return d


# ---- breach --------------------------------------------------------------------------------------
S_BC = S_E + 0.10          # breach centre station (straddles the heat-shield lip)
B_AX, B_AY = 0.66, 0.50    # half extents (m)


def _bxy(th, s):
    return local_xy(th, s, TH_B, S_BC)


def _breach_f(x, y):
    """Smooth implicit: > 0 in material, 0 at the large-scale tear line, roughly metres near the edge."""
    phi = np.arctan2(y / B_AY, x / B_AX)
    rr = np.hypot(x / B_AX, y / B_AY)
    lobe = 1.0 + (0.16 * np.cos(2 * phi - 0.7) + 0.10 * np.cos(3 * phi + 1.9) + 0.06 * np.cos(5 * phi + 0.4)) * smoothstep(0.0, 0.6, rr)
    wob = 0.22 * fbm(x * 1.7 + 4.0, y * 1.7 - 2.0, None, 3, seed=SEED + 301)
    return (rr - lobe * (1 + wob)) * 0.55


def breach_D(th, s, eps=0.004):
    """Approximate signed distance (m) to the smooth outer tear line (positive = material) and its gradient
    direction in local (x, y) metres."""
    x, y = _bxy(th, s)
    f = _breach_f(x, y)
    fx = (_breach_f(x + eps, y) - _breach_f(x - eps, y)) / (2 * eps)
    fy = (_breach_f(x, y + eps) - _breach_f(x, y - eps)) / (2 * eps)
    g = np.hypot(fx, fy) + 1e-9
    return f / np.clip(g, 0.35, 1.6), fx / g, fy / g


# petals: tear slits radiate from the hole at these polar angles; each sector between two slits is a petal
SLIT_PHI = np.array([0.30, 1.15, 1.95, 2.75, 3.60, 4.60, 5.45])
SLIT_LEN = np.array([0.30, 0.22, 0.34, 0.20, 0.28, 0.18, 0.26])


def breach_polar(th, s):
    x, y = _bxy(th, s)
    return np.mod(np.arctan2(y / B_AY, x / B_AX), TAU), x, y


def petal_index(phi):
    k = np.searchsorted(SLIT_PHI, phi) % len(SLIT_PHI)
    return k


def fray(th, s, amp=0.016, freq=14.0, seed=0):
    x, y = _bxy(th, s)
    return amp * fbm(x * freq, y * freq, None, 3, seed=SEED + 330 + seed) + amp * 0.3 * fbm(x * freq * 3.1, y * freq * 3.1, None, 2, seed=SEED + 340 + seed)


def slit_cut(th, s, D, width=0.016):
    """> 0 where a radial tear slit removes skin."""
    phi, x, y = breach_polar(th, s)
    rad = np.hypot(x, y)
    out = np.full(np.shape(D), -1.0)
    for k, (p, L) in enumerate(zip(SLIT_PHI, SLIT_LEN)):
        dphi = wrap_angle(phi - p - 0.06 * np.sin(D * 30 + k))
        lat = np.abs(dphi) * rad
        w = width * np.clip(1 - D / L, 0, 1) + 0.0015
        out = np.maximum(out, np.where(D < L, w - lat, -1.0))
    return out


def skin_keep(th, s):
    D, _, _ = breach_D(th, s)
    k = D + fray(th, s)
    k = np.minimum(k, -slit_cut(th, s, D))
    return k


def ablator_keep(th, s):
    """Ablator breaks back further than the skin, in irregular rounded bites (continuous field, no cell steps)."""
    D, _, _ = breach_D(th, s)
    x, y = _bxy(th, s)
    bite = 0.07 * fbm(x * 4.5 + 7, y * 4.5, None, 3, seed=SEED + 351)
    chip = 0.018 * fbm(x * 16, y * 16, None, 2, seed=SEED + 352)
    return D - 0.05 + bite + chip


def insulation_keep(th, s):
    D, _, _ = breach_D(th, s)
    return D + 0.055 + 0.035 * fbm(*[v * 9 for v in _bxy(th, s)], None, 3, seed=SEED + 361) + fray(th, s, 0.012, 55, 5)


def pwall_keep(th, s):
    D, _, _ = breach_D(th, s)
    return D + 0.15 + 0.05 * fbm(*[v * 5 for v in _bxy(th, s)], None, 3, seed=SEED + 371) + fray(th, s, 0.008, 34, 7)


def scorch(th, s):
    """0..1 soot / heat field around the breach."""
    D, _, _ = breach_D(th, s)
    return smoothstep(0.75, -0.02, D)


# ---- heat-shield spalls (missing ablator chunks away from the breach) and a long crack ---------------------
SPALLS = [(2.35, 2.30, 0.13, 0.09), (-2.2, 2.25, 0.10, 0.08), (1.25, 2.38, 0.08, 0.06), (-0.9, 2.05, 0.09, 0.07), (3.6, 2.15, 0.12, 0.08)]
CRACK = (0.70, 1.62, 2.46)      # theta, s0 -> s1 : a split between two blocks running up to the lip


def spall_keep(th, s):
    k = np.full(np.shape(th), 1.0)
    for i, (t0, s0, a, b) in enumerate(SPALLS):
        x, y = local_xy(th, s, t0, s0)
        rr = np.hypot(x / a, y / b)
        k = np.minimum(k, (rr - 1 - 0.25 * fbm(x * 18 + i, y * 18, None, 3, seed=SEED + 380 + i)) * min(a, b))
    x, y = local_xy(th, s, CRACK[0], 0.0)
    xc = x - 0.06 * np.sin(y * 7.0) - 0.02 * fbm(y * 9, 0 * y, None, 2, seed=SEED + 390)
    w = 0.006 * smoothstep(CRACK[1], CRACK[1] + 0.3, s) * smoothstep(CRACK[2] + 0.02, CRACK[2] - 0.15, s) + 0.0015
    in_rng = (s > CRACK[1]) & (s < CRACK[2])
    k = np.minimum(k, np.where(in_rng, np.abs(xc) - w, 1.0))
    return k


def dents(th, s):
    """Inward displacement (m) of the backshell / heat shield from impact and handling dents."""
    D, _, _ = breach_D(th, s)
    d = 0.045 * smoothstep(0.65, 0.0, D)
    for t0, s0, a, depth in ((0.55, S_B0 + 1.15, 0.22, 0.016), (-0.45, S_B0 + 0.55, 0.30, 0.012), (2.6, S_B0 + 0.55, 0.25, 0.010),
                             (TH_REAR + 0.95, S_B0 + 1.55, 0.18, 0.008)):
        x, y = local_xy(th, s, t0, s0)
        d = d + depth * np.exp(-(x * x + y * y) / (a * a))
    # a crease running away from the breach
    x, y = local_xy(th, s, TH_B + 0.45, S_BC + 0.35)
    u, v = x * 0.8 + y * 0.6, -x * 0.6 + y * 0.8
    d = d + 0.010 * np.exp(-(v / 0.03) ** 2) * smoothstep(0.55, 0.0, np.abs(u))
    return d
