"""Baymax armour remnants. Every piece is a thick, smoothly curved shell sheet (clipped by tear fields, dented,
stepped at panel seams) plus the mechanical internals that a real break would reveal.

Coordinates: metres, Blender Z up (glTF export maps to Y up); "forward" for the chest is -Y so it faces +Z in the viewer.
Each builder returns (Mesh, atlas) where atlas holds what paint.paint_atlas needs for the part's red paint.
"""
import math

import numpy as np

import kit
import paint
from kit import Mesh, TAU, SEED, smoothstep, fbm, vnoise, cylinder, sweep, box, lathe
from shell import (droop_cable, ball_joint, axis, unit, sheet, jag, lip_deform, dents, stringer_band, hub_assembly, cable, piston, lathe_part, ring_profile,
                   bolt_ring, align_to, numeric_normal)


def wrap(a):
    return (a + math.pi) % TAU - math.pi


def ellipsoid_pt(d, R):
    d = unit(d)
    k = 1.0 / math.sqrt((d[0] / R[0]) ** 2 + (d[1] / R[1]) ** 2 + (d[2] / R[2]) ** 2)
    return d * k


def smooth_step(d, w):
    return smoothstep(-w, w, d)


# =========================================================================================== shoulder
SH_R = (0.38, 0.36, 0.34)
SH_PHI = 2.55
SH_TH0 = -0.62
SH_DISC_DIR = unit([-0.30, 0.33, 0.90])
SH_NT = unit([0.60, -0.40, -0.50])


def f_shoulder(s, t):
    th = SH_TH0 + np.asarray(s, float) * TAU
    ph = np.asarray(t, float) * SH_PHI
    # a slightly pinched, egg-like dome: fuller toward the top, soft shoulder roll
    k = 1.0 + 0.05 * np.cos(2 * th) * np.sin(ph)
    return np.stack([SH_R[0] * k * np.sin(ph) * np.cos(th), SH_R[1] * np.sin(ph) * np.sin(th), SH_R[2] * np.cos(ph)], -1)


def _phi_of(P):
    return np.arccos(np.clip(P[:, 2] / (np.linalg.norm(P, axis=1) + 1e-9), -1, 1))


def shoulder_keep(s, t, P):
    m1 = 0.04 - P @ SH_NT + jag(P, 0.05, 1)
    ph = _phi_of(P)
    m2 = (2.36 - ph) * 0.35 + jag(P, 0.008, 2, 12, 30)
    return np.minimum(m1, m2)


SH_C = ellipsoid_pt(SH_DISC_DIR, SH_R)
SH_IMP = [(ellipsoid_pt([0.62, -0.1, 0.6], SH_R), 0.05, 0.016), (ellipsoid_pt([0.2, -0.75, 0.2], SH_R), 0.04, 0.012),
          (ellipsoid_pt([-0.75, 0.2, 0.15], SH_R), 0.035, 0.010)]


def shoulder_seams():
    def eq(P):
        return (_phi_of(P) - 1.58) * 0.34

    def mer(P):
        th = np.arctan2(P[:, 1], P[:, 0])
        d = wrap(th - 2.2) * 0.30 * np.sin(_phi_of(P))
        return np.where(_phi_of(P) > 1.58, d, 1.0)

    def ring(P):
        d, _, _, front = paint.tangent_disc(P, SH_C, SH_DISC_DIR, 0.165)
        return np.where(front, d, 1.0)
    return [eq, mer, ring]


def shoulder_deform(P, s, t, n):
    ph = _phi_of(P)
    # lower band proud of the upper shell, disc recessed, tear lip curl, impact dents
    P = P + n * (0.006 * smooth_step(ph - 1.58, 0.03))[:, None]
    d, _, _, front = paint.tangent_disc(P, SH_C, SH_DISC_DIR, 0.135)
    d2, _, _, _ = paint.tangent_disc(P, SH_C, SH_DISC_DIR, 0.165)
    P = P - n * (0.008 * smooth_step(-d2, 0.012) * front)[:, None]
    P = lip_deform(shoulder_keep, 0.016, 0.07, 1)(P, s, t, n)
    return dents(P, n, SH_IMP)


