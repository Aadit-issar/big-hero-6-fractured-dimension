"""Scaffold family: tube (O.D. 48.3 mm, 3.2 mm wall), right-angle couplers, base jacks, braces, boards.

  industrial_scaffold_section : an assembled 2 m x 1 m bay, three lifts, with a buckled standard, a dropped ledger
                                and a hanging brace (the collapse the rest of the bay survived).
  industrial_scaffold_pole_bent : a single long standard kinked with a crushed (ovalised) tube, still wearing its
                                coupler, a ledger stub and a base jack; the upper end is torn off ragged."""
import math

import numpy as np

import kit
from kit import M, bolt_assy, box, boxes, fbm, merge, plate, tube, vnoise

R_OUT, R_IN = 0.02415, 0.02095
SEED = 90


def stub(path, **kw):
    return tube(path, R_OUT, R_IN, segs=12, step=kw.pop('step', 0.25), **kw)


def collar(p, axis, length=0.055, r=0.0345):
    a = np.asarray(axis, float)
    a = a / np.linalg.norm(a)
    p = np.asarray(p, float)
    return tube([p - a * length / 2, p + a * length / 2], r, R_OUT, segs=10, step=length)


def coupler(p, axis_a, axis_b, seed=0, loose=False):
    """Right-angle coupler: two collars, a forged web, and a tightening bolt with a hex nut."""
    a = np.asarray(axis_a, float) / np.linalg.norm(axis_a)
    b = np.asarray(axis_b, float) / np.linalg.norm(axis_b)
    n = np.cross(a, b)
    n /= max(np.linalg.norm(n), 1e-9)
    pa = np.asarray(p, float) - n * R_OUT          # tube A sits under
    pb = np.asarray(p, float) + n * R_OUT
    parts = [collar(pa, a), collar(pb, b)]
    # forged web between the collars
    web = box(np.asarray(p, float), 0.05, 0.05, 0.026)
    R = np.stack([a, np.cross(n, a), n], axis=1)
    parts.append(kit.M(web.v @ np.eye(3), web.t) if False else box((0, 0, 0), 0.052, 0.052, 0.030).xf(R, p))
    # bolt: axis along tube A direction offset, head on one side
    side = np.cross(n, a)
    bp = np.asarray(p, float) + side * 0.036 + n * 0.0
    parts.append(bolt_assy(bp, -side, 0.02, scale=0.55, seed=seed, nut=not loose))
    return merge(parts)


def base_jack(x, y, z0, height=0.30, seed=0):
    parts = [box((x, y, z0 + 0.003), 0.15, 0.15, 0.006)]
    stem = tube([(x, y, z0 + 0.006), (x, y, z0 + height)], 0.0165, None, segs=10, step=height)
    parts.append(stem)
    # adjusting wing nut
    nut = tube([(x, y, z0 + 0.10), (x, y, z0 + 0.125)], 0.026, 0.0165, segs=6, step=0.03)
    parts.append(nut)
    parts.append(box((x + 0.034, y, z0 + 0.112), 0.030, 0.012, 0.020))
    parts.append(box((x - 0.034, y, z0 + 0.112), 0.030, 0.012, 0.020))
    parts.append(box((x, y, z0 + height - 0.002), 0.052, 0.052, 0.004))     # top plate that carries the standard
    return merge(parts)


def torn_end(seed, amp=0.045):
    def f(k, th):
        return amp * (0.5 + 0.5 * np.tanh(2 * fbm(th * 1.4, 0 * th + seed, None, 2, seed=seed))) * (0.6 + 0.8 * np.abs(np.sin(th * 2.0 + seed)))
    return f


