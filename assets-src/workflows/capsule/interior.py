"""Cabin interior visible through the breach and the windows: floor deck, crew seat, avionics racks beside the tear,
far-wall lockers and console with small screens, cable looms with torn ends, coolant lines, light strips."""
import math

import numpy as np

import kit
import layout as L
import shell as sh
from kit import Mesh, TAU, SEED, S_E, S_B0, STOT, box, cylinder, lathe, sweep, rot, thicken, fbm, smoothstep, hash01, wrap_angle

# inner face of the pressure wall: radius as a function of height
_s = np.linspace(0.05, STOT - 0.02, 600)
_P = sh._pw_pos(np.zeros(len(_s)), _s)
_Rin = _P[:, 0] - sh.PW_T
_Zin = _P[:, 2]
_i = np.argsort(_Zin)
Z_FLOOR = 0.70


def r_in(z):
    """Pressure-wall inner radius at height z (upper side of the bowl)."""
    m = _Zin > 0.55
    return float(np.interp(z, _Zin[m], _Rin[m]))


def wall_frame(th, z, inset):
    """Point on the cabin wall at azimuth th / height z moved inward by inset, and a frame (tangent, up, inward)."""
    r = r_in(z) - inset
    c, s = math.cos(th), math.sin(th)
    p = np.array([r * c, r * s, z])
    inward = np.array([-c, -s, 0.0])
    tang = np.array([-s, c, 0.0])
    return p, np.stack([tang, np.array([0, 0, 1.0]), inward], 1)


def cable(p0, p1, sag=0.1, color='cable_orange', r=0.010, n=6, steps=18, wobble=0.0, tag=0, d0=None, end_cap=True):
    p0, p1 = np.asarray(p0, float), np.asarray(p1, float)
    Lc = np.linalg.norm(p1 - p0)
    if d0 is None:
        h = np.array([p1[0] - p0[0], p1[1] - p0[1], 0.0])
        d0 = h / (np.linalg.norm(h) + 1e-9)
    c1 = p0 + np.asarray(d0, float) * Lc * 0.45
    c2 = p1 + np.array([0, 0, Lc * 0.35 + sag * 0.5])
    t = np.linspace(0, 1, steps)[:, None]
    path = (1 - t) ** 3 * p0 + 3 * (1 - t) ** 2 * t * c1 + 3 * (1 - t) * t ** 2 * c2 + t ** 3 * p1
    if wobble:
        path = path + wobble * np.stack([fbm(t[:, 0] * 3 + tag, 0 * t[:, 0], None, 2, seed=SEED + tag + k) for k in range(3)], 1) * np.sin(np.pi * t)
    out = [sweep(path, r, n, color, 0.2)]
    if end_cap:
        dv = path[-1] - path[-2]
        dv /= np.linalg.norm(dv)
        out.append(cylinder(path[-1], path[-1] + dv * 0.014, r * 0.55, 5, 'copper', tile=0.05))
    return out


def avionics_box(c, R, size, tag, det=2, lamps=True):
    """Bevelled box with a front module panel, connectors, handles and a status lamp. R columns (x, y, z=front)."""
    sx, sy, sz = size
    P = [box(c, size, 0.010, R, 'avionics', 0.25, 1 if det < 2 else 2)]
    P.append(box(c + R @ np.array([0, 0, sz / 2 + 0.003]), (sx * 0.86, sy * 0.80, 0.008), 0.003, R, 'gunmetal', 0.2, 1))
    for sxn in (-1, 1):
        hp = c + R @ np.array([sxn * sx * 0.38, 0, sz / 2 + 0.016])
        P.append(box(hp, (0.016, sy * 0.45, 0.014), 0.004, R, 'steel_bright', 0.1, 1))
    if det > 1:
        for k in range(3):
            q = c + R @ np.array([-sx * 0.18 + k * sx * 0.12, -sy * 0.28, sz / 2 + 0.006])
            P.append(cylinder(q, q + R[:, 2] * 0.03, 0.012, 8, 'steel_dark', tile=0.05))
    if lamps:
        q = c + R @ np.array([sx * 0.22, sy * 0.30, sz / 2 + 0.008])
        P.append(box(q, (0.014, 0.010, 0.006), None, R, ('lamp_green', 'lamp_amber', 'lamp_red')[tag % 3], 0.05, 1))
    return P


