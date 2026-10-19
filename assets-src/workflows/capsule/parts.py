"""Capsule component builders sharing the kit: shell fragments (upper, impact, heat-shield panel), docking collar,
RCS thruster module, broken antenna and the recovered instrument unit.  Every builder takes a detail level
(2 = LOD0, 1 = LOD1, 0 = LOD2) and returns a Mesh in its own resting frame (z up, centred)."""
import math

import numpy as np

import kit
import layout as L
import shell as sh
import exterior as ex
from interior import cable, avionics_box, screen_panel
from kit import (Mesh, TAU, SEED, S_E, S_B0, STOT, T_ABL, r_of, surf, surf_frame, thicken, box, cylinder, lathe, sweep, rot,
                 fbm, smoothstep, hash01, wrap_angle, PlanarMap, adaptive_sheet)

FRAG_UV = {}       # name -> (th_lo, th_hi, s_lo, s_hi) of its dedicated region texture


def settle(mesh):
    c = (mesh.P.min(0) + mesh.P.max(0)) / 2
    c[2] = mesh.P[:, 2].min()
    m = mesh.transformed(None, -c)
    zc = (m.P[:, 2].max()) / 2
    return m.transformed(None, (0, 0, -zc))


def lay_flat(mesh, th, s, tilt=(0.0, 0.0), spin=0.0):
    """Rotate so the shell normal at (th, s) points up, then tilt / spin for a resting pose."""
    P, n, tt, ts = surf_frame(th, s)
    F = np.stack([tt, ts, n], 1)       # columns: local x, y, z in world
    R = rot((0, 0, 1), spin) @ rot((1, 0, 0), tilt[0]) @ rot((0, 1, 0), tilt[1]) @ F.T
    return mesh.transformed(R, -(R @ P))


# ------------------------------------------------------------------ fragment fields
class Frag:
    """Torn fragment outline around (thc, sc): positive inside (~metres near the edge)."""

    def __init__(self, thc, sc, a, b, ang, seed, jag=0.22, slits=(), curl=()):
        self.thc, self.sc, self.a, self.b, self.ang, self.seed, self.jag = thc, sc, a, b, ang, seed, jag
        self.slits = np.array(slits, float) if len(slits) else np.zeros((0, 2))
        self.curl = curl            # list of (phi, width, alpha_deg, hinge_m)

    def xy(self, th, s):
        x, y = L.local_xy(th, s, self.thc, self.sc)
        ca, sa = math.cos(self.ang), math.sin(self.ang)
        return x * ca + y * sa, -x * sa + y * ca

    def f(self, th, s):
        x, y = self.xy(th, s)
        rr = np.hypot(x / self.a, y / self.b)
        phi = np.arctan2(y / self.b, x / self.a)
        lobe = 1 + self.jag * (0.5 * np.cos(3 * phi + self.seed) + 0.3 * np.cos(5 * phi + 2 * self.seed) + 0.2 * np.cos(7 * phi - self.seed)) * smoothstep(0, 0.5, rr)
        wob = 0.18 * fbm(x * 2.5 + self.seed, y * 2.5, None, 3, seed=SEED + 600 + int(self.seed * 10))
        return (lobe * (1 + wob) - rr) * min(self.a, self.b) * 0.9

    def D(self, th, s):
        e = 0.004
        x, y = self.xy(th, s)
        f = self.f(th, s)
        r = np.maximum(r_of(s), 0.1)
        fx = (self.f(th + e / r, s) - self.f(th - e / r, s)) / (2 * e)
        fy = (self.f(th, s + e) - self.f(th, s - e)) / (2 * e)
        g = np.hypot(fx, fy) + 1e-9
        return f / np.clip(g, 0.35, 1.6), fx / g, fy / g

    def phi(self, th, s):
        x, y = self.xy(th, s)
        return np.mod(np.arctan2(y / self.b, x / self.a), TAU)

    def keep(self, th, s, inset=0.0, fray_amp=0.012):
        D, _, _ = self.D(th, s)
        x, y = self.xy(th, s)
        k = D - inset + fray_amp * fbm(x * 15 + self.seed, y * 15, None, 3, seed=SEED + 610) + fray_amp * 0.3 * fbm(x * 45, y * 45, None, 2, seed=SEED + 611)
        if len(self.slits):
            ph = self.phi(th, s)
            rad = np.hypot(x, y)
            for p, ln in self.slits:
                lat = np.abs(wrap_angle(ph - p)) * rad
                w = 0.014 * np.clip(1 - D / ln, 0, 1) + 0.0015
                k = np.minimum(k, np.where(D < ln, lat - w, 1.0))
        return k

    def displacement(self, th, s, scale=1.0):
        """Curled torn edges (per-sector curl) as a 3D displacement."""
        D, gx, gy = self.D(th, s)
        ph = self.phi(th, s)
        _, n, tt, ts = surf_frame(th, s)
        ca, sa = math.cos(self.ang), math.sin(self.ang)
        gxx, gyy = gx, gy
        g = gxx[:, None] * tt + gyy[:, None] * ts
        out = np.zeros((len(th), 3))
        for p, wd, adeg, lc in self.curl:
            wgt = np.exp(-(wrap_angle(ph - p) / wd) ** 2)
            dn, dt = sh.curl(D, math.radians(abs(adeg)) * scale, lc)
            out += (n * (dn * math.copysign(1, adeg))[:, None] - g * dt[:, None]) * wgt[:, None]
        return out


