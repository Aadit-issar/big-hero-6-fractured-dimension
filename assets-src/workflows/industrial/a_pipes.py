"""Pipe family: hollow pipe (real wall), welded flanges with bolt circles, seam beads, ruptured petal ends.

  industrial_pipe_large_fractured : O.D. 600 mm, 12 mm wall, two spools joined by a flange pair that has opened up
                                    (gap, sheared and missing bolts), seam beads, a lifting lug; the far spool has
                                    burst open into curled petals.
  industrial_pipe_elbow_torn      : O.D. 300 mm long-radius 90 degree elbow with a small flange, a pipe strap, and a
                                    torn spigot."""
import math

import numpy as np

import kit
from kit import M, bolt_assy, box, closed_tube, gauss, merge, plate, torus, tube, tri_wave, weld

SEED = 210


def petal_pipe(L, r, wall, k=4, tongue=0.45, flare=1.0, segs=40, step=0.08, seed=0, phase=0.0):
    """Straight hollow pipe along +x from 0 to L; the end at L has burst into `k` curled petals separated by cracks."""
    jag = lambda kk, th: tongue * (0.5 + 0.5 * tri_wave(k * th + phase + 0.5 * np.sin(2.3 * th + seed))) ** 1.2   # noqa: E731
    m = tube([(0, 0, 0), (L, 0, 0)], r, r - wall, segs=segs, step=step, end_jag=jag, rot0=0.0)
    v = m.v.copy()
    th = np.arctan2(v[:, 2], v[:, 1])
    ln = tongue * (0.5 + 0.5 * tri_wave(k * th + phase + 0.5 * np.sin(2.3 * th + seed))) ** 1.2
    x_start = L - 0.04
    # distance back from the tip of this tongue (0 at the tip); petals curl outward starting a tongue-length below the tip
    tip = L + ln
    u = np.clip((v[:, 0] - (L - 0.25 * tongue - 0.05)) / (0.25 * tongue + 0.05 + ln), 0, 1)
    rad = np.hypot(v[:, 1], v[:, 2])
    rad2 = rad + flare * 0.75 * r * u ** 1.8
    v[:, 1] *= rad2 / np.maximum(rad, 1e-9)
    v[:, 2] *= rad2 / np.maximum(rad, 1e-9)
    v[:, 0] -= flare * 0.85 * ln * u ** 1.6
    v[:, 2] += flare * 0.05 * u ** 2 * np.sin(th * 2 + seed)
    d = np.clip((v[:, 0] - (L - 0.5)) / 0.5, 0, 1)
    return M(v, m.t, np.stack([np.clip(u * 1.2, 0, 1), np.clip(d, 0, 1) * 0.6], 1))


def flange_pair(x, r_pipe, wall, r_fl, n_bolts, thick, gap=0.0, tilt=0.0, bolt_scale=0.85, missing=(), sheared=(), seed=0, face='left'):
    """Welded slip-on flange at station x (plate normal +x), with n_bolts on a bolt circle; returns (plate, bolts)."""
    rb = (r_fl + r_pipe) / 2 + 0.0
    holes = [(rb * math.cos(a), rb * math.sin(a), 0.0115 * bolt_scale / 0.85 * 1.0, 14) for a in np.linspace(0, 2 * math.pi, n_bolts, endpoint=False)]
    outline = kit.circle(r_fl, 48)
    hole_c = kit.circle(r_pipe - wall, 36)
    # plate() supports circular holes only: the bore is cut as a hole with many segments
    holes_all = [(0.0, 0.0, r_pipe - wall, 48)] + holes
    pl = plate(outline, holes_all, thick, (x, 0, 0), (0, 1, 0), (0, 0, 1))
    return pl, rb


