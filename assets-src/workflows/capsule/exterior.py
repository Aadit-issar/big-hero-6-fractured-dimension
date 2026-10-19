"""Exterior hard-surface hardware of the hero capsule: windows, crew hatch, engine bay, RCS pods, housings,
vents, camera port, rails, shoulder fittings, docking tunnel and the broken antenna stub.

Large pieces are surface-conforming lofts (rounded outlines lifted off the shell) so they sit on the curved
backshell instead of floating; small pieces are bevelled primitives placed in the local surface frame."""
import math

import numpy as np

import kit
import layout as L
from kit import Mesh, TAU, SEED, S_E, S_B0, STOT, r_of, surf, surf_frame, box, cylinder, lathe, sweep, rot, thicken, hash01

D_ON = 2  # detail level of full LOD0


def basis(th, s):
    P, n, tt, ts = surf_frame(th, s)
    return np.asarray(P, float), np.stack([tt, ts, n], 1)


def loc2ts(th0, s0, xy):
    xy = np.asarray(xy, float)
    s = s0 + xy[..., 1]
    return th0 + xy[..., 0] / r_of(s), s


def loc2surf(th0, s0, xy, h):
    """Local metric (x across, y along meridian) around (th0, s0) -> shell point offset h along the normal."""
    th, s = loc2ts(th0, s0, xy)
    return surf(th, s, h)


def offset_loop(poly, d, spacing=0.03):
    """Resample a convex CCW polygon and offset it outward by d (negative = inward)."""
    pts = []
    n = len(poly)
    for i in range(n):
        a, b = poly[i], poly[(i + 1) % n]
        k = max(1, int(np.linalg.norm(b - a) / spacing))
        for j in range(k):
            pts.append(a + (b - a) * j / k)
    pts = np.array(pts)
    return _offset(pts, d)


def _offset(pts, d):
    prev, nxt = np.roll(pts, 1, axis=0), np.roll(pts, -1, axis=0)
    t = nxt - prev
    nm = np.stack([t[:, 1], -t[:, 0]], 1)
    nm /= np.linalg.norm(nm, axis=1, keepdims=True) + 1e-12
    return pts + nm * d


def resample_loop(poly, spacing):
    pts = []
    n = len(poly)
    for i in range(n):
        a, b = poly[i], poly[(i + 1) % n]
        k = max(1, int(round(np.linalg.norm(b - a) / spacing)))
        for j in range(k):
            pts.append(a + (b - a) * j / k)
    return np.array(pts)


def loft(th0, s0, base, offsets, heights, mat, tile=0.25, cap=False, cap_rings=3, flip=False):
    """Rings: base loop offset by offsets[k] at heights[k]; optional cap filling the last ring."""
    K = len(base)
    rings = [loc2surf(th0, s0, _offset(base, d), h) for d, h in zip(offsets, heights)]
    TS = [np.stack(loc2ts(th0, s0, _offset(base, d)), 1) for d in offsets]
    P = np.concatenate(rings)
    T = []
    for k in range(len(rings) - 1):
        for j in range(K):
            j2 = (j + 1) % K
            a, b = k * K + j, k * K + j2
            T += [(a, b + K, b), (a, a + K, b + K)]
    if cap:
        last = _offset(base, offsets[-1])
        c = last.mean(0)
        idx0 = (len(rings) - 1) * K
        prev_ids = list(range(idx0, idx0 + K))
        Pl = [P]
        cur = len(P)
        for r in range(1, cap_rings):
            f = 1 - r / cap_rings
            ring = loc2surf(th0, s0, c + (last - c) * f, heights[-1])
            TS.append(np.stack(loc2ts(th0, s0, c + (last - c) * f), 1))
            Pl.append(ring)
            ids = list(range(cur, cur + K))
            for j in range(K):
                j2 = (j + 1) % K
                T += [(prev_ids[j], ids[j2], prev_ids[j2]), (prev_ids[j], ids[j], ids[j2])]
            prev_ids = ids
            cur += K
        Pl.append(loc2surf(th0, s0, c[None], heights[-1]))
        TS.append(np.stack(loc2ts(th0, s0, c[None]), 1))
        for j in range(K):
            T.append((prev_ids[j], cur, prev_ids[(j + 1) % K]))
        P = np.concatenate(Pl)
    T = np.array(T)
    if flip:
        T = T[:, ::-1]
    if mat == 'wall_outer':
        import shell
        TS = np.concatenate(TS)
        return kit.solid(P, T, mat, tile, uv=shell.atlas_corner_uv(TS[:, 0], TS[:, 1], T, shell.wall_v))
    return kit.solid(P, T, mat, tile)