def frag_sheet(fr, pm, h_fn, keep, pos, thick, mats, uvname, inner=True, rim_tile=0.08):
    th, s, T = sh.sheet(pm, h_fn, keep, 1.2)
    th = fr.thc + wrap_angle(th - fr.thc)
    P = pos(th, s)
    nrm = sh.pnormals(pos, th, s)
    if uvname in FRAG_UV:
        a0, a1, b0, b1 = FRAG_UV[uvname]
        uvv = np.stack([(th - a0) / (a1 - a0), (s - b0) / (b1 - b0)], 1)
        uv = uvv[T]
    else:
        uv = None
    return thicken(P, T, thick, mats=mats, uv_outer=uv, rim_tile=rim_tile, inner_keep=None if inner else np.zeros(len(T), bool), nrm=nrm, inner_tile=0.35)


def frag_h(fr, hmin, h0):
    def h_fn(th, s):
        D = fr.D(th, s)[0]
        return np.where(D < -0.25, 1.0, sh.grade(D, hmin, h0, 0.15, 0.35))
    return h_fn


def hat_stringers(fr, ths, s_lo, s_hi, keep_inset, step, bend_amp=0.06, off=sh.SKIN_T + 0.001):
    parts = []
    for j, th0 in enumerate(ths):
        ss = np.arange(s_lo, s_hi, step)
        th = np.full(len(ss), th0)
        k = fr.keep(th, ss, keep_inset, 0.0)
        good = k > 0
        idx = np.where(good)[0]
        if len(idx) < 3:
            continue
        runs = np.split(idx, np.where(np.diff(idx) > 1)[0] + 1)
        for run in runs:
            if len(run) < 3:
                continue
            si, ti = ss[run], th[run]
            P0, n, tt, ts = surf_frame(ti, si)
            path = P0 - n * off + fr.displacement(ti, si, 0.5)
            kk = k[run]
            bend = smoothstep(0.12, 0.0, kk)
            hh = hash01(np.array([j * 13 + len(run)]), seed=SEED + 620)[0]
            path = path - n * (bend_amp * bend ** 2 * (0.4 + hh))[:, None]
            Pp, Tp = sh._profile_strip(path, tt, n, sh.HAT)
            parts.append(thicken(Pp, Tp, 0.0022, mats=('stringer', 'stringer', 'rim_metal'), rim_tile=0.05))
    return parts


# ------------------------------------------------------------------ upper shell fragment (with the RE-01 stencil + camera port)
UPPER = Frag(L.TH_F + 0.99, L.S_WIN - 0.15, 0.58, 0.50, 0.25, 1.3, 0.22,
             slits=[(0.4, 0.16), (1.9, 0.12), (3.4, 0.18), (4.9, 0.14)],
             curl=[(0.9, 0.35, 70, 0.16), (2.6, 0.4, -40, 0.12), (4.2, 0.35, 85, 0.18), (5.6, 0.3, 30, 0.10)])
FRAG_UV['frag'] = (UPPER.thc - 0.62, UPPER.thc + 0.62, UPPER.sc - 0.62, UPPER.sc + 0.62)


def upper_fragment(det=2):
    fr = UPPER
    hmin, h0 = (0.010, 0.045) if det > 1 else ((0.025, 0.09) if det == 1 else (0.06, 0.2))

    def pos(th, s):
        return surf(th, s) + fr.displacement(th, s) + sh.dent_displacement(th, s)
    P = [frag_sheet(fr, sh.PM_WALL, frag_h(fr, hmin, h0), lambda t, s: fr.keep(t, s), pos, sh.SKIN_T, ('frag_outer', 'skin_back', 'rim_metal'), 'frag')]
    if det >= 1:
        # insulation blanket survives on part of the back, torn back from the edge
        def keep_ins(t, s):
            x, y = fr.xy(t, s)
            return np.minimum(fr.keep(t, s, 0.07, 0.02), 0.25 - x * 0.6 + 0.15 * fbm(x * 4, y * 4, None, 2, seed=SEED + 630))

        def pos_ins(th, s):
            return surf(th, s, -(sh.SKIN_T + 0.003)) + fr.displacement(th, s, 0.3) + sh.dent_displacement(th, s)
        P.append(frag_sheet(fr, sh.PM_WALL, frag_h(fr, hmin * 1.4, h0 * 1.4), keep_ins, pos_ins, 0.030, ('insulation', 'insulation', 'insulation_rim'), None, inner=True, rim_tile=0.06))
        r0 = float(r_of(fr.sc))
        P += hat_stringers(fr, [fr.thc + d / r0 for d in (-0.36, -0.12, 0.12, 0.36)], fr.sc - 0.6, fr.sc + 0.6, 0.04, 0.03 if det > 1 else 0.06)
        # the camera port and one raised access plate travel with the fragment
        Q = dict(detail=det)
        P += ex.camera_port(Q)
        P += ex.raised_plate(fr.thc - 0.30 / r0, fr.sc - 0.30, 0.22, 0.16, 0.005, 'frag_outer_plate', det=det)
    m = Mesh.concat(P)
    m = _plate_uv(m, 'frag')
    return settle(lay_flat(m, fr.thc, fr.sc, (0.18, -0.10), 0.4))