def build_shoulder():
    S = axis(0, 1, 0.0050)
    T = axis(0, 1, 0.014 / (SH_PHI * 0.36))
    shell = sheet(f_shoulder, S, T, shoulder_keep, shoulder_deform, 0.016, ('shoulder_paint', 'liner', 'rim'), centre=lambda P: np.zeros_like(P))
    parts = [shell]
    # --- ball joint in its housing ring, shaft hub and the wiring revealed by the break
    o = np.array([0.0, 0.0, -0.10])
    parts.append(ball_joint(o + np.array([0, 0, 0.02]), 0.135))
    parts.append(lathe_part(ring_profile(0.125, 0.215, 0.0, 0.035, 0.005), o + np.array([0, 0, 0.0]), [0, 0, 1], 'gunmetal', n=64))
    parts.append(lathe_part([(0.10, -0.03), (0.125, -0.03), (0.15, 0.0), (0.12, 0.0), (0.10, -0.03)], o, [0, 0, 1], 'steel', n=48))
    parts += bolt_ring(o + np.array([0, 0, 0.035]), [0, 0, 1], 0.17, 0, 12, 0.009, 0.012)
    parts += hub_assembly(o + np.array([0, 0, -0.03]), [0.08, -0.04, -1.0], 1.05, 0.30, lens=False, tag=1)
    out = unit([SH_NT[0], SH_NT[1], 0.0])
    side = np.array([-out[1], out[0], 0.0])
    for k, (off, dz, rr, col) in enumerate([(-0.07, 0.00, 0.014, 'cable_red'), (0.0, 0.05, 0.011, 'cable_black'), (0.06, -0.01, 0.012, 'cable_red'), (0.12, 0.03, 0.010, 'cable_black')]):
        p0 = o + side * off + out * 0.16 + np.array([0, 0, 0.04 + dz])
        p1 = o + side * (off * 1.5 + 0.03 * k) + out * (0.40 + 0.03 * k) + np.array([0, 0, -0.14 + dz])
        parts += droop_cable(p0, p1, 0.07, rr, col, 0.03, k)
    parts += piston(o + out * 0.15 + side * 0.10 + np.array([0, 0, 0.02]), o + out * 0.05 + side * 0.18 + np.array([0, 0, 0.28]), 0.017)
    for sv in (0.30, 0.62):
        parts.append(stringer_band(f_shoulder, shoulder_keep, sv, 't', 0.15, 1.0, 0.07, 0.02, 0.007, lambda P: np.zeros_like(P), 'liner', None))
    return Mesh.concat(parts), dict(name='shoulder_paint', f=f_shoulder, keep=shoulder_keep, size=(1536, 768), seams=shoulder_seams(),
                                    impacts=SH_IMP, disc=(SH_C, SH_DISC_DIR, 0.135, (0.46, 0.37, 0.60)), seed=11, wear=1.15)


# =========================================================================================== forearm
FA_L = 0.92
FA_TH0 = 0.9      # seam direction, lies inside the open wedge
FA_SEAM = 0.60


def fa_radius(tau):
    return 0.150 + 0.112 * np.sin(np.pi / 2 * np.minimum(tau / 0.78, 1.0)) - 0.045 * smoothstep(0.88, 1.0, tau)


def f_forearm(s, t):
    th = FA_TH0 + np.asarray(s, float) * TAU
    tau = np.asarray(t, float)
    r = fa_radius(tau)
    return np.stack([r * np.cos(th) * 1.03, r * np.sin(th) * 0.90, tau * FA_L], -1)


def _fa_tau(P):
    return P[:, 2] / FA_L