def hexbolt(p, ax, r=0.009, h=0.007, mat='steel_dark'):
    """Hex head without the hidden bottom cap (18 tris)."""
    ax = np.asarray(ax, float); ax = ax / np.linalg.norm(ax)
    m = cylinder(p - ax * 0.002, p + ax * h, r, 6, mat, tile=0.05)
    keep = np.ones(len(m.T), bool)
    keep[12:18] = False
    return Mesh(m.P, m.T[keep], m.UV[keep], m.mat[keep])


def bolt_ring(th0, s0, loop, h, spacing, r=0.008, mat='steel_dark'):
    pts = resample_loop(loop, spacing)
    out = []
    for q in pts:
        P = loc2surf(th0, s0, q, h)
        n = surf_frame(th0 + q[0] / r_of(s0 + q[1]), s0 + q[1])[1]
        out.append(hexbolt(P, n, r, 0.006, mat))
    return out


# ------------------------------------------------------------------ windows
def window(win, Q):
    name, th0, s0, poly = win
    det = Q['detail']
    sp = 0.035 if det > 1 else 0.07
    base = resample_loop(poly, sp)
    P = []
    # liner: tunnel from the skin cut down through the pressure wall
    P.append(loft(th0, s0, base, [0.0, 0.0, 0.0], [0.004, -0.03, -0.075], 'gunmetal', 0.2, flip=True))
    big = name == 'main'
    w = 0.075 if big else 0.05
    hgt = 0.032 if big else 0.024
    # raised bezel: inner lip, flat top, sloped outer skirt
    P.append(loft(th0, s0, base, [0.0, 0.0, 0.010, w * 0.55, w, w + 0.012], [-0.012, hgt * 0.8, hgt, hgt, hgt * 0.55, -0.002], 'gunmetal', 0.2))
    # glass recessed, with a gasket step
    inner = _offset(base, -0.004)
    gl = loft(th0, s0, inner, [0.0], [-0.016], 'glass', 0.2, cap=True, cap_rings=2)
    P.append(Mesh(gl.P, gl.T[:, ::-1], gl.UV, gl.mat))
    P.append(loft(th0, s0, base, [0.0, -0.006], [-0.012, -0.016], 'rubber', 0.1, flip=True))
    if det > 1:
        P += bolt_ring(th0, s0, _offset(base, w * 0.5), hgt + 0.0005, 0.085 if big else 0.07, 0.0075)
    return P


# ------------------------------------------------------------------ flush / raised plates
def raised_plate(th0, s0, w, h, raise_h=0.006, mat='whitepaint', rad=0.02, screws=True, det=2):
    poly = L.rounded_poly([(-w / 2, -h / 2), (w / 2, -h / 2), (w / 2, h / 2), (-w / 2, h / 2)], rad, 3)
    base = resample_loop(poly, 0.04)
    P = [loft(th0, s0, base, [0.004, 0.0, -0.004], [-0.002, raise_h, raise_h], mat, 0.3, cap=True, cap_rings=3, flip=True)]
    if screws and det > 1:
        for sx in (-1, 1):
            for sy in (-1, 1):
                q = np.array([sx * (w / 2 - 0.022), sy * (h / 2 - 0.022)])
                Pp = loc2surf(th0, s0, q, raise_h)
                P.append(hexbolt(Pp, surf_frame(th0 + q[0] / r_of(s0 + q[1]), s0 + q[1])[1], 0.007, 0.004))
    return P


