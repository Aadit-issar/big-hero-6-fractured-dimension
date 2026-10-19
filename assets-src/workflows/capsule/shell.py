"""Capsule shell sheets: ablator heat shield, backshell skin, insulation blanket, pressure wall, stringers and frames.

Every sheet is triangulated adaptively in a conformal plane of the (theta, s) parameter space, clipped against an
implicit tear field, displaced (dents, curled petals) and thickened.  The breach is layered:
  outer skin (5 mm, petals peeled outward) -> insulation blanket (36 mm, frayed) between hat stringers ->
  pressure wall (6 mm, isogrid outside, punched inward) -> internal ring frames -> equipment.
"""
import math

import numpy as np

import kit
import layout as L
from kit import (Mesh, TAU, SEED, S_E, S_B0, STOT, T_ABL, r_of, z_of, surf, surf_frame, thicken, fbm, vnoise, smoothstep,
                 clip_mesh, wrap_angle, hash01, PlanarMap, adaptive_sheet)

PM_HS = PlanarMap(0.0, S_E, pole=True)
PM_WALL = PlanarMap(S_B0, STOT)
PM_ALL = PlanarMap(0.0, STOT - 0.015, pole=True)

PW_OFF_HS = T_ABL + 0.006     # pressure-wall outer face under the ablator
PW_OFF_W = 0.050              # under the backshell skin (skin 5 mm + stringer/insulation gap)
PW_T = 0.006
SKIN_T = 0.005


# ------------------------------------------------------------------ atlas uv
ATLAS_PAD = 0.03
HS_SPLIT = 1.60                # s below this gets 25% of the heat-shield atlas rows


def wall_v(s):
    return (np.asarray(s) - S_B0) / (STOT - S_B0)


def hs_v(s):
    s = np.asarray(s, float)
    return np.where(s < HS_SPLIT, 0.25 * s / HS_SPLIT, 0.25 + 0.75 * (s - HS_SPLIT) / (S_E - HS_SPLIT))


def hs_s_of_v(v):
    v = np.asarray(v, float)
    return np.where(v < 0.25, v / 0.25 * HS_SPLIT, HS_SPLIT + (v - 0.25) / 0.75 * (S_E - HS_SPLIT))


def atlas_corner_uv(th, s, T, vfun):
    """Per-corner uvs into a two-half (theta in [0,pi] | [pi,2pi]) atlas; halves are stacked in v."""
    t3 = th[T]
    t3 = t3[:, :1] + wrap_angle(t3 - t3[:, :1])
    tc = np.mod(t3.mean(1), TAU)
    h = (tc >= math.pi).astype(int)
    lo = h * math.pi
    t3 = t3 - np.floor((t3.mean(1, keepdims=True) - lo[:, None] + math.pi) / TAU) * TAU * 0
    t3 = np.where(t3 - lo[:, None] < -math.pi, t3 + TAU, t3)
    t3 = np.where(t3 - lo[:, None] > TAU - 0.5, t3 - TAU, t3)
    u = (t3 - (lo[:, None] - ATLAS_PAD)) / (math.pi + 2 * ATLAS_PAD)
    v = np.clip(vfun(s[T]), 0.0, 1.0)
    v = 0.5 * (1 - h[:, None]) + 0.004 + v * (0.5 - 0.008)
    return np.stack([u, v], -1)


# ------------------------------------------------------------------ generic sheet
def sheet(pm, h_fn, keep_fn, h_max=0.4):
    """Adaptive parameter-space triangulation clipped at keep_fn = 0. Returns theta, s, tris."""
    th, s, T = adaptive_sheet(pm, h_fn, h_max)
    T = T[:, ::-1].copy()          # plane CCW maps to inward normals; flip to outward
    XY = pm.to_plane(th, s)
    if keep_fn is not None:
        XY, T = kit.clip_clean(XY, T, keep_fn(th, s))
        th, s = pm.from_plane(XY)
        s = np.clip(s, pm.s_lo, pm.s_hi)
    return th, s, T


def pnormals(posfn, th, s, eps=0.003):
    """Normals of a displaced parametric sheet by central differences (independent of the triangulation)."""
    r = np.maximum(r_of(s), 0.05)
    dt = eps / r
    a = posfn(th + dt, s) - posfn(th - dt, s)
    b = posfn(th, s + eps) - posfn(th, s - eps)
    n = np.cross(a, b)
    ln = np.linalg.norm(n, axis=1, keepdims=True)
    an = surf_frame(th, s)[1]
    n = np.where(ln > 1e-12, n / np.maximum(ln, 1e-12), an)
    return np.where((r_of(s) < 0.03)[:, None], an, n)


