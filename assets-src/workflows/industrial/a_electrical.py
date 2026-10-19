"""Electrical and cladding: cable bundle with clamps and lugs, broken junction box, ribbed facility panel.

  industrial_cable_bundle      : 7 O.D. 27 mm cables lay-twisted along a curved run, clipped to a tray fragment by steel
                                 clamps, fanning out and ending in crimped copper lugs, one snapped with exposed strands.
  industrial_junction_box_broken : wall enclosure (0.5 x 0.6 x 0.2) with a dented corner, a door hung open and torn, DIN rail,
                                 breakers and terminal blocks, snapped conduits and trailing wires.
  industrial_facility_panel    : 2.4 x 1.2 m ribbed cladding panel with screw fixings, Z-girts, a diagonal fold and a
                                 torn corner (brand-neutral, no logos)."""
import math

import numpy as np

import kit
from kit import M, bolt_assy, box, boxes, channel_outline, fbm, gauss, grid_sheet, merge, plate, profile_sweep, smoothstep, tri_wave, tube, vnoise

SEED = 300


# ------------------------------------------------------------------ cable bundle
def _centerline(L=2.9):
    s = np.linspace(0, L, 80)
    x = s
    y = 0.22 * np.sin(s * 1.5) + 0.12 * smoothstep(1.5, 2.9, s)
    z = 0.04 * np.sin(s * 3.0) - 0.30 * smoothstep(1.7, 2.9, s) ** 1.6 + 0.0
    return np.stack([x, y, z], 1)


def build_cable():
    c = _centerline()
    cc, _ = kit.resample(c, 0.05)
    tan, N, B = kit.transport_frames(cc)
    n = len(cc)
    s = np.linspace(0, 1, n)
    rc = 0.0135
    groups = {'rubber': [], 'cable_red': [], 'cable_blue': [], 'cable_yellow': [], 'copper': []}
    names = ['rubber', 'cable_red', 'rubber', 'cable_blue', 'rubber', 'cable_yellow', 'rubber']
    rng = np.random.default_rng(SEED)
    lugs, strands = [], []
    paint = []
    ends = []
    for i in range(7):
        ring = 0.0 if i == 0 else 0.0275
        phi0 = (i - 1) * math.pi / 3
        # lay twist plus fanning of the free end
        fan = 1.0 + 4.2 * smoothstep(0.62, 1.0, s)
        ang = phi0 + 2.2 * s * 2 * math.pi * 0.35
        ox = (ring * fan * np.cos(ang))[:, None] * N
        oy = (ring * fan * np.sin(ang))[:, None] * B
        path = cc + ox + oy
        if i == 0:
            path = cc.copy()
        # each cable droops differently once it leaves the bundle
        droop = smoothstep(0.7, 1.0, s) ** 1.5
        path[:, 2] -= droop * (0.10 + 0.06 * i) * (1 if i % 2 else 0.6)
        path[:, 1] += droop * 0.04 * (i - 3)
        keep = n if i != 3 else int(n * 0.9)         # one cable is snapped short
        p = path[:keep]
        end = p[-1]
        t = tube(p, rc, None, segs=8, step=0.05, rot0=0.0)
        groups[names[i]].append(t)
        ends.append((i, p[-1], p[-1] - p[-4]))
    # terminations
    for i, e, d in ends:
        d = d / np.linalg.norm(d)
        if i == 3:
            # snapped: ragged jacket stub + fan of exposed copper strands
            for k in range(14):
                a = rng.uniform(0, 2 * math.pi)
                u, v, w = kit.basis(d)
                p0 = e
                bend = 0.05 + 0.1 * rng.random()
                pts = np.array([p0, p0 + d * 0.04 + (u * math.cos(a) + v * math.sin(a)) * 0.01,
                                p0 + d * (0.08 + 0.03 * rng.random()) + (u * math.cos(a) + v * math.sin(a)) * bend,
                                p0 + d * (0.10 + 0.05 * rng.random()) + (u * math.cos(a) + v * math.sin(a)) * bend * 1.5 + np.array([0, 0, -0.04 * rng.random()])])
                groups['copper'].append(tube(pts, 0.0011, None, segs=4, step=0.02))
        else:
            # crimped ring lug: barrel + flat tongue with a hole
            u, v, w = kit.basis(d)
            barrel = tube([e, e + d * 0.045], 0.0105, 0.0085, segs=10, step=0.05)
            groups['copper'].append(barrel)
            tongue = plate(kit.rrect(0.05, 0.026, 0.012, 5), [(0.012, 0, 0.0065, 12)], 0.003, e + d * 0.045, d, v)
            groups['copper'].append(tongue)
    # tray fragment under the first metre, three steel clamps with bolts
    tray = profile_sweep(channel_outline(0.05, 0.30, 0.004, 0.004), [0.0, 0.0, 1.2][:1] + [1.2], lambda P: np.stack([P[:, 0] - 0.05, (P[:, 1] - 0.15) + 0.10, P[:, 2] - 0.085], 1), sub=0.04)[0]
    paint.append(tray)
    bolts = []
    for sc in (0.10, 0.42, 0.78):
        k = int(sc / 1.0 * (n * 0.34))
        k = min(k, n - 5)
        c0, tn = cc[k], tan[k]
        ring = kit.tube([c0 - tn * 0.012, c0 + tn * 0.012], 0.0585, 0.0535, segs=18, step=0.03)
        paint.append(ring)
        paint.append(box(c0 + np.array([0, 0, -0.063]), 0.03, 0.04, 0.012))
        bolts.append(bolt_assy(c0 + np.array([0, 0.0, 0.0585]), (0, 0, -1), 0.012, scale=0.4, seed=k))
    out = {'paint': merge(paint), 'bolt': merge(bolts)}
    for k, v in groups.items():
        if v:
            out[k] = merge(v)
    return out