# ------------------------------------------------------------------ crew hatch
def crew_hatch(Q):
    name, th0, s0, w, h = L.HATCH
    det = Q['detail']
    P = []
    outline = L.rounded_poly([(-w / 2, -h / 2), (w / 2, -h / 2), (w / 2 * 0.92, h / 2), (-w / 2 * 0.92, h / 2)], 0.10, 6)
    base = resample_loop(outline, 0.045 if det > 1 else 0.08)
    # frame ring
    P.append(loft(th0, s0, base, [-0.012, -0.012, 0.0, 0.07, 0.10, 0.11], [0.0, 0.03, 0.036, 0.036, 0.02, -0.003], 'wall_outer', 0.3))
    # door panel (separate, slightly proud, with a perimeter gap)
    door = _offset(base, -0.026)
    P.append(loft(th0, s0, door, [0.0, 0.0, -0.012], [0.008, 0.026, 0.03], 'wall_outer', 0.3, cap=True, cap_rings=4, flip=True))
    P.append(loft(th0, s0, base, [-0.012, -0.026], [0.004, 0.004], 'cabin_dark', 0.2, flip=True))
    # hinges on the -x side
    for yy in (-0.24, 0.22):
        q = np.array([-w / 2 - 0.035, yy])
        Pc, R = basis(th0 + q[0] / r_of(s0 + q[1]), s0 + q[1])
        P.append(box(Pc + R[:, 2] * 0.045, (0.10, 0.12, 0.05), 0.012, R, 'gunmetal', 0.2))
        P.append(cylinder(Pc + R[:, 2] * 0.07 - R[:, 1] * 0.07, Pc + R[:, 2] * 0.07 + R[:, 1] * 0.07, 0.022, 12, 'gunmetal'))
        P.append(cylinder(Pc + R[:, 2] * 0.07 - R[:, 1] * 0.08, Pc + R[:, 2] * 0.07 + R[:, 1] * 0.08, 0.012, 8, 'steel_bright'))
    # latch handle in a recess on the +x side
    q = np.array([w / 2 - 0.13, -0.05])
    Pc, R = basis(th0 + q[0] / r_of(s0 + q[1]), s0 + q[1])
    P.append(box(Pc + R[:, 2] * 0.028, (0.07, 0.24, 0.012), 0.004, R, 'cabin_dark', 0.2, 1))
    P.append(box(Pc + R[:, 2] * 0.05, (0.026, 0.20, 0.022), 0.008, R, 'gunmetal', 0.2))
    for sy in (-1, 1):
        P.append(box(Pc + R[:, 2] * 0.04 + R[:, 1] * sy * 0.10, (0.03, 0.03, 0.03), 0.006, R, 'gunmetal', 0.2))
    # porthole
    q = np.array([0.0, 0.15])
    th1, s1 = th0 + q[0] / r_of(s0 + q[1]), s0 + q[1]
    circ = np.stack([np.cos(np.linspace(0, TAU, 28, endpoint=False)), np.sin(np.linspace(0, TAU, 28, endpoint=False))], 1)
    P.append(loft(th1, s1, circ * 0.11, [0.0, 0.0, 0.025, 0.035], [0.012, 0.05, 0.05, 0.03], 'gunmetal', 0.2))
    gl = loft(th1, s1, circ * 0.11, [0.0], [0.02], 'glass_opaque', 0.2, cap=True, cap_rings=2)
    P.append(Mesh(gl.P, gl.T[:, ::-1], gl.UV, gl.mat))
    if det > 1:
        P += bolt_ring(th1, s1, circ * 0.125, 0.05, 0.05, 0.006)
        P += bolt_ring(th0, s0, _offset(base, 0.045), 0.036, 0.08, 0.008)
        # dogs/latches around the frame
        for k, (qx, qy) in enumerate(((w / 2 + 0.03, 0.25), (w / 2 + 0.03, -0.25), (0.15, h / 2 + 0.035), (-0.15, -h / 2 - 0.035))):
            Pc, R = basis(th0 + qx / r_of(s0 + qy), s0 + qy)
            P.append(box(Pc + R[:, 2] * 0.045, (0.06, 0.05, 0.03), 0.008, R, 'gunmetal', 0.2, 1))
    return P