# ------------------------------------------------------------------ bay
def build_section():
    X, Y = 2.0, 1.0
    H = 3.3
    z_base = 0.30                      # jack extension
    lifts = [0.55, 1.55, 2.55]
    rng = np.random.default_rng(SEED)
    tubes, coup, jacks, boards = [], [], [], []
    corner = [(0, 0), (X, 0), (0, Y), (X, Y)]
    buckled = (X, Y)                   # the standard that gave way

    def standard_path(cx, cy):
        zs = np.linspace(z_base, H, 40)
        if (cx, cy) == buckled:
            # buckle at z ~ 1.6: kink, leaning into the bay; top torn off at 2.7
            xs = np.full_like(zs, cx)
            lean = np.where(zs > 1.55, (zs - 1.55) * math.tan(math.radians(22)), 0.0)
            ys = np.full_like(zs, cy) - lean * 0.9
            xs = xs - 0.35 * lean
            keep = zs <= 2.75
            return np.stack([xs, ys, zs], 1)[keep]
        return np.stack([np.full_like(zs, cx), np.full_like(zs, cy), zs], 1)

    for k, (cx, cy) in enumerate(corner):
        pth = standard_path(cx, cy)
        ender = (cx, cy) == buckled
        t = tube(pth, R_OUT, R_IN, segs=12, step=0.12, end_jag=torn_end(7, 0.05) if ender else None)
        if ender:
            t = t.damage(tear=np.exp(-((t.v[:, 2] - 2.75) / 0.2) ** 2), crumple=np.exp(-((t.v[:, 2] - 1.55) / 0.15) ** 2))
        tubes.append(t)
        jacks.append(base_jack(cx, cy, 0.0, 0.30, k))
    # ledgers (x direction, on the inside of the standards) and transoms (y direction, on top of the ledgers)
    for li, z in enumerate(lifts):
        for cy, sgn in ((0.0, 1), (Y, -1)):
            yy = cy + sgn * 2 * R_OUT
            xs0, xs1 = 0.0, X
            dropped = (li == 1 and cy == Y)          # this ledger lost its right-hand coupler: it hangs from the left
            if dropped:
                ang = math.radians(-38)
                p0 = np.array([0.0, yy, z])
                p1 = p0 + np.array([math.cos(ang) * X * 0.97, 0.05, math.sin(ang) * X * 0.97])
                pts_ = np.linspace(p0, p1, 14)
                lt = tube(pts_, R_OUT, R_IN, segs=12, step=0.3, end_jag=torn_end(3, 0.02))
                tubes.append(lt)
                coup.append(coupler(p0, (1, 0, 0), (0, 1, 0), seed=li))
                continue
            tubes.append(tube([(xs0 - 0.12, yy, z), (xs1 + 0.12, yy, z)], R_OUT, R_IN, segs=12, step=0.4))
            for x in (0.0, X):
                coup.append(coupler((x, yy, z), (1, 0, 0), (0, 1, 0), seed=li * 7 + int(x)))
        for x, sgn in ((0.0, 1), (X, -1)):
            if li == 2 and x == X:
                continue                                  # top transom on the failed side went with the standard
            xx = x + sgn * 2 * R_OUT
            zz = z + 2 * R_OUT
            tubes.append(tube([(xx, -0.12, zz), (xx, Y + 0.12, zz)], R_OUT, R_IN, segs=12, step=0.4))
            for y in (0.0 + 2 * R_OUT, Y - 2 * R_OUT):
                coup.append(coupler((xx, y, zz), (0, 1, 0), (1, 0, 0), seed=li * 5 + int(y * 10)))
    # diagonal brace on the y = 0 face (clipped to two swivel couplers); one end has pulled away and swings free
    b0 = np.array([0.0, -2 * R_OUT - 0.002, lifts[0] + 0.1])
    b1 = np.array([X, -2 * R_OUT - 0.002, lifts[2] - 0.1])
    d = (b1 - b0) / np.linalg.norm(b1 - b0)
    tubes.append(tube([b0 - d * 0.1, b1 + d * 0.1], R_OUT, R_IN, segs=12, step=0.4))
    coup.append(coupler(b0, (0, 0, 1), d, seed=3))
    coup.append(coupler(b1, (0, 0, 1), d, seed=4, loose=True))
    # a second brace on the far face that has fallen, bent over the lower ledger
    q0 = np.array([0.0, Y + 2 * R_OUT + 0.002, lifts[1] + 0.1])
    q1 = q0 + np.array([1.15, 0.30, -0.95])
    bend = np.array([q0, (q0 + q1) / 2 + np.array([0.0, 0.10, 0.07]), q1])
    tubes.append(tube(bend, R_OUT, R_IN, segs=12, step=0.12, end_jag=torn_end(5, 0.03)))
    coup.append(coupler(q0, (0, 0, 1), (q1 - q0), seed=9))
    # platform boards on the middle lift: three 225 x 38 mm boards, one cracked and sagging
    zb = lifts[1] + 4 * R_OUT + 0.019
    for i, yc in enumerate((0.19, 0.47, 0.75)):
        if i == 2:
            # snapped board: two half boards, the right one dropped on to the ledger
            boards.append(box((0.45, yc, zb), 0.90, 0.225, 0.038))
            br = box((0.0, 0.0, 0.0), 0.78, 0.225, 0.038)
            rr = kit.rot_axis((0, 1, 0), math.radians(24))
            boards.append(br.xf(rr, (1.55, yc, zb - 0.12)))
        else:
            boards.append(box((X / 2, yc, zb), X + 0.1, 0.225, 0.038))
    zinc = merge(tubes + coup + jacks)
    return {'paint': zinc, 'wood': merge(boards)}