def _plate_uv(m, name):
    """Hardware lofted with the wall atlas name 'frag_outer_plate' -> uv into the fragment's region texture."""
    sel = m.mat == 'frag_outer_plate'
    if sel.any():
        a0, a1, b0, b1 = FRAG_UV[name]
        Pt = m.P[m.T[sel]].reshape(-1, 3)
        th = np.arctan2(Pt[:, 1], Pt[:, 0])
        thc = 0.5 * (a0 + a1)
        th = thc + wrap_angle(th - thc)
        i0 = int(np.argmax(kit.PPIECE == 2))
        s = np.interp(Pt[:, 2], kit.PZ[i0:], kit.PS[i0:])
        uv = np.stack([(th - a0) / (a1 - a0), (s - b0) / (b1 - b0)], 1).reshape(-1, 3, 2)
        m.UV[sel] = uv
        mat = m.mat.copy(); mat[sel] = 'frag_outer'
        m = Mesh(m.P, m.T, m.UV, mat)
    return m


# ------------------------------------------------------------------ impact fragment: crushed, folded skin with layers and a bursting loom
IMPACT = Frag(2.40, S_B0 + 0.70, 0.52, 0.46, -0.4, 2.7, 0.30,
              slits=[(0.2, 0.18), (1.2, 0.14), (2.3, 0.2), (3.3, 0.12), (4.4, 0.16), (5.4, 0.15)],
              curl=[(0.7, 0.3, 100, 0.20), (1.8, 0.3, -60, 0.14), (2.8, 0.35, 120, 0.22), (3.9, 0.3, 50, 0.12), (4.9, 0.3, -45, 0.15), (5.9, 0.3, 80, 0.16)])
FRAG_UV['frag2'] = (IMPACT.thc - 0.62, IMPACT.thc + 0.62, IMPACT.sc - 0.62, IMPACT.sc + 0.62)


def _fold(th, s, fr):
    """A hard crease across the fragment: the far side is folded down ~35 deg about a line, plus crumple."""
    x, y = fr.xy(th, s)
    u = x * 0.8 + y * 0.6 - 0.05
    _, n, tt, ts = surf_frame(th, s)
    fold = np.where(u > 0, u * math.tan(math.radians(34)), 0.0) * 1.0
    soft = 0.03 * np.log1p(np.exp(-np.abs(u) / 0.03))
    crumple = 0.012 * fbm(x * 9, y * 9, None, 3, seed=SEED + 640) + 0.02 * np.sin(x * 23 + 4 * fbm(x * 3, y * 3, None, 2, seed=SEED + 641)) * smoothstep(0.0, 0.25, u)
    return -n * (fold + soft + crumple)[:, None]


def impact_fragment(det=2):
    fr = IMPACT
    hmin, h0 = (0.010, 0.04) if det > 1 else ((0.025, 0.08) if det == 1 else (0.06, 0.2))

    def h_fn(th, s):
        x, y = fr.xy(th, s)
        u = x * 0.8 + y * 0.6 - 0.05
        return np.minimum(frag_h(fr, hmin, h0)(th, s), np.where(np.abs(u) < 0.08, hmin * 1.5, 9.0))

    def pos(th, s):
        return surf(th, s) + fr.displacement(th, s) + _fold(th, s, fr)
    P = [frag_sheet(fr, sh.PM_WALL, h_fn, lambda t, s: fr.keep(t, s), pos, sh.SKIN_T, ('frag2_outer', 'skin_back', 'rim_metal'), 'frag2')]
    if det >= 1:
        def keep_ins(t, s):
            return fr.keep(t, s, 0.05, 0.025)

        def pos_ins(th, s):
            P = surf(th, s, -(sh.SKIN_T + 0.003)) + fr.displacement(th, s, 0.25) + _fold(th, s, fr)
            k = fr.keep(th, s, 0.05)
            return P + surf_frame(th, s)[1] * (0.018 * smoothstep(0.08, 0.0, k))[:, None]
        P.append(frag_sheet(fr, sh.PM_WALL, frag_h(fr, hmin * 1.4, h0 * 1.4), keep_ins, pos_ins, 0.032, ('insulation', 'insulation', 'insulation_rim'), None, rim_tile=0.06))
        r0 = float(r_of(fr.sc))
        ths = [fr.thc + d / r0 for d in (-0.30, -0.10, 0.10, 0.30)]
        for j, th0 in enumerate(ths):
            ss = np.arange(fr.sc - 0.55, fr.sc + 0.55, 0.03 if det > 1 else 0.06)
            th = np.full(len(ss), th0)
            k = fr.keep(th, ss, 0.03, 0.0)
            idx = np.where(k > 0)[0]
            if len(idx) < 3:
                continue
            si, ti = ss[idx], th[idx]
            P0, n, tt, ts = surf_frame(ti, si)
            path = P0 - n * (sh.SKIN_T + 0.034) + fr.displacement(ti, si, 0.4) + _fold(ti, si, fr)
            bend = smoothstep(0.12, 0.0, k[idx])
            path = path - n * (0.08 * bend ** 2)[:, None]
            Pp, Tp = sh._profile_strip(path, tt, n, sh.HAT[::-1] * np.array([1, -1]))
            P.append(thicken(Pp, Tp, 0.0022, mats=('stringer', 'stringer', 'rim_metal'), rim_tile=0.05))
        # a crushed piece of ring frame across the back
        th = np.linspace(fr.thc - 0.45 / r0, fr.thc + 0.45 / r0, 40 if det > 1 else 16)
        ss = np.full(len(th), fr.sc - 0.12)
        k = fr.keep(th, ss, 0.06, 0.0)
        idx = np.where(k > 0)[0]
        if len(idx) > 3:
            ti, si = th[idx], ss[idx]
            P0, n, tt, ts = surf_frame(ti, si)
            base = P0 - n * (sh.SKIN_T + 0.036) + _fold(ti, si, fr)
            prof = np.array([(0.0, 0.0), (0.0, -0.09), (0.03, -0.09)])
            Pp, Tp = sh._profile_strip(base, ts, n, prof * np.array([1, 1]))
            P.append(thicken(Pp, Tp, 0.004, mats=('frame', 'frame', 'rim_metal'), rim_tile=0.05))
        # cable loom bursting out through the tear
        cols = ['cable_orange', 'cable_black', 'cable_blue', 'cable_red', 'cable_white', 'cable_orange', 'cable_yellow', 'cable_black']
        p_base = surf(fr.thc + 0.10 / r0, fr.sc - 0.05, -0.06)
        n0 = surf_frame(fr.thc, fr.sc)[1]
        tdir = surf_frame(fr.thc, fr.sc)[2]
        for k_ in range(8 if det > 1 else 4):
            p0 = p_base + tdir * (0.02 * k_ - 0.07) + n0 * 0.005 * (k_ % 3)
            p1 = p0 + n0 * (0.15 + 0.06 * (k_ % 3)) + tdir * (0.25 + 0.05 * k_) + np.cross(n0, tdir) * (0.08 * (k_ - 4))
            P += cable(p0, p1, 0.05, cols[k_], 0.009 + 0.002 * (k_ % 2), 6, 16, 0.03, tag=700 + k_, d0=n0)
        # P-clamps on the loom
        for k_ in range(2):
            c = p_base + tdir * (-0.12 - 0.08 * k_)
            P.append(box(c, (0.03, 0.12, 0.05), 0.006, np.stack([tdir, np.cross(n0, tdir), n0], 1), 'gunmetal', 0.1, 1))
    return settle(lay_flat(Mesh.concat(P), fr.thc, fr.sc, (0.30, 0.15), -0.7))