# ------------------------------------------------------------------ nozzles
def bell(length, r_throat, r_exit, wall=0.008, n=32, chamber=(0.10, 0.06), mat='gunmetal', inner='nozzle', ribs=0, dent=0.0, rows=10):
    """Bell nozzle along local +z (exit at z = length): chamber, throat, bell; real wall with inner liner."""
    zs = np.linspace(0, 1, rows)
    rb = r_throat + (r_exit - r_throat) * (1 - (1 - zs) ** 1.8)
    zc, rc = chamber
    out = [(0.0, 0.0), (rc, 0.0), (rc, -zc * 0.0)]
    prof_out = [(rc * 0.92, -zc), (rc, -zc + 0.01), (rc, -0.015), (r_throat + wall * 1.5, 0.0)]
    prof_out += [(r + wall, z * length) for r, z in zip(rb[1:], zs[1:])]
    lip = [(rb[-1] + wall * 0.4, length + 0.004), (rb[-1] - wall * 0.2, length + 0.004)]
    prof_in = [(r, z * length) for r, z in zip(rb[::-1], zs[::-1])]
    outer_prof = [(0.0, -zc)] + prof_out + lip
    m1 = lathe(np.array(outer_prof)[::-1], n, mat=mat, tile=0.2)
    m2 = lathe(np.array(prof_in + [(0.0, 0.0)]), n, mat=inner, tile=0.2)
    m = Mesh.concat([m1, m2])
    if ribs:
        rr = []
        for k in range(ribs):
            z = length * (0.25 + 0.65 * k / max(ribs - 1, 1))
            r = np.interp(z / length, zs, rb) + wall
            rr.append(lathe([(r + 0.006, z - 0.006), (r + 0.006, z + 0.006), (r - 0.001, z + 0.008), (r - 0.001, z - 0.008)][::-1], n, mat=mat, tile=0.2))
        m = Mesh.concat([m] + rr)
    if dent:
        P = m.P.copy()
        ang = np.arctan2(P[:, 1], P[:, 0])
        w = np.clip(P[:, 2] / length, 0, 1) ** 2
        sc = 1 - dent * w * np.maximum(0, np.cos(ang - 0.7)) ** 3
        P[:, 0] *= sc; P[:, 1] *= sc
        m = Mesh(P, m.T, m.UV, m.mat)
    return m


def place(m, origin, axis, ref=None, roll=0.0):
    F = kit.frame_from_normal(axis, ref)
    if roll:
        F = F @ rot((0, 0, 1), roll)
    return m.transformed(F, origin)


