"""Structural steel family built from the kit: twisted I-beam, bolted I-beam splice, bent H-column.

Three materially different outputs from the same profile sweep + plate + bolt kit:
  industrial_ibeam_twisted : torsional-buckled W360 with rippled flange tips, torch-cut end, end plate.
  industrial_ibeam_bolted  : two W360 pieces joined by a web splice + flange cover plates; joint failed (sheared bolts,
                             peeled plate, dropped far piece), clip angle at the near end.
  industrial_column_bent   : W300 H-column with base plate, anchor bolts, gussets; local flange buckle, mid-height bend,
                             sheared top."""
import math

import numpy as np

import kit
from kit import (M, bolt_assy, boxes, fbm, gauss, i_outline, merge, plate, profile_sweep, smoothstep, solidify, stations, tri_wave, twist_yz, vnoise, weld)

SEED = 71


def _tear_d(rest, centres_w, crumple=None):
    """Damage drivers (tear proximity, crumple) from distances (rest space) to damage stations."""
    s = rest[:, 0]
    tear = np.zeros(len(s))
    for c, w in centres_w:
        tear = np.maximum(tear, np.exp(-((s - c) / w) ** 2))
    return M(np.zeros((0, 3)), np.zeros((0, 3), int)), tear


def _beam(outline, L, hot, deform, jag0=None, jag1=None, sub=0.04, fine=0.02, base=0.4, tear_at=(), crumple=None):
    s_vals = stations(L, hot, base=base, fine=fine)
    m, rest = profile_sweep(outline, s_vals, deform, sub=sub, jag_end=(jag0, jag1))
    tear = np.zeros(len(rest))
    for c, w in tear_at:
        tear = np.maximum(tear, np.exp(-((rest[:, 0] - c) / w) ** 2))
    crum = np.zeros(len(rest)) if crumple is None else crumple(rest)
    m.d = np.stack([tear, crum], 1)
    return m, rest


def _end_plate(x, depth, width, hole_y, hole_z, thick=0.018, seed=0, shear=()):
    holes = [(y, z, 0.0125, 18) for y, z in zip(hole_y, hole_z)]
    from kit import rrect
    pl = plate(rrect(width, depth, 0.012, 5), holes, thick, (x, 0, 0), (0, 1, 0), (0, 0, 1))
    return pl


