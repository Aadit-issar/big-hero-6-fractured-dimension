"""Industrial walkway family: channel stringers, cross members, open bar grating, toe plates, posts and two rails.

  industrial_walkway_section : intact 3 m x 1 m catwalk, 1.05 m rail, galvanised grey, light wear.
  industrial_walkway_torn    : the same kit after a collapse: dropped hinge, missing grating, snapped stringer,
                               bent and broken rails, crumpled toe plate (safety-yellow paint worn through)."""
import math

import numpy as np

import kit
from kit import M, bolt_assy, box, boxes, channel_outline, fbm, gauss, grating, merge, profile_sweep, smoothstep, tube, vnoise

W = 1.0
R_RAIL, R_RAIL_IN = 0.0212, 0.0180          # DN32 rail tube
SEED = 140


def frame_parts(L, torn=False):
    parts = {'frame': [], 'grate': [], 'rails': [], 'toe': [], 'hw': []}
    # stringers: C channels 150 x 50, flanges facing inward; deck top at z = 0
    zc = -0.03 - 0.075
    for sgn in (1, -1):
        outline = channel_outline(0.15, 0.05, 0.007, 0.006)
        # mirror in y so the flanges point toward the walkway centre
        o = outline.copy()
        o[:, 0] *= -sgn
        o = o[::-1] if sgn == 1 else o
        o = o.copy()
        stations = np.unique(np.concatenate([np.linspace(0, L, int(L / 0.12) + 1)]))
        end_far = None
        if torn and sgn == 1:
            stations = stations[stations <= L * 0.72]
            end_far = lambda y, z: 0.05 * np.tanh(2 * fbm(y * 15.0, z * 12.0, None, 2, seed=SEED)) + 0.10 * (z / 0.15) + 0.008 * vnoise(y * 60.0, z * 50.0, None, SEED + 1)
        m, rest = profile_sweep(o, stations, lambda P, sgn=sgn: np.stack([P[:, 0], sgn * W / 2 + P[:, 1], zc + P[:, 2]], 1), sub=0.05, jag_end=(None, end_far))
        parts['frame'].append(m)
    # cross members (50 x 50 x 5 angle-like box sections) every 0.75 m
    xs = np.arange(0.0, L + 1e-6, 0.75)
    for x in xs:
        parts['frame'].append(box((x, 0, zc - 0.055), 0.05, W - 0.01, 0.045))
    # grating
    gl = L - 0.06
    if torn:
        hx, hy = L * 0.46, 0.0

        def missing(x, y):
            X = x + L / 2
            hole = (X > L * 0.40) & (X < L * 0.66) & (y > -0.12 + 0.35 * np.sin(X * 3.0) * 0.0) & (np.abs(y - 0.18) < 0.40)
            tear = (X > L * 0.36) & (X < L * 0.72) & (y < -0.30) & (vnoise(x * 20.0, y * 20.0, None, SEED + 3) > 0.55)
            return hole | tear
        g = grating(gl, W - 0.04, missing=missing)
    else:
        g = grating(gl, W - 0.04)
    parts['grate'].append(g.xf(None, (L / 2, 0, -0.015)))
    # toe plates (3 mm x 100 mm) bolted to the stringers
    for sgn in (1, -1):
        parts['toe'].append(box((L / 2, sgn * (W / 2 - 0.002), 0.045), L, 0.003, 0.10))
    # posts (every 1.4 m) with side brackets and bolts, top and mid rails
    post_x = [0.12, L / 2, L - 0.12] if L < 3.2 else [0.12, L * 0.34, L * 0.67, L - 0.12]
    for sgn in (1, -1):
        for px in post_x:
            parts['rails'].append(tube([(px, sgn * (W / 2 - 0.045), -0.03), (px, sgn * (W / 2 - 0.045), 1.05)], R_RAIL, R_RAIL_IN, segs=10, step=0.2))
            parts['frame'].append(box((px, sgn * (W / 2 - 0.0125), -0.06), 0.10, 0.012, 0.14))
            for dz in (-0.10, -0.02):
                parts['hw'].append(bolt_assy((px, sgn * (W / 2 + 0.0), -0.06 + dz * 0.5 - 0.0), (0, -sgn, 0), 0.02, scale=0.4, seed=int(px * 100)))
        for z in (1.05, 0.55):
            parts['rails'].append(tube([(0.0, sgn * (W / 2 - 0.045), z), (L, sgn * (W / 2 - 0.045), z)], R_RAIL, R_RAIL_IN, segs=10, step=0.15))
    return parts