def grade(d, hmin, h0, k=0.12, k2=0.35, d0=0.3):
    d = np.abs(d)
    return np.minimum(h0, np.where(d < d0, hmin + k * d, hmin + k * d0 + k2 * (d - d0)))


# ------------------------------------------------------------------ petals
PETAL_A = np.array([110, 70, 135, 55, 95, -40, 80], float)   # curl angle (deg), negative = pushed in
PETAL_L = np.array([0.26, 0.17, 0.30, 0.15, 0.24, 0.16, 0.20])


def _petal_params(phi):
    """Smoothly blended per-petal curl angle (rad) and hinge length (m) as functions of the breach polar angle."""
    n = len(L.SLIT_PHI)
    k = L.petal_index(phi)
    a = np.radians(PETAL_A)[k]
    lc = PETAL_L[k]
    # blend towards the neighbour near each slit (continuity beyond the slit tip)
    for j in range(n):
        p = L.SLIT_PHI[j]
        d = wrap_angle(phi - p)
        w = 0.5 * smoothstep(0.09, 0.0, np.abs(d))
        left, right = j, (j + 1) % n
        avg_a = 0.5 * (np.radians(PETAL_A[left]) + np.radians(PETAL_A[right]))
        avg_l = 0.5 * (PETAL_L[left] + PETAL_L[right])
        a = a * (1 - w) + avg_a * w
        lc = lc * (1 - w) + avg_l * w
    return a, lc


def curl(D, alpha, lc, steps=20):
    """Bend a sheet around a hinge at distance lc from the tear: returns (normal lift, pull-back) for points at D."""
    u = np.clip(lc - D, 0.0, lc * 1.25)
    dn = np.zeros_like(u)
    dt = np.zeros_like(u)
    for i in range(steps):
        t0 = u * i / steps
        t1 = u * (i + 1) / steps
        tm = 0.5 * (t0 + t1)
        a = alpha * np.clip(tm / lc, 0, 1.4) ** 1.35
        dn += np.sin(a) * (t1 - t0)
        dt += (np.cos(a) - 1) * (t1 - t0)
    return dn, dt


def petal_displacement(th, s, scale=1.0, sign=1.0, lc_scale=1.0, D_shift=0.0):
    """3D displacement (N,3) of torn edges: curled petals around the breach."""
    D, gx, gy = L.breach_D(th, s)
    D = D + D_shift
    phi, x, y = L.breach_polar(th, s)
    a, lc = _petal_params(phi)
    lc = lc * lc_scale
    a = a * scale * sign
    _, n, tt, ts = surf_frame(th, s)
    dn, dt = curl(D, np.abs(a), lc)
    dn = dn * np.sign(a)
    g = gx[:, None] * tt + gy[:, None] * ts
    # buckling wrinkles across each petal
    wr = 0.004 * np.sin(phi * 37.0 + 3 * fbm(x * 6, y * 6, None, 2, seed=SEED + 410)) * np.clip((lc - D) / lc, 0, 1)
    return n * (dn + wr)[:, None] - g * dt[:, None]


def dent_displacement(th, s, scale=1.0):
    _, n, _, _ = surf_frame(th, s)
    return -n * (L.dents(th, s) * scale)[:, None]


# ------------------------------------------------------------------ sheets of the hero
def ablator(Q):
    hmin, h0 = Q['hmin'], Q['h_hs']

    def h_fn(th, s):
        base = np.where(s < 1.0, Q['h_bottom'], np.where(s < 1.6, 0.5 * (Q['h_bottom'] + h0), h0))
        k1 = L.ablator_keep(th, s)
        k2 = L.spall_keep(th, s)
        hh = np.minimum(grade(k1, hmin * 1.3, base, 0.15), grade(k2, hmin * 2.2, base, 0.35))
        return np.minimum(hh, grade(L.breach_D(th, s)[0], hmin * 1.5, base, 0.25))
    keep = (lambda th, s: L.ablator_keep(th, s)) if Q['damage'] else None
    th, s, T = sheet(PM_HS, h_fn, keep, Q['h_bottom'])

    def pos(th, s):
        P = surf(th, s) + dent_displacement(th, s, 0.8)
        # spalled ablator: missing chunks are shallow pits, the split is a groove (the structure is never exposed)
        sp = L.spall_keep(th, s)
        n0 = surf_frame(th, s)[1]
        P = P - n0 * (0.032 * smoothstep(0.012, -0.012, sp))[:, None]
        if Q['damage']:      # crushed lip: the ablator near the tear is pushed in a little
            D, _, _ = L.breach_D(th, s)
            _, n, _, _ = surf_frame(th, s)
            x, y = L._bxy(th, s)
            P = P - n * (0.02 * smoothstep(0.25, 0.0, D) * (0.7 + 0.5 * fbm(x * 7, y * 7, None, 2, seed=SEED + 356)))[:, None]
        return P
    P = pos(th, s)
    uv = atlas_corner_uv(th, s, T, hs_v)
    m = thicken(P, T, T_ABL, mats=('hs_outer', 'hs_outer', 'ablator_rim'), uv_outer=uv, rim_tile=0.12,
                inner_keep=(L.breach_D(th, s)[0][T].min(1) < 0.3) if Q['damage'] else np.zeros(len(T), bool), nrm=pnormals(pos, th, s))
    return m