def build_large():
    r, wall = 0.30, 0.012
    parts, bolts, welds, rub = [], [], [], []
    xf, gap = 1.60, 0.05
    # spool A (intact), runs 0 -> xf, with a plain open end at x=0 (cut) and a seam bead 0.55 m from the flange
    a = tube([(0.0, 0, 0), (xf, 0, 0)], r, r - wall, segs=40, step=0.12)
    a = a.damage(tear=np.exp(-((a.v[:, 0] - 0.0) / 0.1) ** 2) * 0.6)
    parts.append(a)
    # spool B: starts at xf + gap + flange thickness, bursts at the far end
    xb0 = xf + 0.05
    Lb = 1.9
    b = petal_pipe(Lb, r, wall, k=4, tongue=0.50, flare=1.0, segs=40, step=0.08, seed=1, phase=0.4)
    # spool B is rotated a few degrees about z (the joint has opened on one side) and dropped a little
    Rb = kit.rot_axis((0, 0, 1), math.radians(2.5)) @ kit.rot_axis((0, 1, 0), math.radians(1.8))
    parts.append(b.xf(Rb, (xb0, 0.0, -0.01)))
    # flanges: A at xf, B at xb0 (before the tilt)
    r_fl = 0.40
    for xf_, tilt in ((xf - 0.03, 0.0), (xb0 - 0.0, 1)):
        n = 20
        rb = 0.35
        holes = [(rb * math.cos(t), rb * math.sin(t), 0.012, 14) for t in np.linspace(0, 2 * math.pi, n, endpoint=False)]
        pl = plate(kit.circle(r_fl, 52), [(0, 0, r - wall, 52)] + holes, 0.032, (xf_, 0, 0), (0, 1, 0), (0, 0, 1))
        if tilt:
            pl = M(pl.v @ Rb.T + np.array([0, 0, 0]) * 0 + (np.array([xb0, 0, -0.01]) - Rb @ np.array([xb0, 0, 0])), pl.t, pl.d)
        else:
            pass
        parts.append(pl)
    # gasket: rubber ring in the gap, pushed out on one side
    gk = tube([(xf + 0.002, 0, 0), (xf + gap * 0.9, 0, 0)], 0.37, 0.30, segs=40, step=0.1)
    rub.append(gk)
    # bolts (M20): through both flanges, those on the opened side are stretched/missing/sheared
    for k, t in enumerate(np.linspace(0, 2 * math.pi, 20, endpoint=False)):
        y, z = 0.35 * math.cos(t), 0.35 * math.sin(t)
        if k in (4, 5, 15):
            continue
        shear = 0.085 if k in (3, 6) else 0.0
        bolts.append(bolt_assy((xf - 0.075, y, z), (1, 0, 0), 0.16, scale=0.85, seed=k, sheared=shear, nut=shear == 0))
    # welds: flange fillets, a circumferential seam on each spool and a longitudinal seam on A
    for xx, rr in ((xf - 0.035, r + 0.005), (xb0 + 0.036, r + 0.005)):
        welds.append(torus((xx, 0, 0), (1, 0, 0), rr, 0.009, 60, 6))
    welds.append(torus((0.65, 0, 0), (1, 0, 0), r + 0.002, 0.007, 60, 5))
    welds.append(weld([(x, 0.0, r + 0.002) for x in np.linspace(0.05, xf - 0.08, 60)], SEED + 3, r=0.006))
    welds.append(torus((xb0 + 0.7, 0, 0), (1, 0, 0), r + 0.002, 0.007, 60, 5))
    # lifting lug on top of spool A: 20 mm plate with a hole, weld frame
    lug = plate(kit.rrect(0.16, 0.16, 0.05, 6), [(0, 0.02, 0.032, 18)], 0.02, (0.9, 0.0, r + 0.075), (1, 0, 0), (0, 0, 1))
    lug = M(lug.v, lug.t)
    parts.append(lug.xf(kit.rot_axis((1, 0, 0), math.pi / 2), None) if False else _lug())
    return {'paint': merge(parts), 'bolt': merge(bolts), 'weld': merge(welds), 'rubber': merge(rub)}