# ------------------------------------------------------------------ rear engine bay
def engine_bay(Q):
    th0, s0, w, h = L.ENGINE_BAY
    det = Q['detail']
    P = []
    outline = L.rounded_poly([(-w / 2, -h / 2), (w / 2, -h / 2), (w / 2 * 0.86, h / 2), (-w / 2 * 0.86, h / 2)], [0.08, 0.08, 0.14, 0.14], 6)
    base = resample_loop(outline, 0.04 if det > 1 else 0.08)
    P.append(loft(th0, s0, base, [0.01, 0.0, -0.035, -0.07], [-0.01, 0.10, 0.165, 0.18], 'gunmetal', 0.3, cap=True, cap_rings=4, flip=True))
    # three nozzles: big centre, two smaller
    for dx, rt, re, ln in ((0.0, 0.075, 0.22, 0.36), (-0.42, 0.055, 0.16, 0.28), (0.42, 0.055, 0.16, 0.28)):
        q = np.array([dx, -0.04])
        th1, s1 = th0 + dx / r_of(s0 + q[1]), s0 + q[1]
        Pc, R = basis(th1, s1)
        ax = R[:, 2] * 0.80 - R[:, 1] * 0.60
        ax /= np.linalg.norm(ax)
        org = Pc + R[:, 2] * 0.12
        nb = bell(ln, rt, re, 0.009, 24 if det > 1 else 12, (0.12, rt * 1.6), 'gunmetal', 'nozzle', ribs=3 if det > 1 else 0, dent=0.10 if dx > 0 else 0.0)
        P.append(place(nb, org, ax, R[:, 0]))
        # mounting flange with bolts
        fl = lathe([(rt * 2.6, -0.02), (rt * 2.6, 0.012), (rt * 1.7, 0.012), (rt * 1.7, -0.02)][::-1], 28 if det > 1 else 14, mat='gunmetal', tile=0.2)
        P.append(place(fl, org - ax * 0.10, ax, R[:, 0]))
        if det > 1:
            F = kit.frame_from_normal(ax, R[:, 0])
            for k in range(10):
                a = k * TAU / 10
                pb = org - ax * 0.088 + F @ np.array([rt * 2.2 * math.cos(a), rt * 2.2 * math.sin(a), 0.0])
                P.append(hexbolt(pb, ax, 0.008, 0.006))
    # side equipment boxes with brackets (rear view)
    for nm, th1, s1, bw, bh in L.HOUSINGS:
        Pc, R = basis(th1, s1)
        P.append(box(Pc + R[:, 2] * 0.07, (bw, bh, 0.12), 0.018, R, 'whitepaint' if nm != 'box_f' else 'gunmetal', 0.3, 1))
        P.append(box(Pc + R[:, 2] * 0.135, (bw * 0.8, bh * 0.75, 0.012), 0.004, R, 'gunmetal', 0.2, 1))
        for sy in (-1, 1):
            P.append(box(Pc + R[:, 2] * 0.02 + R[:, 1] * sy * (bh / 2 + 0.02), (bw * 0.9, 0.035, 0.05), 0.006, R, 'gunmetal', 0.2))
        if det > 1:
            for sx in (-1, 1):
                for sy in (-1, 1):
                    P.append(hexbolt(Pc + R[:, 2] * 0.045 + R[:, 0] * sx * bw * 0.38 + R[:, 1] * sy * (bh / 2 + 0.02), R[:, 2], 0.008, 0.006))
            # conduit into the skin
            p0 = Pc + R[:, 2] * 0.07 - R[:, 1] * (bh / 2)
            p1 = Pc - R[:, 1] * (bh / 2 + 0.18) + R[:, 2] * 0.01
            P.append(sweep(np.array([p0, p0 - R[:, 1] * 0.06, (p0 + p1) / 2 - R[:, 2] * 0.01, p1]), 0.018, 8, 'gunmetal', 0.2))
    return P


# ------------------------------------------------------------------ RCS pods, vents, camera port
def rcs_pod(th0, s0, Q, k):
    det = Q['detail']
    P = []
    poly = L.rounded_poly([(-0.11, -0.085), (0.11, -0.085), (0.10, 0.085), (-0.10, 0.085)], 0.025, 3)
    base = resample_loop(poly, 0.045)
    P.append(loft(th0, s0, base, [0.02, 0.0, 0.0, -0.004], [-0.001, 0.008, -0.03, -0.035], 'gunmetal', 0.2, cap=True, cap_rings=1, flip=True))
    Pc, R = basis(th0, s0)
    dirs = [(0, 0, 1), (0.8, 0, 0.6), (-0.8, 0, 0.6), (0, 0.75, 0.66)] if k % 2 == 0 else [(0, 0, 1), (0, -0.8, 0.6), (0.7, 0, 0.7)]
    offs = [(0, 0), (0.06, -0.02), (-0.06, -0.02), (0, 0.045)]
    for d, o in zip(dirs, offs):
        ax = R @ np.array(d, float)
        ax /= np.linalg.norm(ax)
        org = Pc + R[:, 0] * o[0] + R[:, 1] * o[1] - R[:, 2] * 0.03
        P.append(place(bell(0.045, 0.008, 0.022, 0.003, 10 if det > 1 else 6, (0.02, 0.014), 'gunmetal', 'nozzle', rows=4), org, ax, R[:, 0]))
    return P