def skin(Q):
    hmin, h0 = Q['hmin'], Q['h0']

    def h_fn(th, s):
        D = L.breach_D(th, s)[0]
        hh = grade(D, hmin, h0, 0.14)
        hh = np.minimum(hh, grade(-L.slit_cut(th, s, D), hmin * 0.8, h0, 0.3))
        hh = np.minimum(hh, grade(L.windows_sdf(th, s), Q['h_win'], h0, 0.2))
        return hh

    def keep(th, s):
        k = L.windows_sdf(th, s)
        if Q['damage']:
            k = np.minimum(k, L.skin_keep(th, s))
        return k
    th, s, T = sheet(PM_WALL, h_fn, keep if Q['windows'] or Q['damage'] else None, Q['h0'] * 2)

    def pos(th, s):
        P = surf(th, s) + dent_displacement(th, s)
        return P + petal_displacement(th, s) if Q['damage'] else P
    P = pos(th, s)
    nrm = pnormals(pos, th, s)
    uv = atlas_corner_uv(th, s, T, wall_v)
    D = L.breach_D(th, s)[0]
    inner = (D[T].min(1) < 0.30) if Q['damage'] else np.zeros(len(T), bool)
    m = thicken(P, T, SKIN_T, mats=('wall_outer', 'skin_back', 'rim_metal'), uv_outer=uv, rim_tile=0.08, inner_keep=inner, inner_tile=0.4, nrm=nrm)
    return m


def _pw_pos(th, s):
    """Pressure-wall outer face: follows the ablator underside, steps across the lip, then the backshell."""
    a = surf(th, np.minimum(s, S_E), -PW_OFF_HS)
    b = surf(th, np.maximum(s, S_B0), -PW_OFF_W)
    t = np.clip((s - S_E) / (S_B0 - S_E), 0, 1)[:, None]
    return np.where(s[:, None] <= S_E, a, np.where(s[:, None] >= S_B0, b, a * (1 - t) + b * t))


def pressure_wall(Q):
    hmin = Q['hmin']

    def h_fn(th, s):
        hh = np.full(np.shape(th), Q['h_pw'])
        if Q['damage']:
            hh = np.minimum(hh, grade(L.pwall_keep(th, s), hmin * 1.6, Q['h_pw'], 0.2, 0.5))
        if Q['windows']:
            hh = np.minimum(hh, grade(L.windows_sdf(th, s) - 0.012, Q['h_win'] * 1.3, Q['h_pw'], 0.3))
        return np.where(s < 1.2, np.maximum(hh, Q['h_pw'] * 1.6), hh)

    def keep(th, s):
        k = np.full(np.shape(th), 1.0)
        if Q['windows']:
            k = np.minimum(k, L.windows_sdf(th, s) - 0.012)
        if Q['damage']:
            k = np.minimum(k, L.pwall_keep(th, s))
        return k
    th, s, T = sheet(PM_ALL, h_fn, keep, Q['h_pw'] * 1.6)

    def pos(th, s):
        P = _pw_pos(th, s) + dent_displacement(th, s, 0.9)
        return P + petal_displacement(th, s, 0.55, -1.0, 0.9, D_shift=0.15) if Q['damage'] else P
    P = pos(th, s)
    nrm = pnormals(pos, th, s)
    D = L.breach_D(th, s)[0]
    T, ok = kit.clean_tris(P, T)
    outer_vis = (D[T].min(1) < 0.25) if Q['damage'] else np.zeros(len(T), bool)
    m = thicken(P, T, PW_T, mats=('pw_outer', 'cabin_wall', 'rim_metal'), rim_tile=0.08, inner_tile=0.5, nrm=nrm)
    keep_t = np.ones(len(m.T), bool)
    keep_t[:len(T)] = outer_vis
    return Mesh(m.P, m.T[keep_t], m.UV[keep_t], m.mat[keep_t])