# ------------------------------------------------------------------ heat-shield panel: thick ablator on a waffle-ribbed carrier
HSP = Frag(3.90, 1.98, 0.62, 0.40, 0.15, 4.1, 0.18,
           curl=[(1.2, 0.5, -12, 0.25), (4.3, 0.5, 8, 0.2)])
FRAG_UV['fraghs'] = (HSP.thc - 0.70, HSP.thc + 0.70, HSP.sc - 0.62, HSP.sc + 0.62)


def heatshield_panel(det=2):
    fr = HSP
    hmin, h0 = (0.014, 0.05) if det > 1 else ((0.03, 0.10) if det == 1 else (0.07, 0.22))

    def keep_abl(t, s):
        x, y = fr.xy(t, s)
        k = fr.keep(t, s, 0.0, 0.010)
        bite = 0.06 * fbm(x * 5 + 2, y * 5, None, 3, seed=SEED + 650) - 0.02
        return np.minimum(k + bite, (S_E - 0.004 - s) * 3)

    def pos(th, s):
        return surf(th, s) + fr.displacement(th, s)
    P = [frag_sheet(fr, sh.PM_HS, frag_h(fr, hmin, h0), keep_abl, pos, T_ABL, ('frag_hs', 'cabin_dark', 'ablator_rim'), 'fraghs', rim_tile=0.12)]
    # carrier plate under the ablator: extends past it in places, torn
    off = T_ABL + 0.001

    def keep_car(t, s):
        x, y = fr.xy(t, s)
        return np.minimum(fr.keep(t, s, -0.03, 0.008) + 0.05 * fbm(x * 3, y * 3, None, 2, seed=SEED + 652), (S_E - 0.004 - s) * 3)

    def pos_car(th, s):
        return surf(th, s, -off) + fr.displacement(th, s)
    P.append(frag_sheet(fr, sh.PM_HS, frag_h(fr, hmin * 1.3, h0 * 1.3), keep_car, pos_car, 0.005, ('pw_outer', 'structure_back', 'rim_metal'), None, rim_tile=0.06))
    if det >= 1:
        # waffle ribs on the back: grid along theta and s
        r0 = float(r_of(fr.sc))
        step = 0.02 if det > 1 else 0.05
        prof = np.array([(0.0, 0.0), (0.0, -0.032), (0.012, -0.032)])
        for d in np.arange(-0.60, 0.61, 0.15):
            ss = np.arange(fr.sc - 0.55, fr.sc + 0.55, step)
            th = np.full(len(ss), fr.thc + d / r0)
            for line in (0, 1):
                if line == 1:
                    th = fr.thc + np.arange(-0.70, 0.70, step) / r0
                    ss = np.full(len(th), fr.sc + d * 0.7)
                k = keep_car(th, ss) - 0.03
                idx = np.where(k > 0)[0]
                if len(idx) < 3:
                    continue
                for run in np.split(idx, np.where(np.diff(idx) > 1)[0] + 1):
                    if len(run) < 3:
                        continue
                    ti, si = th[run], ss[run]
                    P0, n, tt, ts = surf_frame(ti, si)
                    base = P0 - n * (off + 0.005) + fr.displacement(ti, si)
                    side = tt if line == 0 else ts
                    Pp, Tp = sh._profile_strip(base, side, n, prof)
                    P.append(thicken(Pp, Tp, 0.004, mats=('structure', 'structure', 'rim_metal'), rim_tile=0.05))
        # attach bolts through the carrier at rib crossings
        if det > 1:
            for dx in np.arange(-0.45, 0.46, 0.30):
                for dy in np.arange(-0.30, 0.31, 0.30):
                    th, s = fr.thc + dx / r0, fr.sc + dy * 0.7
                    if keep_car(np.array([th]), np.array([s]))[0] < 0.06:
                        continue
                    Pc, n, _, _ = surf_frame(th, s)
                    pb = Pc - n * (off + 0.005)
                    P.append(cylinder(pb, pb - n * 0.03, 0.009, 6, 'steel_dark', tile=0.05))
                    P.append(cylinder(pb - n * 0.012, pb - n * 0.02, 0.016, 6, 'steel_dark', tile=0.05))
    return settle(lay_flat(Mesh.concat(P), fr.thc, fr.sc, (0.12, -0.08), 0.3))