def vent(th0, s0, w, h, Q):
    poly = L.rounded_poly([(-w / 2, -h / 2), (w / 2, -h / 2), (w / 2, h / 2), (-w / 2, h / 2)], 0.012, 2)
    base = resample_loop(poly, 0.02)
    P = [loft(th0, s0, base, [0.012, 0.0, 0.0], [0.0, 0.006, -0.02], 'gunmetal', 0.2, flip=True)]
    Pc, R = basis(th0, s0)
    P.append(box(Pc - R[:, 2] * 0.02, (w, h, 0.004), None, R, 'cabin_dark', 0.2, 1))
    nsl = 5
    for i in range(nsl):
        yy = -h / 2 + h * (i + 0.5) / nsl
        Rs = R @ rot((1, 0, 0), 0.6)
        P.append(box(Pc + R[:, 1] * yy - R[:, 2] * 0.006, (w * 0.96, h / nsl * 0.9, 0.003), None, Rs, 'gunmetal', 0.2, 1))
    return P


def camera_port(Q):
    th0, s0 = L.CAMERA_PORT
    circ = np.stack([np.cos(np.linspace(0, TAU, 32, endpoint=False)), np.sin(np.linspace(0, TAU, 32, endpoint=False))], 1)
    P = [loft(th0, s0, circ * 0.085, [0.012, 0.0, 0.0, -0.012, -0.03], [0.0, 0.02, 0.026, 0.026, 0.012], 'gunmetal', 0.2, flip=True)]
    Pc, R = basis(th0, s0)
    ax = R[:, 2] * 0.9 - R[:, 1] * 0.2
    P.append(place(lathe([(0.0, 0.0), (0.045, 0.0), (0.045, 0.05), (0.038, 0.06), (0.0, 0.06)][::-1], 24, mat='gunmetal', tile=0.1), Pc + R[:, 2] * 0.005, ax, R[:, 0]))
    P.append(place(lathe([(0.0, 0.061), (0.032, 0.061), (0.0, 0.07)][::-1], 20, mat='glass_opaque', tile=0.1), Pc + R[:, 2] * 0.005, ax, R[:, 0]))
    P.append(place(lathe([(0.05, 0.05), (0.05, 0.075), (0.047, 0.075), (0.047, 0.05)], 24, mat='gunmetal', tile=0.1), Pc + R[:, 2] * 0.005, ax, R[:, 0]))
    if Q['detail'] > 1:
        P += bolt_ring(th0, s0, circ * 0.07, 0.026, 0.045, 0.006)
    return P


def rails(Q):
    P = []
    for th0, s0, ln, ori in L.RAILS:
        Pc, R = basis(th0, s0)
        d = R[:, 1] if ori == 'v' else R[:, 0]
        a, b = Pc - d * ln / 2, Pc + d * ln / 2
        if ori == 'h':
            a = surf(th0 - ln / 2 / r_of(s0), s0); b = surf(th0 + ln / 2 / r_of(s0), s0)
        na, nb = surf_frame(*_ts(a))[1], surf_frame(*_ts(b))[1]
        path = np.array([a + na * 0.005, a + na * 0.07, a + na * 0.075 + (b - a) * 0.08, b + nb * 0.075 - (b - a) * 0.08, b + nb * 0.07, b + nb * 0.005])
        P.append(sweep(path, 0.014, 10, 'whitepaint', 0.2))
        for e, ne in ((a, na), (b, nb)):
            P.append(cylinder(e - ne * 0.005, e + ne * 0.012, 0.03, 12, 'gunmetal'))
    return P


def _ts(p):
    th = math.atan2(p[1], p[0])
    rr = math.hypot(p[0], p[1])
    i0 = int(np.argmax(kit.PPIECE == 2))
    s = float(np.interp(p[2], kit.PZ[i0:], kit.PS[i0:]))
    return th, s