def forearm_keep(s, t, P):
    tau = _fa_tau(P)
    th = np.arctan2(P[:, 1] / 0.90, P[:, 0] / 1.03)
    r = fa_radius(np.clip(tau, 0, 1))
    wedge_w = 1.05 * smoothstep(0.66, 0.0, tau) + 0.08
    m_w = (np.abs(wrap(th - FA_TH0)) - wedge_w) * r + jag(P, 0.04, 3)
    tb = 0.10 + 0.17 * np.cos(wrap(th - 1.25))
    m_b = (tau - tb) * FA_L + jag(P, 0.04, 4)
    m_t = (0.965 - tau) * FA_L
    k = np.minimum(np.minimum(m_w, m_b), m_t)
    # a split opened at the main panel seam, tapering out around the ring
    dth = np.abs(wrap(th - (FA_TH0 + math.pi)))
    wid = 0.0050 * smoothstep(1.55, 0.35, dth)
    slit = np.abs(tau - FA_SEAM) * FA_L - wid
    return np.minimum(k, np.where(wid > 0.0006, slit, 1.0) + 0.0 * k)


FA_IMP = [((0.18, -0.12, 0.36), 0.06, 0.018), ((-0.17, 0.15, 0.66), 0.045, 0.012), ((0.2, 0.06, 0.78), 0.035, 0.010)]


def _fa_imp():
    out = []
    for c, R, d in FA_IMP:
        z = c[2]
        r = float(fa_radius(z / FA_L))
        a = math.atan2(c[1], c[0])
        out.append(((r * math.cos(a) * 1.03, r * math.sin(a) * 0.90, z), R, d))
    return out


FA_IMP = _fa_imp()


def forearm_seams():
    def main(P):
        return (P[:, 2] / FA_L - FA_SEAM) * FA_L

    def upper(P):
        return (P[:, 2] / FA_L - 0.80) * FA_L

    def lon(P):
        th = np.arctan2(P[:, 1] / 0.90, P[:, 0] / 1.03)
        return np.where(P[:, 2] / FA_L > FA_SEAM, wrap(th - (FA_TH0 + math.pi * 0.5)) * 0.2, 1.0)
    return [main, upper, lon]


def forearm_deform(P, s, t, n):
    tau = _fa_tau(P)
    P = P + n * (0.012 * smooth_step(tau - FA_SEAM, 0.012) + 0.005 * smooth_step(tau - 0.80, 0.008))[:, None]
    P = lip_deform(forearm_keep, 0.018, 0.07, 3)(P, s, t, n)
    return dents(P, n, FA_IMP)


def build_forearm():
    secs = [(FA_SEAM - 0.012, FA_SEAM + 0.012)]
    S = axis(0, 1, 0.016 / (TAU * 0.24))
    T = axis(0, 1, 0.018 / FA_L, 0.0035 / FA_L, secs)
    ctr = lambda P: np.stack([np.zeros(len(P)), np.zeros(len(P)), P[:, 2]], -1)
    shell = sheet(f_forearm, S, T, forearm_keep, forearm_deform, 0.014, ('forearm_paint', 'liner', 'rim'), centre=ctr)
    parts = [shell]
    # inner liner sleeve behind the outer skin
    S2, T2 = axis(0, 1, 0.024 / (TAU * 0.2)), axis(0, 1, 0.026 / FA_L)
    liner = sheet(f_forearm, S2, T2, lambda s, t, P: forearm_keep(s, t, P) - 0.03,
                  None, 0.007, ('liner', 'liner', 'rim'), centre=ctr, offset=-0.042)
    parts.append(liner)
    # --- wrist: bulkhead, bearing hub and actuators
    parts.append(lathe_part([(0.04, 0.0), (0.14, 0.0), (0.14, 0.02), (0.08, 0.02), (0.08, 0.05), (0.04, 0.05), (0.04, 0.0)], np.array([0, 0, 0.17]), [0, 0, 1], 'gunmetal', n=48))
    parts += hub_assembly(np.array([0.0, 0.0, 0.04]), [0, 0, -1], 0.9, 0.20, lens=False, tag=2)
    parts += bolt_ring(np.array([0.0, 0.0, 0.19]), [0, 0, 1], 0.115, 0, 12, 0.007, 0.01)
    for a in (0.5, 2.6, 4.4):
        p0 = np.array([0.095 * math.cos(a), 0.095 * math.sin(a), 0.19])
        parts += piston(p0, p0 + np.array([0.01 * math.cos(a), 0.01 * math.sin(a), 0.27]), 0.015)
    for k, a in enumerate((1.3, 3.4, 5.4)):
        p0 = np.array([0.07 * math.cos(a), 0.07 * math.sin(a), 0.2])
        p1 = np.array([0.12 * math.cos(a + 0.7), 0.12 * math.sin(a + 0.7), 0.40])
        parts += cable([p0, p0 + np.array([0.02, 0, 0.08]), p1, p1 + np.array([0, 0.03, 0.1])], 0.010, 'cable_red' if k != 1 else 'cable_black')
    return Mesh.concat(parts), dict(name='forearm_paint', f=f_forearm, keep=forearm_keep, size=(1280, 896), seams=forearm_seams(), impacts=FA_IMP,
                                    seed=21)