# ------------------------------------------------------------------ docking collar with separation damage
def collar_ring(det=2):
    R = 0.66
    n = 160 if det > 1 else (72 if det == 1 else 36)
    a0, a1 = 0.0, math.radians(285)
    P = []

    def ring_section(prof, mat, tile=0.3):
        # profile (r, z) revolved over [a0, a1] with ragged ends handled by small end caps
        m = lathe(np.array(prof), n, a0, a1, mat=mat, tile=tile)
        return m
    # main C-channel body: outer wall, top flange with seal groove, inner lip
    body = [(R + 0.10, -0.09), (R + 0.10, 0.07), (R + 0.06, 0.085), (R + 0.06, 0.10), (R - 0.04, 0.10), (R - 0.04, 0.085),
            (R - 0.08, 0.085), (R - 0.08, -0.05), (R - 0.03, -0.09)]
    P.append(ring_section(body[::-1], 'gunmetal'))
    P.append(ring_section([(R + 0.045, 0.101), (R - 0.025, 0.101), (R - 0.025, 0.108), (R + 0.045, 0.108)][::-1], 'rubber', 0.2))
    # torn ends: jagged caps that peel open
    for a, sgn in ((a0, -1), (a1, 1)):
        prof = np.array(body)
        ca, sa = math.cos(a), math.sin(a)
        ring = np.stack([prof[:, 0] * ca, prof[:, 0] * sa, prof[:, 1]], 1)
        cen = ring.mean(0)
        jag = 0.02 * np.sin(np.arange(len(ring)) * 2.3 + a)
        tdir = np.array([-sa, ca, 0.0]) * sgn
        ring = ring + tdir * (jag[:, None] + 0.01)
        Pc = np.concatenate([ring, [cen + tdir * 0.004]])
        K = len(ring)
        Tc = np.array([(K, j, (j + 1) % K) for j in range(K)])
        if np.dot(np.cross(Pc[Tc[0, 1]] - Pc[Tc[0, 0]], Pc[Tc[0, 2]] - Pc[Tc[0, 0]]), tdir) < 0:
            Tc = Tc[:, ::-1]
        P.append(kit.solid(Pc, Tc, 'rim_metal', 0.1))
    # peeled outer skin flap at the a1 end, bent outward
    if det >= 1:
        th = np.linspace(a1 - 0.25, a1 + 0.12, 14)
        zz = np.linspace(-0.09, 0.07, 6)
        pts, uv, T = kit.grid_mesh(th, zz, lambda U, V: np.stack([(R + 0.10) * np.cos(U), (R + 0.10) * np.sin(U), V], -1))
        u = uv[:, 0]
        k = (a1 + 0.10 - 0.06 * np.sin(uv[:, 1] * 40) - 0.04 * (uv[:, 1] + 0.09) / 0.16) - u
        pts, uv, T = kit.clip_mesh(pts, uv, T, k)
        e = smoothstep(a1 - 0.08, a1 + 0.10, uv[:, 0])
        rr = R + 0.10 + 0.10 * e ** 2
        Pp = np.stack([rr * np.cos(uv[:, 0]), rr * np.sin(uv[:, 0]), uv[:, 1] + 0.05 * e ** 2], -1)
        P.append(thicken(Pp, T, 0.006, mats=('gunmetal', 'gunmetal', 'rim_metal'), rim_tile=0.05))
    # 12 latch housings (white covers) with hook latches, every 30 deg where the ring survives
    for k in range(12):
        a = (k + 0.5) * TAU / 12
        if a > a1 - 0.08:
            continue
        Rz = rot((0, 0, 1), a)
        c = np.array([(R + 0.14) * math.cos(a), (R + 0.14) * math.sin(a), 0.0])
        P.append(box(c, (0.09, 0.16, 0.15), 0.014, Rz, 'whitepaint', 0.25, 2 if det > 1 else 1))
        P.append(box(c + Rz @ np.array([0.047, 0, 0.0]), (0.01, 0.11, 0.10), 0.003, Rz, 'gunmetal', 0.2, 1))
        hook = Rz @ rot((0, 1, 0), -0.5 if k % 4 else 0.4)
        P.append(box(c + Rz @ np.array([-0.07, 0, 0.13]), (0.035, 0.05, 0.08), 0.008, hook, 'steel_dark', 0.2, 1))
        if det > 1:
            for sy in (-1, 1):
                P.append(ex.hexbolt(c + Rz @ np.array([0.052, sy * 0.06, 0.05]), Rz[:, 0], 0.008, 0.006))
            P.append(cylinder(c + Rz @ np.array([0.0, -0.085, -0.05]), c + Rz @ np.array([0.0, 0.085, -0.05]), 0.012, 8, 'steel_bright'))
        if det >= 1 and k % 3 == 1:
            P.append(box(c + Rz @ np.array([0.05, 0.05, -0.04]), (0.008, 0.012, 0.012), None, Rz, 'lamp_amber', 0.05, 1))
    # bolt circle on the top flange; sheared bolts sticking out of the torn ends
    if det > 1:
        for k in range(40):
            a = (k + 0.5) * TAU / 40
            if a > a1 - 0.03:
                continue
            P.append(ex.hexbolt(np.array([(R + 0.01) * math.cos(a), (R + 0.01) * math.sin(a), 0.10]), (0, 0, 1), 0.008, 0.006))
    for k, a in enumerate((a1 - 0.02, a1 - 0.05, 0.02, 0.05)):
        ln = 0.05 + 0.02 * (k % 2)
        p = np.array([(R + 0.01) * math.cos(a), (R + 0.01) * math.sin(a), 0.05])
        tdir = np.array([-math.sin(a), math.cos(a), 0.0]) * (1 if a > 1 else -1)
        P.append(cylinder(p, p + tdir * ln + np.array([0, 0, 0.01 * k]), 0.008, 6, 'steel_bright', tile=0.05))
    # pyro / harness cable running round the inner lip, with frayed ends at the break
    if det >= 1:
        ts_ = np.linspace(0.15, a1 - 0.02, 60 if det > 1 else 24)
        path = np.stack([(R - 0.085) * np.cos(ts_), (R - 0.085) * np.sin(ts_), -0.02 + 0.006 * np.sin(ts_ * 9)], 1)
        P.append(sweep(path, 0.012, 8, 'cable_orange', 0.2, cap=True))
        path2 = path.copy(); path2[:, 2] -= 0.03
        P.append(sweep(path2, 0.009, 6, 'cable_black', 0.2, cap=True))
        pe = path[-1]
        P += cable(pe, pe + np.array([0.18, -0.06, -0.12]), 0.06, 'cable_orange', 0.011, 6, 14, 0.03, tag=721)
        P += cable(path2[-1], path2[-1] + np.array([0.10, -0.14, -0.08]), 0.06, 'cable_black', 0.009, 6, 14, 0.03, tag=722)
        P += cable(path[0], path[0] + np.array([0.05, -0.18, -0.10]), 0.05, 'cable_blue', 0.009, 6, 14, 0.03, tag=723)
    m = Mesh.concat(P)
    # separation damage: the ring is sprung open near the break and bent out of plane
    Pp = m.P.copy()
    ang = np.mod(np.arctan2(Pp[:, 1], Pp[:, 0]), TAU)
    e = smoothstep(a1 - 1.3, a1, ang)
    Pp[:, 2] += 0.12 * e ** 2
    rr = np.hypot(Pp[:, 0], Pp[:, 1]) + 0.06 * e ** 2
    Pp[:, 0], Pp[:, 1] = rr * np.cos(ang), rr * np.sin(ang)
    dd = np.exp(-((ang - 2.0) / 0.16) ** 2)
    rr = np.hypot(Pp[:, 0], Pp[:, 1]) - 0.035 * dd * (Pp[:, 2] > 0.0)
    Pp[:, 0], Pp[:, 1] = rr * np.cos(ang), rr * np.sin(ang)
    m = Mesh(Pp, m.T, m.UV, m.mat)
    return settle(m.transformed(rot((1, 0, 0), 0.10)))