# ------------------------------------------------------------------ junction box
def build_junction():
    W, H, Dp = 0.50, 0.60, 0.20
    t = 0.0025
    parts, dark, wires, hw = [], [], {'cable_red': [], 'cable_blue': [], 'cable_yellow': [], 'rubber': []}, []
    # body: back plate and four sides (x = depth, y = width, z = height); y in [-W/2, W/2], z in [0, H]
    n_u, n_v = 14, 16
    back = grid_sheet((0, -W / 2, 0), (0, W, 0), (0, 0, H), n_u, n_v, t)
    top = grid_sheet((0, -W / 2, H), (Dp, 0, 0), (0, W, 0), 8, n_u, t)
    bot = grid_sheet((0, -W / 2, 0), (Dp, 0, 0), (0, W, 0), 8, n_u, t)
    lef = grid_sheet((0, -W / 2, 0), (Dp, 0, 0), (0, 0, H), 8, n_v, t)
    rig = grid_sheet((0, W / 2, 0), (Dp, 0, 0), (0, 0, H), 8, n_v, t)
    # impact dent in the lower right front corner, pushing metal inward and crumpling the rim
    C = np.array([Dp, W / 2, 0.0])
    dent_dir = np.array([-0.5, -0.9, 0.55])
    dent_dir /= np.linalg.norm(dent_dir)

    def dent(m):
        d = np.linalg.norm(m.v - C, axis=1)
        k = np.exp(-(d / 0.12) ** 2)
        wob = 1.0 + 0.5 * np.sin(m.v[:, 0] * 60 + m.v[:, 2] * 45)
        v = m.v + dent_dir[None] * (0.045 * k * wob)[:, None]
        return M(v, m.t, np.stack([k * 0.8, k], 1))
    body = [dent(m) for m in (back, top, bot, lef, rig)]
    parts += body
    # front return lips (15 mm) on the four sides
    for m_ in (box((Dp - 0.0075, 0, H - 0.0075), 0.015, W, 0.015), box((Dp - 0.0075, 0, 0.0075), 0.015, W, 0.015)):
        parts.append(dent(m_))
    # door: hung on the left edge, open 78 degrees, torn bottom-right corner, bowed
    nd = 12
    door = grid_sheet((0, 0, 0), (0, W - 0.01, 0), (0, 0, H - 0.01), nd, 16, t)
    v = door.v.copy()
    yy, zz = v[:, 1], v[:, 2]
    v[:, 0] += 0.012 * np.sin(math.pi * yy / W) * np.sin(math.pi * zz / H) + 0.035 * gauss(yy, W * 0.95, 0.12) * gauss(zz, 0.05, 0.14)
    # tear: remove a ragged triangle at the far-bottom corner by collapsing triangles whose centroid is in it
    cen = v[door.t].mean(axis=1)
    cut = (cen[:, 1] / W + (1 - cen[:, 2] / H) * 0.0) > 0.0
    corner = (cen[:, 1] > W * 0.62) & (cen[:, 2] < 0.17 + 0.07 * np.sin(cen[:, 1] * 40)) & (cen[:, 2] < 0.28 * (cen[:, 1] - W * 0.55) / (W * 0.45) + 0.02)
    keep = ~corner
    dm = M(v, door.t[keep], np.zeros((len(v), 2)))
    d_v = np.stack([np.zeros(len(v)), np.zeros(len(v))], 1)
    d_v[:, 0] = np.exp(-(np.linalg.norm(v[:, [1, 2]] - np.array([W, 0.0]), axis=1) / 0.18) ** 2)
    dm.d = d_v
    ang = math.radians(78)
    # hinge axis: x = Dp + t, y = -W/2, vertical; door local y -> outward direction (cos, sin)
    hinge = np.array([Dp + 0.004, -W / 2 + 0.002, 0.005])
    vloc = dm.v
    X = hinge[0] + vloc[:, 1] * math.sin(ang) + vloc[:, 0] * math.cos(ang)
    Y = hinge[1] + vloc[:, 1] * math.cos(ang) * 1.0 * (-1) * (-1) - vloc[:, 0] * math.sin(ang) * 0
    Y = hinge[1] + vloc[:, 1] * math.cos(ang) - vloc[:, 0] * math.sin(ang)
    parts.append(M(np.stack([X, Y, hinge[2] + vloc[:, 2]], 1), dm.t, dm.d))
    # hinges (two knuckles) and the latch handle
    for hz in (0.12, 0.48):
        parts.append(tube([(Dp + 0.004, -W / 2 + 0.002, hz - 0.03), (Dp + 0.004, -W / 2 + 0.002, hz + 0.03)], 0.007, 0.0035, segs=10, step=0.06))
    # mounting plate, DIN rail and devices inside
    parts.append(box((0.012, 0, H / 2), 0.004, W - 0.06, H - 0.06))
    for z in (0.18, 0.36):
        parts.append(box((0.022, 0, z), 0.012, W - 0.12, 0.035))                       # DIN rail
        n_dev = 12 if z < 0.3 else 9
        for k in range(n_dev):
            if z > 0.3 and k in (4, 5):
                continue                                                               # missing breakers
            wx = 0.018 if k % 3 else 0.036
            yc = -W / 2 + 0.07 + k * 0.03 + (0.01 if k > 5 else 0)
            dark.append(box((0.046, yc, z), 0.040, 0.0165, 0.085 if z > 0.3 else 0.06))
            hw.append(box((0.067, yc, z + (0.015 if k % 2 else -0.015)), 0.006, 0.008, 0.016))
    # conduits: top, one long and snapped/bent, one stub with lock-nut; bottom gland with trailing wires
    parts.append(tube([(0.07, -0.12, H), (0.07, -0.12, H + 0.14), (0.075, -0.12, H + 0.32), (0.16, -0.10, H + 0.52)], 0.0125, 0.0105, segs=10, step=0.05, end_jag=lambda k, th: 0.02 * np.abs(np.sin(th * 2.5))))
    parts.append(tube([(0.07, 0.10, H), (0.07, 0.10, H + 0.09)], 0.0125, 0.0105, segs=10, step=0.05))
    for xz in ((0.07, -0.12), (0.07, 0.10)):
        parts.append(tube([(xz[0], xz[1], H + 0.0), (xz[0], xz[1], H + 0.012)], 0.022, 0.0125, segs=6, step=0.02))
    cols = ['cable_red', 'cable_blue', 'cable_yellow', 'rubber', 'cable_red', 'rubber']
    for k, c in enumerate(cols):
        y0 = -0.12 + k * 0.045
        pts = np.array([(0.08, y0, 0.01), (0.09, y0 + 0.003, -0.05), (0.12 + 0.02 * k, y0 + 0.02 * (k - 2), -0.20 - 0.03 * k), (0.2 + 0.04 * k, y0 + 0.08 * (k - 2), -0.43 - 0.02 * k)])
        wires[c].append(tube(pts, 0.004, None, segs=6, step=0.05))
    # bottom gland plate
    parts.append(tube([(0.08, 0.0, -0.002), (0.08, 0.0, 0.006)], 0.05, 0.0, segs=14, step=0.01))
    out = {'paint': merge(parts), 'dark': merge(dark), 'bolt': merge(hw)}
    for c, v in wires.items():
        if v:
            out[c] = merge(v)
    # note: 'bolt' group reused for terminal screws (zinc)
    return out