# ------------------------------------------------------------------ 1. twisted beam
def build_twisted():
    D, BF, TF, TW = 0.36, 0.17, 0.0127, 0.0080
    L = 4.6
    outline = i_outline(D, BF, TF, TW, chamfer=0.0018)
    rng = np.random.default_rng(SEED)
    PHI = 2.15                       # twist (rad): ~123 degrees
    S0, S1 = 1.35, 3.05

    def deform(P):
        s, y, z = P[:, 0], P[:, 1], P[:, 2]
        flange = smoothstep(0.10, 0.17, np.abs(z))
        env = gauss(s, 2.2, 0.75)
        tip = (np.abs(y) / (BF / 2)) ** 1.5
        wave = 2 * math.pi * s / 0.19 + 1.7 * np.sign(y) + 0.8 * fbm(s * 4.0, y * 3.0, None, 2, seed=SEED)
        z2 = z + flange * np.sign(z) * 0.014 * env * tip * tri_wave(wave)
        # web: gentle crippling ripple at the twist
        y2 = y + (1 - flange) * 0.006 * env * np.sin(s * 28.0 + z * 20.0)
        phi = PHI * smoothstep(S0, S1, s) + 0.03 * smoothstep(3.4, 4.6, s)
        yt, zt = twist_yz(y2, z2, phi)
        # lateral-torsional sweep: the beam wandered sideways and sagged while twisting
        lat = 0.34 * smoothstep(0.8, 3.6, s) - 0.07 * smoothstep(3.6, 4.6, s)
        sag = -0.10 * smoothstep(1.2, 3.4, s) ** 1.4
        return np.stack([s, yt + lat, zt + sag + 0.18 * np.sin(math.pi * np.clip(s / L, 0, 1)) * 0.0], 1)

    def jag_far(y, z):       # torch-cut far end: inclined cut with a ragged edge and a dropped lip
        return -0.16 * (z / D) - 0.03 * (y / BF) + 0.022 * np.tanh(2 * fbm(y * 12.0 + 3, z * 9.0, None, 2, seed=SEED + 1)) + 0.008 * vnoise(y * 55.0, z * 40.0, None, SEED + 2)

    def crumple(rest):
        s = rest[:, 0]
        return np.clip(gauss(s, 2.2, 0.8) * 0.9 + 0.3 * gauss(s, 4.6, 0.2), 0, 1)

    beam, rest = _beam(outline, L, [(2.2, 1.0), (4.6, 0.25)], deform, None, jag_far, sub=0.04, fine=0.03, base=0.45,
                       tear_at=[(4.6, 0.12)], crumple=crumple)
    parts = [beam]
    hw, welds = [], []
    # end plate with 6 bolts (one missing, one sheared) and a fillet-weld frame
    bp = [(-0.045, -0.145), (0.045, -0.145), (-0.045, 0.145), (0.045, 0.145), (-0.045, 0.0), (0.045, 0.0)]
    pl = _end_plate(-0.009, 0.46, 0.24, [b[0] for b in bp], [b[1] for b in bp])
    parts.append(pl)
    for k, (yy, zz) in enumerate(bp):
        if k == 1:
            continue
        hw.append(bolt_assy((-0.018, yy, zz), (1, 0, 0), 0.018, scale=0.8, seed=k, sheared=0.05 if k == 3 else 0.0, nut=(k != 3)))
    ex = 0.0
    for sg in (1, -1):
        welds.append(weld([(ex, y, sg * (D / 2 - TF - 0.004)) for y in np.linspace(-BF / 2 + 0.01, BF / 2 - 0.01, 30)], SEED + 5 + sg))
        welds.append(weld([(ex, sg * (TW / 2 + 0.004), z) for z in np.linspace(-D / 2 + TF + 0.01, D / 2 - TF - 0.01, 30)], SEED + 9 + sg))
    # two web stiffeners near the end plate
    for sg in (1, -1):
        st = boxes([(0.62, sg * (TW / 2 + 0.005), 0)], [(0.010, 0.010, D - 2 * TF - 0.02)])
        parts.append(st)
    return {'paint': merge(parts), 'bolt': merge(hw), 'weld': merge(welds)}