# ------------------------------------------------------------------ RCS thruster module
def rcs_thruster(det=2):
    nseg = 32 if det > 1 else (18 if det == 1 else 10)
    P = []
    # mounting plate with bolt holes / bolts
    P.append(box((0, 0, 0.0), (0.34, 0.30, 0.03), 0.008, None, 'gunmetal', 0.25, 2 if det > 1 else 1))
    if det >= 1:
        for sx in (-1, 1):
            for sy in (-1, 1):
                P.append(ex.hexbolt(np.array([sx * 0.14, sy * 0.12, 0.015]), (0, 0, 1), 0.012, 0.008))
    # valve body block, two solenoid valves, heater-wrapped feed lines
    P.append(box((-0.06, 0.0, 0.10), (0.16, 0.20, 0.15), 0.014, None, 'avionics', 0.25, 2 if det > 1 else 1))
    for sy in (-1, 1):
        c = np.array([-0.06, sy * 0.065, 0.20])
        P.append(cylinder(c, c + np.array([0, 0, 0.09]), 0.035, nseg // 2, 'gunmetal'))
        P.append(cylinder(c + np.array([0, 0, 0.09]), c + np.array([0, 0, 0.105]), 0.028, nseg // 2, 'steel_dark'))
        if det > 1:
            for zz in (0.02, 0.05, 0.08):
                P.append(cylinder(c + np.array([0, 0, zz]), c + np.array([0, 0, zz + 0.008]), 0.038, nseg // 2, 'steel_dark'))
    # main thrust chamber + bell along +x (dented lip), and a smaller canted secondary
    main = ex.bell(0.22, 0.03, 0.09, 0.006, nseg, (0.08, 0.05), 'gunmetal', 'nozzle', ribs=2 if det > 1 else 0, dent=0.12)
    P.append(ex.place(main, np.array([0.04, 0.0, 0.10]), np.array([1.0, 0.0, 0.0]), np.array([0, 0, 1.0])))
    P.append(cylinder((-0.0, 0.0, 0.10), (0.05, 0.0, 0.10), 0.058, nseg, 'gunmetal'))
    if det > 1:
        for k in range(8):
            a = k * TAU / 8
            P.append(ex.hexbolt(np.array([0.05, 0.05 * math.cos(a), 0.10 + 0.05 * math.sin(a)]), (1, 0, 0), 0.006, 0.005))
    sec = ex.bell(0.10, 0.014, 0.04, 0.004, max(8, nseg // 2), (0.04, 0.025), 'gunmetal', 'nozzle')
    P.append(ex.place(sec, np.array([0.02, 0.10, 0.06]), np.array([0.5, 0.7, -0.5]) / np.linalg.norm([0.5, 0.7, -0.5])))
    # feed lines: bent tubes from valves to chamber, one snapped
    if det >= 1:
        for k, sy in enumerate((-1, 1)):
            path = np.array([(-0.06, sy * 0.065, 0.20), (-0.06, sy * 0.065, 0.16), (0.0, sy * 0.08, 0.15), (0.04, sy * 0.06, 0.13)])
            if k == 1:
                path = path[:3] + np.array([[0, 0, 0], [0, 0, 0], [0.01, 0.03, 0.02]])
            P.append(sweep(path, 0.010, 8 if det > 1 else 6, 'steel_bright', 0.1))
        P += cable((-0.13, 0.08, 0.12), (-0.30, 0.20, -0.02), 0.08, 'cable_orange', 0.010, 6, 14, 0.03, tag=730)
        P += cable((-0.13, -0.05, 0.12), (-0.28, -0.22, -0.01), 0.06, 'cable_black', 0.011, 6, 14, 0.03, tag=731)
        P += cable((0.0, 0.085, 0.15), (0.14, 0.22, 0.02), 0.05, 'cable_blue', 0.008, 6, 14, 0.02, tag=732)
    # bracket and bent heat shield cover plate
    P.append(box((0.05, -0.12, 0.08), (0.08, 0.012, 0.13), 0.003, rot((1, 0, 0), 0.2), 'gunmetal', 0.2, 1))
    P.append(box((-0.06, 0.0, 0.29), (0.20, 0.22, 0.008), 0.002, rot((0, 1, 0), -0.25), 'whitepaint', 0.3, 1))
    return settle(Mesh.concat(P))


# ------------------------------------------------------------------ antenna, broken
def antenna(det=2):
    n = 20 if det > 1 else (12 if det == 1 else 8)
    P = []
    P.append(lathe(np.array([(0.0, 0.0), (0.10, 0.0), (0.10, 0.014), (0.075, 0.03), (0.055, 0.06), (0.05, 0.09), (0.0, 0.09)])[::-1], n + 8, mat='gunmetal', tile=0.2))
    if det >= 1:
        for k in range(6):
            a = k * TAU / 6
            P.append(ex.hexbolt(np.array([0.082 * math.cos(a), 0.082 * math.sin(a), 0.014]), (0, 0, 1), 0.008, 0.006))
    # boot, mast segments with collars
    P.append(lathe(np.array([(0.0, 0.09), (0.042, 0.09), (0.036, 0.16), (0.0, 0.16)])[::-1], n, mat='rubber', tile=0.2))
    P.append(lathe(np.array([(0.0, 0.16), (0.024, 0.16), (0.022, 0.52), (0.0, 0.52)])[::-1], n, mat='whitepaint', tile=0.2))
    for z in (0.30, 0.50):
        P.append(lathe(np.array([(0.0, z), (0.032, z), (0.032, z + 0.025), (0.0, z + 0.025)])[::-1], n, mat='gunmetal', tile=0.2))
    P.append(lathe(np.array([(0.0, 0.52), (0.016, 0.52), (0.014, 0.74), (0.0, 0.74)])[::-1], n, mat='steel_bright', tile=0.2))
    # snapped tip: flared, burnt fracture
    P.append(lathe(np.array([(0.0, 0.735), (0.015, 0.735), (0.020, 0.75), (0.010, 0.762), (0.0, 0.755)])[::-1], n, mat='burnt', tile=0.1))
    # element arm: hinge block and a long bent element (the concept's angled whip)
    P.append(box((0.03, 0.0, 0.42), (0.04, 0.05, 0.06), 0.008, None, 'gunmetal', 0.2, 1))
    path = np.array([(0.05, 0.0, 0.43), (0.18, 0.02, 0.55), (0.32, 0.05, 0.66), (0.43, 0.09, 0.73), (0.50, 0.14, 0.75)])
    P.append(sweep(path, np.linspace(0.009, 0.005, len(path)), 8 if det > 1 else 5, 'steel_bright', 0.1))
    P.append(lathe(np.array([(0.0, 0.0), (0.012, 0.0), (0.012, 0.04), (0.0, 0.04)])[::-1], 10, mat='gunmetal', tile=0.1, frame=kit.frame_from_normal(path[-1] - path[-2]), origin=path[-1]))
    # loose coax and a torn second element on the ground side
    if det >= 1:
        P += cable((0.0, 0.03, 0.30), (-0.16, 0.18, 0.02), 0.06, 'cable_black', 0.007, 6, 16, 0.02, tag=741)
        P += cable((0.0, -0.03, 0.12), (0.12, -0.20, 0.0), 0.04, 'cable_orange', 0.006, 6, 14, 0.02, tag=742)
        P.append(box((-0.05, 0.0, 0.25), (0.03, 0.04, 0.05), 0.006, None, 'gunmetal', 0.2, 1))
        P.append(sweep(np.array([(-0.06, 0.0, 0.26), (-0.12, 0.0, 0.24), (-0.18, 0.01, 0.19)]), 0.006, 6, 'steel_bright', 0.1))
    # struts
    for k in range(3):
        a = k * TAU / 3 + 0.4
        P.append(cylinder((0.085 * math.cos(a), 0.085 * math.sin(a), 0.012), (0.028 * math.cos(a), 0.028 * math.sin(a), 0.22), 0.007, 6, 'gunmetal'))
    m = Mesh.concat(P)
    # lean the whole mast: the base plate rests on the ground
    return settle(m.transformed(rot((0, 1, 0), 0.10)))


# ------------------------------------------------------------------ instrument unit
def instrument_unit(det=2):
    P = []
    X, Y, Z = 0.56, 0.42, 0.40
    e = 0.024
    bev = 1 if det < 2 else 2
    # angle-section cage
    for sx in (-1, 1):
        for sy in (-1, 1):
            P.append(box((sx * X / 2, sy * Y / 2, 0), (e, e, Z), 0.003, None, 'gunmetal', 0.2, 1))
    for sz in (-1, 1):
        for sy in (-1, 1):
            P.append(box((0, sy * Y / 2, sz * Z / 2), (X, e, e), 0.003, None, 'gunmetal', 0.2, 1))
        for sx in (-1, 1):
            if sx == 1 and sz == 1:
                P.append(box((X / 2 + 0.01, 0.06, Z / 2 + 0.03), (e, Y * 0.6, e), 0.003, rot((1, 0, 0), 0.3), 'gunmetal', 0.2, 1))
                continue
            P.append(box((sx * X / 2, 0, sz * Z / 2), (e, Y, e), 0.003, None, 'gunmetal', 0.2, 1))
    # modules: main electronics stack, spectrometer, power unit
    P += avionics_box(np.array([-0.08, 0.0, -0.08]), np.eye(3), (0.32, 0.30, 0.20), 1, det)
    P.append(box((0.13, 0.04, -0.06), (0.18, 0.26, 0.24), 0.014, None, 'whitepaint', 0.3, bev))
    P.append(box((-0.08, 0.02, 0.10), (0.30, 0.30, 0.12), 0.012, None, 'whitepaint', 0.3, bev))
    # finned radiator on top
    nf = 9 if det > 1 else (5 if det == 1 else 3)
    for k in range(nf):
        x = -0.20 + 0.33 * k / max(nf - 1, 1)
        P.append(box((x, 0.02, 0.185), (0.008, 0.26, 0.06), None, None, 'gunmetal', 0.2, 1))
    P.append(box((-0.035, 0.02, 0.16), (0.36, 0.28, 0.012), 0.003, None, 'gunmetal', 0.2, 1))
    # lens barrel + sunshade on the -y face
    nn = 28 if det > 1 else 14
    P.append(cylinder((0.12, -0.10, -0.04), (0.12, -0.28, -0.04), 0.07, nn, 'gunmetal'))
    P.append(cylinder((0.12, -0.28, -0.04), (0.12, -0.31, -0.04), 0.085, nn, 'steel_dark'))
    P.append(cylinder((0.12, -0.285, -0.04), (0.12, -0.302, -0.04), 0.06, nn, 'glass_opaque'))
    if det >= 1:
        for k in range(3):
            P.append(cylinder((0.12, -0.13 - 0.045 * k, -0.04), (0.12, -0.14 - 0.045 * k, -0.04), 0.077, nn, 'rubber'))
    # connector panel (+x) with plugs and a small status display
    for k in range(4):
        P.append(cylinder((X / 2 + 0.005, -0.13 + 0.07 * k, -0.08), (X / 2 + 0.035, -0.13 + 0.07 * k, -0.08), 0.017, 10 if det > 1 else 6, 'steel_bright'))
    P += screen_panel(np.array([X / 2 + 0.012, 0.05, 0.06]), np.stack([[0, 1, 0], [0, 0, 1], [1, 0, 0]], 1).astype(float), 0.10, 0.06, det)
    # base skid
    P.append(box((0, 0, -Z / 2 - 0.02), (X + 0.08, Y + 0.08, 0.03), 0.006, None, 'gunmetal', 0.25, 1))
    if det >= 1:
        for sx in (-1, 1):
            for sy in (-1, 1):
                P.append(ex.hexbolt(np.array([sx * (X / 2 + 0.02), sy * (Y / 2 + 0.02), -Z / 2 - 0.005]), (0, 0, 1), 0.011, 0.008))
    # torn cable bundle out of the rear with frayed ends
    cols = ('cable_orange', 'cable_blue', 'cable_black', 'cable_red', 'cable_white', 'cable_yellow')
    for k in range(6 if det > 1 else (3 if det == 1 else 1)):
        P += cable((-0.20 + 0.06 * k, Y / 2, 0.0 + 0.02 * (k % 3)), (-0.30 + 0.14 * k, Y / 2 + 0.30 + 0.03 * k, -Z / 2 - 0.02), 0.05 + 0.02 * k, cols[k], 0.011, 6, 16, 0.03, tag=750 + k)
    # torn-off top panel hanging from one hinge
    P.append(box((0.16, -0.02, Z / 2 + 0.10), (0.24, 0.30, 0.010), 0.002, rot((0, 1, 0), -0.75), 'whitepaint', 0.3, 1))
    P.append(cylinder((0.27, -0.16, Z / 2 + 0.01), (0.27, 0.12, Z / 2 + 0.01), 0.008, 8, 'steel_bright'))
    return settle(Mesh.concat(P))