# =========================================================================================== chest
CH_H0, CH_H1 = -0.58, 0.67
CH_TH = 1.58


def ch_g(h):
    tau = np.clip((h - 0.10) / 0.72, -1, 1)
    return (1 - np.abs(tau) ** 2.7) ** (1 / 2.7)


def f_chest(s, t):
    th = (np.asarray(s, float) - 0.5) * 2 * CH_TH
    h = CH_H0 + np.asarray(t, float) * (CH_H1 - CH_H0)
    g = ch_g(h)
    # a little belly bulge below the emblem and a flatter front plane
    rx = 0.64 * g
    rz = 0.40 * g * (1 + 0.05 * np.exp(-((h + 0.1) / 0.3) ** 2))
    return np.stack([rx * np.sin(th), -rz * np.cos(th) + 0.0, h], -1)


def _ch_th(P):
    h = P[:, 2]
    g = ch_g(h) + 1e-6
    return np.arctan2(P[:, 0] / (0.64 * g), -P[:, 1] / (0.40 * g))


CH_HOLE = [(0.60, 0.30), (-0.60, 0.30)]


def chest_keep(s, t, P):
    th = _ch_th(P)
    h = P[:, 2]
    j = jag(P, 0.04, 6)
    m_side = (1.42 - np.abs(th)) * 0.45 + j
    hb = -0.50 + 0.19 * np.exp(-(th / 0.85) ** 2)
    m_b = (h - hb) + jag(P, 0.04, 7)
    k = np.minimum(m_side, m_b)
    for sx, cz in ((1, 0.30), (-1, 0.30)):
        d = np.hypot((P[:, 1] + 0.04) / 0.21, (h - cz) / 0.27)
        k = np.minimum(k, np.where(np.sign(P[:, 0]) == sx, (d - 1.0) * 0.21 + jag(P, 0.012, 8, 12, 36) * (1.0 if sx > 0 else 0.3), 9.0))
    # right-hand bite where the armour was ripped off
    bp = np.array([0.40, -0.20, -0.18])
    k = np.minimum(k, (np.linalg.norm((P - bp) * np.array([1.0, 0.8, 1.0]), axis=1) - 0.17) + jag(P, 0.035, 9))
    return k


CH_EM_C = np.array([-0.15, 0.0, 0.0])


def _chest_point(th, h):
    s = th / (2 * CH_TH) + 0.5
    t = (h - CH_H0) / (CH_H1 - CH_H0)
    return f_chest(np.array([s]), np.array([t]))[0]


CH_EM = _chest_point(-0.28, 0.20)
CH_IMP = [(_chest_point(0.62, 0.12), 0.05, 0.016), (_chest_point(-0.85, -0.18), 0.04, 0.012), (_chest_point(0.30, 0.43), 0.035, 0.010),
          (_chest_point(1.05, 0.46), 0.04, 0.012)]