def shoulder_fittings(Q):
    """Shear/compression pads bridging the heat-shield lip to the backshell, avoiding the breach and engine bay."""
    P = []
    n = 16
    for k in range(n):
        th0 = (k + 0.5) * TAU / n
        if abs(kit.wrap_angle(th0 - L.TH_B)) < 0.55 or abs(kit.wrap_angle(th0 - L.TH_REAR)) < 0.45:
            continue
        Pc, R = basis(th0, S_B0 + 0.035)
        P.append(box(Pc + R[:, 2] * 0.012, (0.09, 0.08, 0.03), 0.008, R, 'gunmetal', 0.2, 1))
        if Q['detail'] > 1:
            P.append(hexbolt(Pc + R[:, 2] * 0.027, R[:, 2], 0.01, 0.006))
    return P


def umbilical(Q):
    th0, s0 = L.TH_HATCH + 1.05, S_B0 + 0.30
    circ = np.stack([np.cos(np.linspace(0, TAU, 28, endpoint=False)), np.sin(np.linspace(0, TAU, 28, endpoint=False))], 1)
    P = [loft(th0, s0, circ * 0.11, [0.01, 0.0, 0.0], [0.0, 0.025, 0.025], 'gunmetal', 0.2, cap=True, cap_rings=2, flip=True)]
    Pc, R = basis(th0, s0)
    for k in range(5):
        a = k * TAU / 5 + 0.3
        q = Pc + R[:, 0] * 0.055 * math.cos(a) + R[:, 1] * 0.055 * math.sin(a)
        P.append(cylinder(q + R[:, 2] * 0.02, q + R[:, 2] * 0.045, 0.016, 10, 'steel_bright'))
        P.append(cylinder(q + R[:, 2] * 0.044, q + R[:, 2] * 0.047, 0.008, 8, 'cabin_dark'))
    return P