# ------------------------------------------------------------------ bent pole
def build_pole():
    z0 = 0.30
    L = 4.4
    kink = 2.15
    ang = math.radians(48)
    up = np.array([0, 0, 1.0])
    a = np.array([0.0, 0.0, z0])
    k = a + up * kink
    dirn = np.array([math.sin(ang) * 0.94, math.sin(ang) * 0.34, math.cos(ang)])
    e = k + dirn * (L - kink)
    # slightly bowed upper limb and a sharp elbow with a short transition
    n = 60
    lower = np.linspace(a, k - up * 0.07, 14)
    elbow = np.array([k - up * 0.04, k + up * 0.0 + dirn * 0.0, k + dirn * 0.05])
    upper_t = np.linspace(0.08, 1.0, 26)
    upper = np.array([k + dirn * (L - kink) * t + np.array([0, 0, -0.03]) * math.sin(t * math.pi) for t in upper_t])
    path = np.concatenate([lower, elbow, upper])
    L_tot = np.linalg.norm(np.diff(path, axis=0), axis=1).sum()
    sk = (np.linalg.norm(np.diff(path[:len(lower) + 1], axis=0), axis=1).sum()) / L_tot

    def oval(s):
        # at the kink the tube is crushed flat (long axis across the fold) and pinched
        w = math.exp(-(((s - sk) / 0.04) ** 2))
        return 1.0 + 0.42 * w, 1.0 - 0.52 * w
    pole = tube(path, R_OUT, R_IN, segs=14, step=0.05, oval=oval, end_jag=torn_end(11, 0.07))
    sv = np.linalg.norm(pole.v - k, axis=1)
    pole = pole.damage(tear=np.exp(-(np.linalg.norm(pole.v - e, axis=1) / 0.25) ** 2), crumple=np.exp(-(sv / 0.2) ** 2))
    parts = [pole, base_jack(0, 0, 0.0, 0.30, 1)]
    # couplers: a right-angle coupler with a ledger stub, and a swivel coupler further up with a bent brace stub
    parts.append(coupler((0, 0.0, 0.85), (0, 0, 1), (0, 1, 0), seed=2))
    parts.append(tube([(0.0, 0.0 + 2 * R_OUT, 0.85), (0.0, 0.40, 0.85), (0.02, 0.62, 0.80), (0.10, 0.74, 0.70)], R_OUT, R_IN, segs=12, step=0.1, end_jag=torn_end(4, 0.025)))
    parts.append(coupler((0, 0, 1.45), (0, 0, 1), (1, 0, 0), seed=3, loose=True))
    return {'paint': merge(parts)}


ASSETS = {
    'industrial_scaffold_section': dict(build=build_section, replaces='scaffold_section', category='scaffold', label='Scaffold bay, 3 lifts, buckled standard and dropped ledger',
                                        paint=(0.30, 0.31, 0.33), rust_gain=0.7, wear_gain=1.1, bevel=0.0),
    'industrial_scaffold_pole_bent': dict(build=build_pole, replaces='scaffold_pole_bent', category='scaffold', label='Kinked scaffold standard with coupler, ledger stub and base jack',
                                          paint=(0.30, 0.31, 0.33), rust_gain=0.8, wear_gain=1.1, bevel=0.0),
}