def chest_seams():
    def belly(P):
        return P[:, 2] - (-0.19 - 0.06 * (1 - (P[:, 0] / 0.64) ** 2))

    def vert(P):
        d = np.abs(P[:, 0]) - 0.40
        return np.where(P[:, 2] > -0.21, d, 1.0)

    def shoulder(P):
        return P[:, 2] - (0.48 - 0.12 * (np.abs(P[:, 0]) / 0.64) ** 2)
    return [belly, vert, shoulder]


def chest_deform(P, s, t, n):
    belly = P[:, 2] - (-0.19 - 0.06 * (1 - (P[:, 0] / 0.64) ** 2))
    P = P + n * (-0.006 * smooth_step(belly, 0.012) + 0.005 * smooth_step(np.abs(P[:, 0]) - 0.40, 0.01) * (P[:, 2] > -0.2))[:, None]
    P = lip_deform(chest_keep, 0.016, 0.07, 6)(P, s, t, n)
    return dents(P, n, CH_IMP)


def build_chest():
    S = axis(0, 1, 0.019 / (2 * CH_TH * 0.55))
    T = axis(0, 1, 0.019 / (CH_H1 - CH_H0))
    ctr = lambda P: np.stack([np.zeros(len(P)), np.full(len(P), 0.05), P[:, 2]], -1)
    shell = sheet(f_chest, S, T, chest_keep, chest_deform, 0.018, ('chest_paint', 'liner', 'rim'), centre=ctr, weld=False)
    parts = [shell]
    # grey inner liner wall with a stepped, panelled look, set well inside the paint skin
    S2, T2 = axis(0, 1, 0.026 / (2 * CH_TH * 0.5)), axis(0, 1, 0.026 / (CH_H1 - CH_H0))

    def liner_keep(s, t, P):
        th = _ch_th(P)
        k = chest_keep(s, t, P) - 0.035
        # two recessed equipment pockets cut into the liner
        for cx, cz in ((-0.18, 0.12), (0.12, 0.28)):
            r = np.maximum(np.abs(P[:, 0] - cx) - 0.085, np.abs(P[:, 2] - cz) - 0.055)
            k = np.minimum(k, np.where(P[:, 1] > -0.05, r, 1.0) + 0.0)
        return k
    liner = sheet(f_chest, S2, T2, liner_keep, None, 0.010, ('liner', 'liner', 'rim'), centre=ctr, offset=-0.075, weld=False)
    parts.append(liner)
    # frames: vertical stringers and a horizontal belt rib standing off the inside of the paint skin
    for sv in (0.30, 0.50, 0.70):
        parts.append(stringer_band(f_chest, lambda s, t, P: chest_keep(s, t, P), sv, 't', 0.0, 1.0, 0.072, 0.02, 0.006, ctr, 'liner', None))
    parts.append(stringer_band(f_chest, lambda s, t, P: chest_keep(s, t, P), 0.36, 's', 0.0, 1.0, 0.072, 0.02, 0.006, ctr, 'liner', None))
    # right arm socket: bearing hub and shaft; left arm: empty flange ring
    parts += hub_assembly(np.array([0.46, -0.04, 0.30]), [1, 0, 0], 1.0, 0.18, lens=False, tag=3)
    parts.append(lathe_part(ring_profile(0.18, 0.235, 0.0, 0.03, 0.004), np.array([-0.52, -0.04, 0.30]), [-1, 0, 0], 'gunmetal', n=56))
    parts += bolt_ring(np.array([-0.52, -0.04, 0.30]), [-1, 0, 0], 0.21, 0.03, 12, 0.008, 0.01)
    # actuator, cables and a service box
    parts += piston(np.array([0.10, 0.12, -0.30]), np.array([0.14, 0.11, 0.20]), 0.022)
    for k, (x0, z0, c) in enumerate([(0.18, 0.40, 'cable_red'), (0.22, 0.38, 'cable_black'), (-0.1, 0.45, 'cable_black'), (0.28, 0.42, 'cable_red')]):
        parts += cable([np.array([0.40, 0.04, 0.33]), np.array([x0 + 0.1, 0.1, z0 - 0.15]), np.array([x0, 0.12, z0 - 0.35 - 0.03 * k]), np.array([x0 - 0.12, 0.14, -0.32 - 0.04 * k])],
                       0.011, c)
    parts.append(box(np.array([-0.18, 0.12, 0.12]), (0.17, 0.05, 0.11), bevel=0.01, mat='gunmetal', tile=0.2))
    parts.append(box(np.array([-0.18, 0.093, 0.12]), (0.12, 0.012, 0.012), bevel=0.003, mat='lens_blue', tile=0.1, seg=1))
    return Mesh.concat(parts), dict(name='chest_paint', f=f_chest, keep=chest_keep, size=(1536, 1024), seams=chest_seams(), impacts=CH_IMP,
                                    emblem=(CH_EM, np.array([0.0, -1.0, 0.0]), 0.115), seed=31)