def insulation(Q):
    hmin = Q['hmin']

    def h_fn(th, s):
        return grade(L.insulation_keep(th, s), hmin * 1.2, 0.08, 0.15, 0.5)

    def keep(th, s):
        D = L.breach_D(th, s)[0]
        return np.minimum(np.minimum(L.insulation_keep(th, s), 0.40 - D), (s - S_B0 - 0.004) * 4)
    th, s, T = sheet(PM_WALL, h_fn, keep, 0.1)
    off = SKIN_T + 0.003

    def pos(th, s):
        P = surf(th, s, -off) + dent_displacement(th, s)
        k = L.insulation_keep(th, s)
        n = surf_frame(th, s)[1]
        # torn blanket edges puff outward and sag
        puff = 0.016 * smoothstep(0.07, 0.0, k) * (0.6 + 0.4 * fbm(th * 30, s * 30, None, 2, seed=SEED + 420))
        return P + n * puff[:, None]
    P = pos(th, s)
    m = thicken(P, T, 0.034, nrm=pnormals(pos, th, s), mats=('insulation', 'insulation', 'insulation_rim'), rim_tile=0.06, inner_keep=np.zeros(len(T), bool), inner_tile=0.25,
                uv_outer=kit.box_uv_corners(P, T, 0.25))
    return m


# ------------------------------------------------------------------ stringers and frames
HAT = np.array([(-0.030, 0.0), (-0.016, 0.0), (-0.010, -0.032), (0.010, -0.032), (0.016, 0.0), (0.030, 0.0)])


def _profile_strip(path, side, up, prof, thick=0.0025):
    """Open sheet-metal section (polyline profile in (side, up)) swept along path; thickened."""
    K, M = len(path), len(prof)
    P = (path[:, None, :] + prof[None, :, 0, None] * side[:, None, :] + prof[None, :, 1, None] * up[:, None, :]).reshape(-1, 3)
    idx = np.arange(K * M).reshape(K, M)
    a, b, c, d = idx[:-1, :-1].ravel(), idx[1:, :-1].ravel(), idx[1:, 1:].ravel(), idx[:-1, 1:].ravel()
    T = np.concatenate([np.stack([a, b, c], 1), np.stack([a, c, d], 1)])
    return P, T


def stringers(Q):
    """Hat-section stringers between skin and pressure wall around the breach, snapped and bent at the tear."""
    parts = []
    r_mid = float(r_of(L.S_BC))
    n_side = 4
    for j in range(-n_side, n_side + 1):
        th0 = L.TH_B + j * 0.19 / r_mid * 1.0 + 0.04
        ss = np.arange(S_B0 + 0.03, min(STOT - 0.25, L.S_BC + 1.1), Q['str_step'])
        th = np.full(len(ss), th0)
        D, gx, gy = L.breach_D(th, ss)
        if D.min() > 0.5:
            continue
        cut = D + 0.035 + 0.05 * (hash01(np.array([j + 50]), seed=SEED + 430)[0] - 0.5) * 2
        good = cut > 0
        # split into runs
        runs = []
        cur = []
        for i, g in enumerate(good):
            if g:
                cur.append(i)
            elif cur:
                runs.append(cur); cur = []
        if cur:
            runs.append(cur)
        for run in runs:
            if len(run) < 3:
                continue
            si = ss[run]
            ti = th[run]
            P0, n, tt, ts = surf_frame(ti, si)
            off = SKIN_T + 0.001
            path = P0 - n * off - n * L.dents(ti, si)[:, None]
            # free end near the tear bends inward and twists
            dcut = cut[run]
            bend = smoothstep(0.16, 0.0, dcut)
            hsh = hash01(np.array([j * 7 + len(run)]), seed=SEED + 431)[0]
            path = path - n * (0.07 * bend ** 2 * (0.5 + hsh))[:, None] + tt * (0.03 * bend ** 2 * (hsh - 0.5))[:, None]
            side = tt
            up = n
            Pp, Tp = _profile_strip(path, side, up, HAT)
            m = thicken(Pp, Tp, 0.0022, mats=('stringer', 'stringer', 'rim_metal'), rim_tile=0.05)
            parts.append(m)
    return parts