def screen_panel(c, R, w, h, det=2):
    """Console bezel with a small emissive display and a row of buttons."""
    P = [box(c, (w + 0.04, h + 0.04, 0.03), 0.008, R, 'gunmetal', 0.2, 1)]
    sc = box(c + R[:, 2] * 0.0155, (w, h, 0.002), None, R, 'screen', 1.0, 1)
    # screen uv: planar 0..1 over the face
    loc = (sc.P - c) @ R
    uv = np.stack([(loc[:, 0] / w + 0.5), (loc[:, 1] / h + 0.5)], 1)
    P.append(Mesh(sc.P, sc.T, uv[sc.T].astype(np.float32), sc.mat))
    if det > 1:
        for k in range(4):
            q = c + R @ np.array([-w / 2 + 0.02 + k * 0.035, -h / 2 - 0.012, 0.016])
            P.append(box(q, (0.018, 0.010, 0.006), None, R, 'lamp_amber' if k == 1 else 'steel_dark', 0.05, 1))
    return P


def seat(det=2):
    """Reclined crew seat on a pedestal, facing the main window (-y)."""
    P = []
    face = L.TH_F
    Rz = rot((0, 0, 1), face + math.pi / 2)        # local -y -> facing direction
    base = np.array([0.0, 0.25, Z_FLOOR])

    def W(p):
        return base + Rz @ np.asarray(p, float)
    # pedestal and frame rails
    P.append(box(W((0, 0, 0.10)), (0.30, 0.36, 0.20), 0.02, Rz, 'gunmetal', 0.25))
    for sx in (-1, 1):
        rail = np.array([W((sx * 0.25, -0.35, 0.30)), W((sx * 0.25, 0.10, 0.28)), W((sx * 0.25, 0.42, 0.62)), W((sx * 0.25, 0.55, 0.98))])
        P.append(sweep(rail, 0.022, 8, 'steel_dark', 0.2))
        P.append(sweep(np.array([W((sx * 0.25, 0.10, 0.28)), W((sx * 0.20, 0.0, 0.20))]), 0.018, 8, 'steel_dark', 0.2))
    # seat pan, back, headrest (orange with dark bolsters)
    Rp = Rz @ rot((1, 0, 0), -0.08)
    P.append(box(W((0, -0.12, 0.33)), (0.44, 0.48, 0.08), 0.03, Rp, 'cushion_orange', 0.2))
    Rb = Rz @ rot((1, 0, 0), -0.62)
    P.append(box(W((0, 0.26, 0.64)), (0.44, 0.10, 0.62), 0.035, Rb, 'cushion_orange', 0.2))
    for sx in (-1, 1):
        P.append(box(W((sx * 0.23, 0.27, 0.64)), (0.06, 0.13, 0.60), 0.025, Rb, 'cushion_dark', 0.2))
        P.append(box(W((sx * 0.23, -0.12, 0.36)), (0.06, 0.46, 0.10), 0.025, Rp, 'cushion_dark', 0.2))
    P.append(box(W((0, 0.47, 1.00)), (0.30, 0.10, 0.20), 0.035, Rb, 'cushion_dark', 0.2))
    # harness straps
    for sx in (-1, 1):
        st = np.array([W((sx * 0.12, 0.30, 0.95)), W((sx * 0.10, 0.13, 0.70)), W((sx * 0.06, -0.02, 0.45)), W((0, -0.10, 0.39))])
        P.append(sweep(st, 0.012, 4, 'cable_black', 0.2))
    P.append(box(W((0, -0.10, 0.40)), (0.07, 0.06, 0.02), 0.008, Rz, 'steel_bright', 0.1, 1))
    # armrest with a control grip
    P.append(box(W((0.30, -0.05, 0.48)), (0.07, 0.36, 0.05), 0.015, Rz, 'cushion_dark', 0.2))
    P.append(cylinder(W((0.30, -0.20, 0.50)), W((0.30, -0.22, 0.62)), 0.022, 10, 'gunmetal'))
    return P