# =========================================================================================== joint shell piece
JT_R = (0.27, 0.27, 0.25)
JT_PHI = 2.05
JT_PH0 = 0.58


def f_joint(s, t):
    th = np.asarray(s, float) * TAU + 0.4
    ph = JT_PH0 + np.asarray(t, float) * (JT_PHI - JT_PH0)
    return np.stack([JT_R[0] * np.sin(ph) * np.cos(th), JT_R[1] * np.sin(ph) * np.sin(th), JT_R[2] * np.cos(ph)], -1)


JT_NT = unit([-0.55, 0.45, -0.55])


def joint_keep(s, t, P):
    m1 = 0.07 - P @ JT_NT + jag(P, 0.04, 12)
    ph = _phi_of(P)
    m_hole = (ph - JT_PH0 - 0.035) * 0.26 + jag(P, 0.004, 13, 14, 40)
    return np.minimum(np.minimum(m1, m_hole), (JT_PHI - 0.02 - ph) * 0.3)


JT_IMP = [(ellipsoid_pt([0.5, 0.6, 0.5], JT_R), 0.04, 0.012), (ellipsoid_pt([-0.6, -0.2, 0.55], JT_R), 0.035, 0.010)]


def joint_seams():
    def eq(P):
        return (_phi_of(P) - 1.35) * 0.27
    return [eq]


def joint_deform(P, s, t, n):
    P = P + n * (0.005 * smooth_step(_phi_of(P) - 1.35, 0.03))[:, None]
    P = lip_deform(joint_keep, 0.014, 0.06, 12)(P, s, t, n)
    return dents(P, n, JT_IMP)


def build_joint():
    S = axis(0, 1, 0.0120 / (TAU * 0.27 * 0.8))
    T = axis(0, 1, 0.012 / ((JT_PHI - JT_PH0) * 0.27))
    shell = sheet(f_joint, S, T, joint_keep, joint_deform, 0.014, ('joint_paint', 'liner', 'rim'), centre=lambda P: np.zeros_like(P))
    parts = [shell]
    # drum, ribbed collar and hub projecting through the polar opening
    parts.append(lathe_part([(0.0, 0.0), (0.19, 0.0), (0.195, 0.01), (0.195, 0.08), (0.19, 0.09), (0.0, 0.09), (0.0, 0.0)], np.array([0, 0, -0.04]), [0, 0, 1], 'gunmetal', n=56))
    for k in range(4):
        parts.append(lathe_part(ring_profile(0.15, 0.205, 0.0, 0.012, 0.003), np.array([0, 0, -0.03 + 0.02 * k]), [0, 0, 1], 'steel' if k == 1 else 'gunmetal', n=56))
    parts += hub_assembly(np.array([0.0, 0.0, 0.10]), [0, 0, 1], 0.95, 0.22, lens=True, tag=4)
    for k, a in enumerate((0.3, 2.4, 4.6)):
        p0 = np.array([0.17 * math.cos(a), 0.17 * math.sin(a), 0.02])
        parts += cable([p0, p0 + np.array([0.04 * math.cos(a), 0.04 * math.sin(a), -0.10]), p0 + np.array([0.0, 0.0, -0.22]) + 0.1 * np.array([math.cos(a + 1), math.sin(a + 1), 0]), p0 + np.array([0.1, 0.1, -0.3])],
                       0.011, 'cable_red' if k != 1 else 'cable_black')
    return Mesh.concat(parts), dict(name='joint_paint', f=f_joint, keep=joint_keep, size=(1280, 768), seams=joint_seams(), impacts=JT_IMP, seed=41)