# ------------------------------------------------------------------ 2. bolted splice
def build_bolted():
    D, BF, TF, TW = 0.36, 0.17, 0.0127, 0.0080
    L = 2.2
    outline = i_outline(D, BF, TF, TW, chamfer=0.0018)

    def deform_a(P):
        s, y, z = P[:, 0], P[:, 1], P[:, 2]
        return np.stack([s, y, z], 1)
    A, restA = _beam(outline, L, [(L, 0.2), (0.0, 0.1)], deform_a, None, lambda y, z: 0.0 * y, sub=0.05, fine=0.05, base=0.8,
                     tear_at=[(L, 0.1)])
    # far piece: dropped and yawed after the splice failed; its near end is peeled and one flange is folded
    ang = math.radians(-8.5)
    drop = 0.075

    def deform_b(P):
        s, y, z = P[:, 0], P[:, 1], P[:, 2]
        ff = smoothstep(0.10, 0.17, np.abs(z)) * np.sign(z)
        z2 = z + (z > 0) * 0.0
        # buckled bottom flange tip near the joint
        z3 = z2 + (ff < 0) * 0.02 * gauss(s, 0.12, 0.18) * (np.abs(y) / (BF / 2)) ** 2
        twist = 0.10 * smoothstep(0.2, 2.1, s)
        yt, zt = twist_yz(y, z3, twist)
        # rigid rotation about the y axis at the joint and a drop
        c, sn = math.cos(ang), math.sin(ang)
        x = s * c - zt * sn
        zz = s * sn + zt * c
        return np.stack([L + 0.012 + x, yt + 0.02 * smoothstep(0.0, 2.0, s), zz - drop], 1)

    def jag_b_far(y, z):
        return 0.03 * np.tanh(2 * fbm(y * 9.0, z * 8.0, None, 2, seed=SEED + 4)) + 0.10 * (z / D) * 0.5 + 0.01 * vnoise(y * 40.0, z * 30.0, None, SEED + 6)
    B, restB = _beam(outline, 2.0, [(0.12, 0.3), (2.0, 0.2)], deform_b, None, jag_b_far, sub=0.05, fine=0.05, base=0.6,
                     tear_at=[(2.0, 0.12), (0.0, 0.1)])
    parts, hw, welds = [A, B], [], []
    # near end clip angle connection (L100x100x10 each side of the web) + 4 bolts
    for sg in (1, -1):
        ang_m, _ = profile_sweep(kit.angle_outline(0.10, 0.10, 0.010), [0, 0.20], lambda P: np.stack([P[:, 0], P[:, 1] * sg, P[:, 2]], 1) if False else np.stack([P[:, 0] + 0.02, sg * (TW / 2 + P[:, 1]) if False else sg * (TW / 2 + 0.0 + P[:, 1]), P[:, 2] - 0.10], 1), sub=0.05)
        parts.append(ang_m)
    # splice: two web plates (4 x 3 bolts each) and two flange cover plates
    rows = [-0.12, -0.04, 0.04, 0.12]
    cols = [-0.18, -0.09, 0.09, 0.18]
    sx = L + 0.006
    hole_c = [(c, r) for c in cols for r in rows]
    for sg in (1, -1):
        yc = sg * (TW / 2 + 0.005)
        pm = plate(kit.rrect(0.54, 0.31, 0.01, 5), [(c, r, 0.0105, 16) for c, r in hole_c], 0.010, (sx, yc, 0), (1, 0, 0), (0, 0, 1))
        # the far side's plate has peeled away from the failed side
        if sg == -1:
            v = pm.v.copy()
            tpeel = np.clip((v[:, 0] - sx) / 0.27, 0, 1)
            v[:, 1] += sg * 0.05 * tpeel ** 1.6
            v[:, 2] -= 0.04 * tpeel ** 1.3
            pm = M(v, pm.t, pm.d).damage(crumple=tpeel * 0.7, tear=tpeel * 0.5)
        parts.append(pm)
    for k, (c, r) in enumerate(hole_c):
        if k in (6, 11):
            continue
        yb = (TW / 2 + 0.010 + 0.002)
        hw.append(bolt_assy((sx + c, yb, r), (0, -1, 0), 0.026, scale=0.8, seed=10 + k, sheared=0.05 if k in (5, 14) else 0.0, nut=k not in (5, 14)))
    # flange cover plates (top and bottom), two rows of bolts each
    for sg in (1, -1):
        zc = sg * (D / 2 + 0.006)
        pm = plate(kit.rrect(0.50, 0.17, 0.008, 5), [(c, y, 0.0105, 16) for c in (-0.18, -0.06, 0.06, 0.18) for y in (-0.045, 0.045)], 0.012, (sx, 0, zc), (1, 0, 0), (0, 1, 0))
        parts.append(pm)
        for k, (c, y) in enumerate([(c, y) for c in (-0.18, -0.06, 0.06, 0.18) for y in (-0.045, 0.045)]):
            if sg == 1 and k == 3:
                continue
            hw.append(bolt_assy((sx + c, y, zc + sg * 0.006), (0, 0, -sg), 0.032, scale=0.8, seed=60 + k, nut=True))
    return {'paint': merge(parts), 'bolt': merge(hw), 'weld': merge(welds) if welds else None}