# ------------------------------------------------------------------ top: docking tunnel, deck housings, antenna stub
def docking_tunnel(Q):
    det = Q['detail']
    n = 64 if det > 1 else 32
    zt = kit.Z_DECK
    P = []
    # tunnel body: outer wall, top ring with seal, inner wall down to the hatch
    prof = [(0.66, zt - 0.01), (0.66, zt + 0.03), (0.62, zt + 0.05), (0.60, zt + 0.15), (0.615, zt + 0.16), (0.615, zt + 0.195),
            (0.585, zt + 0.205), (0.50, zt + 0.205), (0.48, zt + 0.19), (0.48, zt + 0.07), (0.0, zt + 0.07)]
    P.append(lathe(np.array(prof)[::-1], n, mat='gunmetal', tile=0.3))
    P.append(lathe(np.array([(0.585, zt + 0.206), (0.51, zt + 0.206), (0.51, zt + 0.214), (0.585, zt + 0.214)])[::-1], n, mat='rubber', tile=0.2))
    # inner hatch: dished cover with a hand wheel
    P.append(lathe(np.array([(0.0, zt + 0.11), (0.40, zt + 0.095), (0.44, zt + 0.08), (0.46, zt + 0.071)])[::-1], n // 2, mat='whitepaint', tile=0.3))
    wheel = []
    for k in range(25):
        a = k * TAU / 24
        wheel.append((0.16 * math.cos(a), 0.16 * math.sin(a), zt + 0.15))
    P.append(sweep(np.array(wheel), 0.012, 8, 'gunmetal', 0.2, cap=False))
    for k in range(3):
        a = k * TAU / 3
        P.append(cylinder((0, 0, zt + 0.15), (0.16 * math.cos(a), 0.16 * math.sin(a), zt + 0.15), 0.009, 6, 'gunmetal'))
    P.append(cylinder((0, 0, zt + 0.105), (0, 0, zt + 0.16), 0.035, 12, 'gunmetal'))
    # latches (12 hooks) and guide petals (3)
    for k in range(12):
        a = (k + 0.5) * TAU / 12
        R = rot((0, 0, 1), a)
        c = np.array([0.645 * math.cos(a), 0.645 * math.sin(a), zt + 0.10])
        P.append(box(c, (0.06, 0.07, 0.11), 0.01, R, 'gunmetal', 0.2, 1))
        P.append(box(c + R @ np.array([-0.02, 0, 0.075]), (0.03, 0.04, 0.05), 0.008, R @ rot((0, 1, 0), -0.4), 'steel_dark', 0.2, 1))
    for k in range(3):
        a = k * TAU / 3 + 0.26
        R = rot((0, 0, 1), a) @ rot((0, 1, 0), -0.35)
        c = np.array([0.57 * math.cos(a), 0.57 * math.sin(a), zt + 0.24])
        P.append(box(c, (0.02, 0.16, 0.12), 0.005, R, 'whitepaint', 0.2, 1))
    if det > 1:
        for k in range(24):
            a = (k + 0.25) * TAU / 24
            P.append(hexbolt(np.array([0.555 * math.cos(a), 0.555 * math.sin(a), zt + 0.205]), (0, 0, 1), 0.007, 0.005))
        for k in range(16):
            a = (k + 0.5) * TAU / 16
            P.append(hexbolt(np.array([0.70 * math.cos(a), 0.70 * math.sin(a), zt]), (0, 0, 1), 0.008, 0.006))
    # deck housings
    for k, a in enumerate((0.35, 1.9, 3.3, 4.7)):
        R = rot((0, 0, 1), a)
        c = np.array([0.73 * math.cos(a), 0.73 * math.sin(a), zt + 0.035])
        P.append(box(c, (0.09, 0.16 if k % 2 else 0.11, 0.07), 0.012, R, 'whitepaint', 0.2))
        P.append(box(c + np.array([0, 0, 0.036]), (0.06, 0.10, 0.01), 0.003, R, 'gunmetal', 0.2, 1))
    return P


def antenna_stub(Q):
    """Snapped mast on the deck edge: base, short mast, torn tube end, a bent element; height kept small."""
    a = L.TH_F + 0.55
    zt = kit.Z_DECK
    c = np.array([0.74 * math.cos(a), 0.74 * math.sin(a), zt])
    P = [lathe(np.array([(0.0, 0.0), (0.06, 0.0), (0.06, 0.012), (0.045, 0.03), (0.035, 0.06), (0.0, 0.06)])[::-1], 20, mat='gunmetal', tile=0.2, origin=c)]
    P.append(lathe(np.array([(0.0, 0.06), (0.018, 0.06), (0.016, 0.22), (0.0, 0.22)])[::-1], 12, mat='steel_bright', tile=0.2, origin=c))
    P.append(lathe(np.array([(0.0, 0.215), (0.017, 0.215), (0.022, 0.235), (0.012, 0.245), (0.0, 0.24)])[::-1], 10, mat='burnt', tile=0.1, origin=c))
    path = np.array([c + (0, 0, 0.16), c + (0.04, 0.01, 0.19), c + (0.12, 0.03, 0.20), c + (0.20, 0.07, 0.17)])
    P.append(sweep(path, np.linspace(0.006, 0.003, 4), 6, 'steel_bright', 0.1))
    for k in range(4):
        aa = k * TAU / 4
        P.append(hexbolt(c + np.array([0.048 * math.cos(aa), 0.048 * math.sin(aa), 0.012]), (0, 0, 1), 0.006, 0.005))
    return P


def exterior(Q):
    P = []
    for w in L.WINDOWS:
        P += window(w, Q)
    P += crew_hatch(Q)
    P += engine_bay(Q)
    for k, (th0, s0) in enumerate(L.RCS):
        P += rcs_pod(th0, s0, Q, k)
    for th0, s0, w, h in L.VENTS:
        P += vent(th0, s0, w, h, Q)
    P += camera_port(Q)
    P += rails(Q)
    P += shoulder_fittings(Q)
    P += umbilical(Q)
    for i, (nm, th0, s0, w, h) in enumerate(L.ACCESS):
        if i % 2 == 0:
            P += raised_plate(th0, s0, w, h, 0.005, 'wall_outer', det=Q['detail'])
    P += docking_tunnel(Q)
    P += antenna_stub(Q)
    return P