def floor(Q):
    """Cabin floor plate, torn and bent down where the breach crosses it."""
    det = Q['detail']
    rw = r_in(Z_FLOOR) - 0.01
    th = [0.0]
    while th[-1] < TAU - 1e-9:
        d = abs(wrap_angle(th[-1] - L.TH_B))
        th.append(min(TAU, th[-1] + (0.03 if d < 0.5 else 0.16)))
    th = np.array(th)
    rr = np.concatenate([np.linspace(0.05, rw - 0.4, 3), np.linspace(rw - 0.33, rw, 6 if det > 1 else 3)])
    pts, uv, T = kit.grid_mesh(th, rr, lambda U, V: np.stack([V * np.cos(U), V * np.sin(U), np.full_like(U, Z_FLOOR)], -1))

    def keep(t, r):
        d = np.abs(wrap_angle(t - L.TH_B))
        edge = rw - 0.28 * smoothstep(0.42, 0.05, d) - 0.05 * fbm(t * 9, r * 0 + 2, None, 3, seed=SEED + 510)
        return edge - r
    pts, uv, T = kit.clip_mesh(pts, uv, T, keep(uv[:, 0], uv[:, 1]))
    t, r = uv[:, 0], uv[:, 1]
    P = np.stack([r * np.cos(t), r * np.sin(t), np.full(len(t), Z_FLOOR)], -1)
    edge = keep(t, r)
    P[:, 2] -= 0.08 * smoothstep(0.25, 0.0, edge) ** 2 * smoothstep(0.5, 0.1, np.abs(wrap_angle(t - L.TH_B)))
    T = T[:, ::-1] if np.cross(P[T[0, 1]] - P[T[0, 0]], P[T[0, 2]] - P[T[0, 0]])[2] < 0 else T
    m = thicken(P, T, 0.022, mats=('floor', 'cabin_wall', 'rim_metal'), rim_tile=0.06, inner_tile=0.5, uv_outer=kit.box_uv_corners(P, T, 0.6))
    return [m]