# ------------------------------------------------------------------ 3. bent H-column
def build_column():
    D, BF, TF, TW = 0.30, 0.30, 0.015, 0.010
    L = 4.0
    outline = i_outline(D, BF, TF, TW, chamfer=0.002)
    cl = kit.Centerline(L, [(2.05, math.radians(-17), 0.20), (3.2, math.radians(6), 0.4)])

    def deform(P):
        s, y, z = P[:, 0], P[:, 1], P[:, 2]
        # local flange buckle: the compression flange (z<0 on the bend inside) rolls over and ripples
        env = gauss(s, 2.0, 0.28)
        flange = smoothstep(0.10, 0.14, np.abs(z))
        y2 = y + flange * 0.03 * env * np.sin(np.pi * (y / (BF / 2))) * 0.0
        z2 = z + (z < 0) * flange * 0.028 * env * (np.abs(y) / (BF / 2)) ** 2 * tri_wave(s * 33.0 + 1.0) - flange * (z < 0) * 0.02 * env
        w = (1 - flange) * 0.012 * env * np.sin(s * 40.0 + z * 15.0)
        # slight twist near the buckle
        yt, zt = twist_yz(y2 + w, z2, 0.10 * smoothstep(1.6, 2.6, s))
        return cl.apply(s, yt, zt, pivot=-0.0)

    def jag_top(y, z):
        return 0.15 * (y / BF) + 0.03 * np.tanh(2 * fbm(y * 10.0 + 1, z * 10.0, None, 2, seed=SEED + 8)) + 0.012 * vnoise(y * 45.0, z * 45.0, None, SEED + 9)
    col, rest = _beam(outline, L, [(2.05, 0.7), (4.0, 0.2), (0.0, 0.2)], deform, None, jag_top, sub=0.045, fine=0.03, base=0.5,
                      tear_at=[(4.0, 0.12)], crumple=lambda r: np.clip(gauss(r[:, 0], 2.0, 0.3), 0, 1))
    parts, hw, welds = [col], [], []
    # base plate 0.55 x 0.55 x 0.032 with 4 anchor bolts (one bent over, one pulled) and corner gussets
    bx = 0.21
    holes = [(sx * bx, sy * bx, 0.017, 18) for sx in (-1, 1) for sy in (-1, 1)]
    bp = plate(kit.rrect(0.56, 0.56, 0.02, 5), holes, 0.032, (-0.016, 0, 0), (0, 1, 0), (1, 0, 0))   # plate lies in the y-x plane? rotate below
    # plate was built in (y, x) axes at s = -0.016; we need it normal to the column axis (x): rebuild with u=y, v=z
    bp = plate(kit.rrect(0.56, 0.56, 0.02, 5), [(a, b, 0.017, 18) for a, b in [(sx * bx, sy * bx) for sx in (-1, 1) for sy in (-1, 1)]], 0.032, (-0.016, 0, 0), (0, 1, 0), (0, 0, 1))
    parts.append(bp)
    for k, (sx_, sy_) in enumerate([(sx, sy) for sx in (-1, 1) for sy in (-1, 1)]):
        yb, zb = sx_ * bx, sy_ * bx
        if k == 2:   # anchor stub only, nut gone
            hw.append(bolt_assy((-0.033, yb, zb), (1, 0, 0), 0.032, scale=1.1, seed=20 + k, sheared=0.07, nut=False))
        else:
            hw.append(bolt_assy((-0.033, yb, zb), (1, 0, 0), 0.032, scale=1.1, seed=20 + k, nut=True))
    # gussets (triangular) welded to flanges at the base
    for sg in (1, -1):
        for sz in (1, -1):
            tri_pts = np.array([[0.0, 0.0], [0.17, 0.0], [0.0, 0.07]])
            g_v = np.array([[0.0, sg * (BF / 2 + 0.0), 0.0]])
            pm = M(np.array([[0.0, 0, 0], [0.0, 0.07, 0], [0.17, 0, 0]], float), np.array([[0, 1, 2]]))
            pm2 = solidify(pm, 0.012)
            # oriented in the x-y plane at the flange tip, mirrored per corner
            v = pm2.v.copy()
            v = np.stack([v[:, 0] + 0.0, v[:, 1] * sg + sg * BF / 2, v[:, 2] * 0 + v[:, 2] + sz * 0.0], 1)
            parts.append(M(v, pm2.t))
    for sg in (1, -1):
        welds.append(weld([(0.002, y, sg * (D / 2 + 0.004)) for y in np.linspace(-BF / 2 + 0.01, BF / 2 - 0.01, 30)], SEED + 30 + sg))
    return {'paint': merge(parts), 'bolt': merge(hw), 'weld': merge(welds)}


ASSETS = {
    'industrial_ibeam_twisted': dict(build=build_twisted, replaces='steel_ibeam_twisted', category='steel', label='Torsionally buckled W360 I-beam, torch-cut end, bolted end plate',
                                     paint=(0.14, 0.17, 0.20), rust_gain=1.1),
    'industrial_ibeam_bolted': dict(build=build_bolted, replaces='steel_ibeam_bolted', category='steel', label='Bolted W360 splice, failed joint with sheared bolts and a dropped span',
                                    paint=(0.12, 0.17, 0.12), rust_gain=1.0),
    'industrial_column_bent': dict(build=build_column, replaces='steel_column_bent', category='steel', label='Bent W300 H-column on a base plate with anchor bolts',
                                   paint=(0.30, 0.22, 0.05), rust_gain=1.0),
}