def apply_all(parts, f):
    out = {}
    for k, lst in parts.items():
        out[k] = [M(f(m.v), m.t, m.d) for m in lst]
    return out


def build_section():
    L = 3.0
    p = frame_parts(L)
    # a little uniform wear: darker at the ends
    return {'paint': merge(p['frame'] + p['grate'] + p['toe'] + p['rails']), 'bolt': merge(p['hw'])}


def build_torn():
    L = 3.6
    p = frame_parts(L, torn=True)
    xh = L * 0.46

    def warp(v):
        x, y, z = v[:, 0], v[:, 1], v[:, 2]
        t = smoothstep(xh - 0.25, xh + 0.25, x)
        th = math.radians(28) * t
        dx = x - xh
        c, s = np.cos(th), np.sin(th)
        x2 = xh + dx * c + z * s
        z2 = -dx * s + z * c
        tw = math.radians(10) * t
        y2 = y * np.cos(tw) - z2 * np.sin(tw)
        z3 = y * np.sin(tw) + z2 * np.cos(tw)
        # the dropped end sags a touch more and shifts sideways
        return np.stack([x2, y2 + 0.10 * t, z3 - 0.05 * t], 1)
    # local rail damage before the warp: the +y top rail is snapped and flung outward, mid rail bent
    rails = []
    for m in p['rails']:
        v = m.v.copy()
        near = gauss(v[:, 0], xh + 0.1, 0.5)
        hi = v[:, 2] > 0.8
        if v[:, 1].mean() > 0:
            v[:, 1] += 0.35 * near * (v[:, 2] > 0.2) * (1 + 0.4 * np.sin(v[:, 0] * 6))
            v[:, 2] -= 0.18 * near * (v[:, 2] > 0.2)
        else:
            v[:, 2] -= 0.05 * near * (v[:, 2] > 0.2)
        rails.append(M(v, m.t, m.d))
    p['rails'] = rails
    # crumple the +y toe plate near the hinge
    toes = []
    for m in p['toe']:
        v = m.v.copy()
        if v[:, 1].mean() > 0:
            k = gauss(v[:, 0], xh, 0.5)
            v[:, 1] += 0.06 * k * np.sin(v[:, 0] * 14 + v[:, 2] * 25)
            v[:, 2] -= 0.04 * k
        toes.append(M(v, m.t, m.d))
    p['toe'] = toes
    w = apply_all(p, warp)

    def dm(m):
        k = gauss(m.v[:, 0], xh, 0.55)
        return m.damage(tear=k, crumple=k * 0.7)
    paint = [dm(m) for m in w['frame'] + w['grate'] + w['toe'] + w['rails']]
    return {'paint': merge(paint), 'bolt': merge(w['hw'])}


ASSETS = {
    'industrial_walkway_section': dict(build=build_section, replaces='walkway_section', category='walkway', label='Catwalk section: C-channel frame, open grating, toe plates, 1.05 m rails',
                                       paint=(0.24, 0.25, 0.26), rust_gain=0.6, wear_gain=1.0, bevel=0.0010),
    'industrial_walkway_torn': dict(build=build_torn, replaces='walkway_torn', category='walkway', label='Collapsed catwalk: dropped hinge, missing grating, snapped stringer and rails',
                                    paint=(0.50, 0.34, 0.035), rust_gain=1.0, wear_gain=1.2, bevel=0.0010),
}