def interior(Q):
    det = Q['detail']
    P = []
    P += floor(Q)
    P += seat(det)
    # ---- racks beside the tear (mounted on the frames), partly torn
    for k, (th, z, size) in enumerate(((0.40, 1.02, (0.34, 0.26, 0.22)), (0.42, 1.32, (0.30, 0.22, 0.22)), (-0.43, 1.00, (0.32, 0.30, 0.24)),
                                       (-0.45, 1.34, (0.30, 0.22, 0.20)), (0.52, 0.82, (0.26, 0.16, 0.20)), (-0.30, 1.58, (0.40, 0.14, 0.18)))):
        c, R = wall_frame(th, z, 0.13 + size[2] / 2)
        tilt = rot(R[:, 1], 0.12 * (1 if th > 0 else -1)) if k < 2 else np.eye(3)
        P += avionics_box(c, tilt @ R, size, k, det)
    # rack rails
    for th in (0.40, -0.44):
        a, Ra = wall_frame(th, 0.78, 0.12)
        b, Rb = wall_frame(th, 1.62, 0.12)
        for sx in (-1, 1):
            off = Ra[:, 0] * sx * 0.19
            P.append(box((a + b) / 2 + off, (0.03, 0.86, 0.03), 0.004, Ra, 'gunmetal', 0.2, 1))
    # ---- far wall (seen through the breach): lockers, console with screens, light strip
    far = math.pi
    for k, (dth, z, w, h) in enumerate(((-0.42, 1.05, 0.34, 0.50), (0.0, 0.95, 0.42, 0.36), (0.42, 1.05, 0.34, 0.50), (-0.22, 1.55, 0.36, 0.30), (0.22, 1.55, 0.36, 0.30))):
        c, R = wall_frame(far + dth, z, 0.14)
        P.append(box(c, (w, h, 0.26), 0.012, R, 'cabin_wall', 0.4, 1 if det < 2 else 2))
        P.append(box(c + R[:, 2] * 0.131, (w * 0.9, h * 0.9, 0.006), 0.002, R, 'avionics', 0.3, 1))
        P.append(box(c + R[:, 2] * 0.14 + R[:, 0] * w * 0.36, (0.02, h * 0.3, 0.02), 0.005, R, 'steel_bright', 0.1, 1))
    c, R = wall_frame(far, 1.30, 0.20)
    R2 = R @ rot((1, 0, 0), 0.35)
    P += screen_panel(c, R2, 0.26, 0.16, det)
    c, R = wall_frame(far - 0.30, 1.32, 0.18)
    P += screen_panel(c, R @ rot((1, 0, 0), 0.3), 0.16, 0.11, det)
    for k in range(3):
        c, R = wall_frame(far - 0.5 + k * 0.5, 1.85, 0.10)
        P.append(box(c, (0.30, 0.02, 0.02), 0.004, R, 'lamp_white', 0.1, 1))
    # ---- side wall consoles (seen obliquely through the hole)
    c, R = wall_frame(0.9, 1.25, 0.16)
    P += screen_panel(c, R @ rot((1, 0, 0), 0.25), 0.22, 0.14, det)
    c, R = wall_frame(-0.95, 1.20, 0.16)
    P += screen_panel(c, R @ rot((1, 0, 0), 0.25), 0.20, 0.13, det)
    # ---- main-window console (visible through the glass)
    c, R = wall_frame(L.TH_F, 1.30, 0.32)
    Rc = R @ rot((1, 0, 0), 0.55)
    P.append(box(c, (0.95, 0.34, 0.10), 0.02, Rc, 'gunmetal', 0.3))
    for k, dx in enumerate((-0.30, 0.0, 0.30)):
        P += screen_panel(c + Rc[:, 0] * dx + Rc[:, 2] * 0.05, Rc, 0.22, 0.15, det)
    # ---- under-floor bay: pressure tank and pump visible below the bent floor edge
    c = np.array([1.38, 0.10, 0.50])
    P.append(lathe([(0.0, -0.17), (0.11, -0.15), (0.17, -0.06), (0.17, 0.06), (0.11, 0.15), (0.0, 0.17)][::-1], 24 if det > 1 else 12, mat='gold_foil', tile=0.2, origin=c))
    for sz in (-0.06, 0.06):
        P.append(lathe([(0.172, sz - 0.015), (0.172, sz + 0.015), (0.176, sz + 0.015), (0.176, sz - 0.015)], 24, mat='gunmetal', tile=0.2, origin=c))
    P.append(box((1.45, -0.25, 0.52), (0.20, 0.22, 0.18), 0.015, rot((0, 0, 1), 0.2), 'avionics', 0.25))
    # ---- coolant lines (one snapped at the tear)
    for k, (th, z0, z1) in enumerate(((-0.30, 0.78, 1.75), (-0.26, 0.78, 1.75))):
        pts = []
        for z in np.linspace(z0, z1, 12):
            p, _ = wall_frame(th + 0.02 * math.sin(z * 3), z, 0.09)
            pts.append(p)
        pts = np.array(pts)
        if k == 1:
            pts = pts[:6]
            pts[-2:] += np.array([0.03, 0.06, -0.02]) * np.array([[0.5], [1.0]])
        P.append(sweep(pts, 0.016, 10 if det > 1 else 6, 'steel_bright', 0.2, cap=True))
        for z in (0.95, 1.4):
            if k == 1 and z > 1.2:
                continue
            p, Rr = wall_frame(th, z, 0.09)
            P.append(box(p, (0.05, 0.03, 0.05), 0.006, Rr, 'gunmetal', 0.1, 1))
    # ---- cable looms along the frames, cut at the tear, with ends hanging out of the breach
    cols = ['cable_orange', 'cable_black', 'cable_blue', 'cable_red', 'cable_black', 'cable_yellow', 'cable_black', 'cable_orange']
    for li, (z, side) in enumerate(((1.42, 1), (1.42, -1), (0.92, 1), (0.92, -1))):
        th_end = 0.24 * side
        n_c = 4 if det > 1 else 2
        for k in range(n_c):
            pts = []
            for th in np.linspace(0.95 * side, th_end, 14):
                p, Rr = wall_frame(th, z + 0.022 * (k % 3) - 0.02, 0.105 + 0.02 * (k // 3))
                pts.append(p)
            P.append(sweep(np.array(pts), 0.009, 6, cols[(k + li) % len(cols)], 0.2, cap=True))
        # clamps
        for th in np.linspace(0.85 * side, th_end + 0.08 * side, 4):
            p, Rr = wall_frame(th, z, 0.115)
            P.append(box(p, (0.02, 0.09, 0.07), 0.004, Rr, 'gunmetal', 0.1, 1))
        # torn ends: cables leaving the loom, falling out through the opening
        nh = (3 if z > 1.2 else 2) if det > 1 else 1
        for k in range(nh):
            p0, Rr = wall_frame(th_end + side * 0.01 * k, z + 0.02 * (k % 3) - 0.02, 0.11)
            out = np.array([math.cos(th_end * 0.4), math.sin(th_end * 0.4), 0.0])
            drop = (0.42 if z > 1.2 else 0.12) + 0.06 * k
            p1 = p0 + out * (0.20 + 0.07 * k) + np.array([0, -side * (0.04 + 0.06 * k), -drop])
            P += cable(p0, p1, 0.15, cols[(k * 3 + li) % len(cols)], 0.0085, 6, 18, 0.05, tag=60 + li * 5 + k, d0=out * 0.6 + np.array([0, 0, 0.45]))
    return P