def ring_frame(z_station, depth, Q, tag=0, flange=0.035, holes=True):
    """Channel ring frame inside the pressure wall: web with lightening holes + inner flange, torn at the breach."""
    if z_station < 1.0:
        s0 = float(np.interp(z_station, kit.PZ[:int(np.argmax(kit.PR))], kit.PS[:int(np.argmax(kit.PR))]))
    else:
        s0 = kit.s_at_z(z_station)
    off = PW_OFF_W + PW_T if s0 > S_B0 else PW_OFF_HS + PW_T
    rw = float(np.hypot(*surf(0.0, s0, -off)[:2]))
    z = float(surf(0.0, s0, -off)[2])
    # angular sampling: fine near the breach
    th = [0.0]
    while th[-1] < TAU - 1e-9:
        d = abs(wrap_angle(th[-1] - L.TH_B))
        th.append(min(TAU, th[-1] + (Q['frame_fine'] if d < 0.6 else Q['frame_coarse'])))
    th = np.array(th)
    rr = np.linspace(rw - 0.002, rw - depth, Q['frame_rows'])

    def mapper(U, V):
        return np.stack([V * np.cos(U), V * np.sin(U), np.full_like(U, z)], -1)
    from kit import grid_mesh
    pts, uv, T = grid_mesh(th, rr, mapper)
    sB = np.full(len(uv), s0)

    def keepf(t, r_):
        D = L.breach_D(t, np.full(np.shape(t), s0))[0]
        k = D + 0.22 + 0.05 * fbm(t * 9 + tag, r_ * 9, None, 2, seed=SEED + 440 + tag) if Q['damage'] else np.ones(np.shape(t))
        if holes and Q['detail'] > 1:
            pitch = 0.20
            arc = t * rw
            ph = ((arc / pitch) % 1.0 - 0.5) * pitch
            hr = np.hypot(ph, r_ - (rw - depth * 0.48)) - depth * 0.24
            k = np.minimum(k, np.where(np.abs(wrap_angle(t - L.TH_B)) < 0.6, hr, 1.0))
        return k
    pts, uv, T = clip_mesh(pts, uv, T, keepf(uv[:, 0], uv[:, 1]))
    P = mapper(uv[:, 0], uv[:, 1])
    if Q['damage']:
        D = L.breach_D(uv[:, 0], np.full(len(uv), s0))[0]
        bend = smoothstep(0.30, 0.0, D + 0.22)
        P[:, 2] -= 0.05 * bend ** 2 * (0.5 + 0.5 * np.sin(uv[:, 0] * 13 + tag))
        rad = np.hypot(P[:, 0], P[:, 1]) - 0.04 * bend ** 2
        ang = np.arctan2(P[:, 1], P[:, 0])
        P[:, 0], P[:, 1] = rad * np.cos(ang), rad * np.sin(ang)
    web = thicken(P, T, 0.004, mats=('frame', 'frame', 'rim_metal'), rim_tile=0.05, inner_tile=0.3)
    # flange: a band at the inner edge
    rf = rw - depth
    fz = np.linspace(-flange / 2, flange / 2, 3)
    pts2, uv2, T2 = grid_mesh(th, fz, lambda U, V: np.stack([rf * np.cos(U), rf * np.sin(U), z + V], -1))
    pts2, uv2, T2 = clip_mesh(pts2, uv2, T2, (L.breach_D(uv2[:, 0], np.full(len(uv2), s0))[0] + 0.30 + 0.04 * fbm(uv2[:, 0] * 11, uv2[:, 1] * 30, None, 2, seed=SEED + 450 + tag)) if Q['damage'] else np.ones(len(uv2)))
    P2 = np.stack([rf * np.cos(uv2[:, 0]), rf * np.sin(uv2[:, 0]), z + uv2[:, 1]], -1)
    T2 = T2[:, ::-1]
    fl = thicken(P2, T2, 0.004, mats=('frame', 'frame', 'rim_metal'), rim_tile=0.05)
    return [web, fl]


def deck(Q):
    """Flat top deck from the docking tunnel to the shell's top fillet."""
    from kit import lathe
    zt = kit.Z_DECK
    prof = [(0.60, zt), (kit.R_DECK + 0.002, zt)]
    m = lathe(prof[::-1], Q['n_lathe'], mat='deck', tile=0.6)
    m2 = lathe([(0.60, zt - 0.005), (kit.R_DECK, zt - 0.005)], Q['n_lathe'], mat='deck', tile=0.6)
    return [m, m2]