# ------------------------------------------------------------------ cladding panel
def build_panel():
    Lp, Wp = 2.4, 1.2
    pitch, depth, tp = 0.15, 0.040, 0.0012
    # trapezoidal rib profile across y: one pitch = flat valley, sloped web, flat crest, sloped web
    top = []
    nrib = int(Wp / pitch)
    for r in range(nrib):
        y0 = -Wp / 2 + r * pitch
        top += [(y0, 0.0), (y0 + 0.035, 0.0), (y0 + 0.050, depth), (y0 + 0.100, depth), (y0 + 0.115, 0.0)]
    top += [(Wp / 2, 0.0)]
    top = np.array(top)
    # thin-wall outline: crest line then the same line offset inward by the sheet thickness, closed
    bot = top[::-1] + np.array([0.0, tp])
    outline = np.concatenate([top, bot])
    # the profile is open: we need a valid closed polygon; offset in z and wind CCW (y increases along the top)
    outline = np.concatenate([top, top[::-1] + np.array([0.0, -tp * 1.0])])
    # (y, z) with z = crest height; lower line is the same shape shifted down by tp, so winding is closed
    L = Lp
    fold_c = np.array([1.15, 0.05])           # fold line passes through (s, y) = here, direction at 32 degrees from y
    fold_ang = math.radians(32)
    nrm = np.array([math.cos(fold_ang), -math.sin(fold_ang)])    # signed distance to the fold line in the (s, y) plane
    bend = math.radians(38)

    def deform(P):
        s, y, z = P[:, 0], P[:, 1], P[:, 2]
        d = (s - fold_c[0]) * nrm[0] + (y - fold_c[1]) * nrm[1]
        t = smoothstep(-0.04, 0.05, d)
        env = gauss(d, 0.0, 0.22)
        # crumple on the rib crests near the fold
        z2 = z - env * 0.020 * (z > depth * 0.5) * (0.5 + 0.5 * tri_wave(y * 55.0 + s * 20.0))
        z2 = z2 + 0.006 * env * np.sin(s * 40.0)
        th = bend * t
        # rotate the far flap about the fold line (axis in the s-y plane along (sin, cos))
        ax = np.array([math.sin(fold_ang), math.cos(fold_ang), 0.0])
        pts = np.stack([s - fold_c[0], y - fold_c[1], z2], 1)
        dpar = pts @ ax
        perp = pts - dpar[:, None] * ax[None]
        c, sn = np.cos(th)[:, None], np.sin(th)[:, None]
        rot = perp * c + np.cross(ax[None], perp) * sn
        out = dpar[:, None] * ax[None] + rot
        out[:, 0] += fold_c[0]
        out[:, 1] += fold_c[1]
        # whole panel bows a little
        out[:, 2] += 0.02 * np.sin(math.pi * np.clip(s / L, 0, 1)) * (1 - t)
        return out
    stations = np.unique(np.concatenate([np.linspace(0, L, 13), np.linspace(0.85, 1.45, 28)]))

    def jag_far(y, z):
        # a torn corner: the +y end of the sheet is eaten back diagonally, ragged
        k = smoothstep(0.05, 0.55, y)
        return -(0.62 * k + 0.05 * k * np.tanh(2 * fbm(y * 14.0, 0 * y + 2.0, None, 2, seed=SEED))) + 0.0 * z
    sub = 0.022
    m, rest = profile_sweep(outline[::-1], stations, deform, sub=sub, jag_end=(None, jag_far), cap_start=False, cap_end=False)
    tear = gauss(rest[:, 0], L, 0.15) * smoothstep(0.1, 0.5, rest[:, 1])
    fold = gauss((rest[:, 0] - fold_c[0]) * nrm[0] + (rest[:, 1] - fold_c[1]) * nrm[1], 0, 0.15)
    m.d = np.stack([tear, fold], 1)
    parts, hw = [m], []
    # Z-girts behind the panel (running across y), with screws through the crest-sheet valleys
    zg = channel_outline(0.04, 0.06, 0.002, 0.002)
    for sg in (0.45, 1.75):
        g, _ = profile_sweep(zg, [0.0, Wp - 0.02], lambda P, sg=sg: np.stack([sg - 0.03 + P[:, 1], -Wp / 2 + 0.01 + P[:, 0], -0.034 + P[:, 2]], 1), sub=0.03)
        parts.append(g)
    # screw fixings along the valleys at each girt: hex-head self-drillers with washers; a few popped
    for gi, sg in enumerate((0.45, 1.75)):
        for r in range(nrib):
            y = -Wp / 2 + r * pitch + 0.0175
            d_ = (sg - fold_c[0]) * nrm[0] + (y - fold_c[1]) * nrm[1]
            if (gi == 1 and r in (2, 3, 4)):
                continue                                        # torn out
            hw.append(bolt_assy((sg, y, 0.0006), (0, 0, -1), 0.003, scale=0.2, seed=r + 10 * gi, nut=False))
    return {'paint': merge(parts), 'bolt': merge(hw)}


ASSETS = {
    'industrial_cable_bundle': dict(build=build_cable, replaces='cable_bundle', category='electrical', label='Lay-twisted 7-cable bundle with clamps, lugs and a snapped conductor',
                                    paint=(0.30, 0.31, 0.33), rust_gain=0.5, wear_gain=1.0, bevel=0.0),
    'industrial_junction_box_broken': dict(build=build_junction, replaces='junction_box_broken', category='electrical', label='Wall junction box with dented corner, torn open door, DIN rail devices and trailing wires',
                                           paint=(0.30, 0.33, 0.34), rust_gain=0.7, wear_gain=1.2, bevel=0.0),
    'industrial_facility_panel': dict(build=build_panel, replaces='facility_panel_krei', category='panel', label='Ribbed cladding panel 2.4 x 1.2 m with Z-girts, diagonal fold and torn corner (no logos)',
                                      paint=(0.32, 0.39, 0.44), rust_gain=0.8, wear_gain=1.1, bevel=0.0),
}