def _lug():
    r = 0.30
    base = plate(kit.rrect(0.16, 0.16, 0.05, 6), [(0, 0.02, 0.032, 18)], 0.02, (0.9, 0.0, r + 0.075), (1, 0, 0), (0, 0, 1))
    # plate in the x-z plane at y=0: u=x, v=z; solidify thickness along y. It stands on the pipe crown.
    return base


def build_elbow():
    r, wall = 0.15, 0.008
    R = 0.45
    parts, bolts, welds = [], [], []
    # straight spigot with flange at x = 0 side (flange normal -x), arc 90 degrees in the x-z plane, then torn leg
    lead = 0.55
    pts = [(-lead, 0, 0), (0, 0, 0)]
    arc = [(R * math.sin(a), 0, R * (1 - math.cos(a))) for a in np.linspace(0, math.pi / 2, 24)]
    spig = tube([(-lead, 0, 0), (0.0, 0, 0)], r, r - wall, segs=32, step=0.1)
    el = tube(arc, r, r - wall, segs=32, step=0.06)
    parts += [spig, el]
    # torn leg from the arc end, heading +z
    Rl = kit.rot_from_x((0, 0, 1), up=(1, 0, 0))
    leg = petal_pipe(0.9, r, wall, k=5, tongue=0.28, flare=1.0, segs=32, step=0.06, seed=2, phase=1.0)
    parts.append(leg.xf(Rl, (R, 0, R)))
    # flange at the open end of the spigot
    rb = 0.2
    holes = [(rb * math.cos(t), rb * math.sin(t), 0.0105, 12) for t in np.linspace(0, 2 * math.pi, 8, endpoint=False)]
    pl = plate(kit.circle(0.255, 40), [(0, 0, r - wall, 40)] + holes, 0.026, (-lead - 0.01, 0, 0), (0, 1, 0), (0, 0, 1))
    parts.append(pl)
    for k, t in enumerate(np.linspace(0, 2 * math.pi, 8, endpoint=False)):
        if k == 5:
            continue
        bolts.append(bolt_assy((-lead - 0.06, rb * math.cos(t), rb * math.sin(t)), (1, 0, 0), 0.07, scale=0.7, seed=k, nut=k != 2, sheared=0.0))
    welds.append(torus((-lead + 0.01, 0, 0), (1, 0, 0), r + 0.004, 0.007, 48, 5))
    welds.append(torus((0.0, 0, 0), (1, 0, 0), r + 0.002, 0.006, 48, 5))
    # pipe strap (U-bolt bracket) around the spigot with two bolts and a base plate
    strap = tube([(-0.35, 0, 0), (-0.29, 0, 0)], r + 0.012, r, segs=32, step=0.06)
    parts.append(strap)
    parts.append(box((-0.32, 0, -r - 0.03), 0.12, 0.20, 0.012))
    for sy in (-1, 1):
        bolts.append(bolt_assy((-0.32, sy * (r + 0.030), 0.0), (0, 0, -1), 0.12, scale=0.5, seed=40 + sy))
    paint = merge(parts)
    return {'paint': paint, 'bolt': merge(bolts), 'weld': merge(welds)}


ASSETS = {
    'industrial_pipe_large_fractured': dict(build=build_large, replaces='pipe_large_fractured', category='pipe', label='O.D. 600 pipe, opened flange joint and burst petal end',
                                            paint=(0.10, 0.15, 0.11), rust_gain=1.3, wear_gain=1.0, bevel=0.0),
    'industrial_pipe_elbow_torn': dict(build=build_elbow, replaces='pipe_elbow_torn', category='pipe', label='O.D. 300 long-radius elbow with flange, strap and torn spigot',
                                       paint=(0.45, 0.30, 0.04), rust_gain=1.1, wear_gain=1.0, bevel=0.0),
}