# =========================================================================================== plating shard
SD_R = 0.95


def f_shard(s, t):
    a = (np.asarray(s, float) - 0.5) * 1.3
    b = (np.asarray(t, float) - 0.5) * 1.0
    return np.stack([SD_R * np.sin(a) * np.cos(b) * 0.9, -SD_R * (np.cos(a) * np.cos(b) - 1.0) * 0.6 - 0.0, SD_R * np.sin(b)], -1)


SD_POLY = np.array([[-0.34, -0.24], [0.30, -0.30], [0.38, 0.06], [0.14, 0.30], [-0.26, 0.26]])


def _poly_sd(P):
    x, z = P[:, 0], P[:, 2]
    d = np.full(len(P), 9.0)
    n = len(SD_POLY)
    for i in range(n):
        a, b = SD_POLY[i], SD_POLY[(i + 1) % n]
        e = b - a
        nn = np.array([e[1], -e[0]]) / np.linalg.norm(e)
        d = np.minimum(d, (x - a[0]) * -nn[0] + (z - a[1]) * -nn[1])
    return d


def shard_keep(s, t, P):
    k = _poly_sd(P) + jag(P, 0.035, 14)
    # armour slot (rounded rectangle) near the top
    sx = np.abs(P[:, 0] + 0.02) - 0.06
    sz = np.abs(P[:, 2] - 0.14) - 0.014
    slot = np.maximum(sx, sz) * 0 + (np.hypot(np.maximum(sx, 0), np.maximum(sz, 0)) + np.minimum(np.maximum(sx, sz), 0)) - 0.012
    return np.minimum(k, slot)


SD_IMP = [((0.10, 0.0, -0.08), 0.045, 0.012), ((-0.20, 0.0, 0.05), 0.03, 0.008)]


def shard_seams():
    return [lambda P: P[:, 2] - 0.02 + 0.2 * P[:, 0] * 0.0]


def shard_deform(P, s, t, n):
    P = P + n * (0.007 * smooth_step(P[:, 2] - 0.02, 0.01))[:, None]
    P = lip_deform(shard_keep, 0.014, 0.06, 14)(P, s, t, n)
    # surface placed at y so we can correct impacts
    return dents(P, n, [(_snap(c), R, d) for c, R, d in SD_IMP])


def _snap(c):
    P = f_shard(np.array([0.5 + c[0] / 1.1]), np.array([0.5 + c[2] / 0.95]))[0]
    return P


def build_shard():
    S = axis(0, 1, 0.012 / 0.9)
    T = axis(0, 1, 0.012 / 0.95)
    shell = sheet(f_shard, S, T, shard_keep, shard_deform, 0.014, ('shard_paint', 'liner', 'rim'), centre=lambda P: np.array([0.0, 1.5, 0.0]) + 0 * P)
    return shell, dict(name='shard_paint', f=f_shard, keep=shard_keep, size=(1024, 1024), seams=shard_seams(), impacts=[(_snap(c), R, d) for c, R, d in SD_IMP], seed=51, wear=0.5)


BUILDERS = {'shoulder': build_shoulder, 'forearm': build_forearm, 'chest': build_chest, 'joint': build_joint, 'shard': build_shard}
