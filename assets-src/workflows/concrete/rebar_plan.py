"""Rebar layout for the concrete family: bars exist only where they are visible.

Fixes over the pilot: bars are NOT severed by surface cracks (they cross the crack void intact and are drawn only where
the surrounding concrete is missing); no stray stubs inside cracks; bar diameters 16-20 mm; tails curve away from the fracture.
"""
import os
import sys

import numpy as np

sys.path.insert(0, os.path.dirname(__file__))
from pylib.meshutil import sample_field  # noqa: E402
from pylib.rebar import bent_path  # noqa: E402


def plan_bars(f_full, f_nc, origin, cell, extent, mats, seed, exposure=1.0, bridge_max=0.9, bridge_p=0.6):
    """mats: list of (axis 'x'|'y', z, radius, offsets). Returns [(points, radius, end_cut, start_cut)].

    f_full: concrete field with cracks and chips; f_nc: concrete field with only the large fractures (bars end there).
    exposure 0..1+: probability and length of bars protruding from broken faces."""
    rng = np.random.default_rng(seed)
    Lx, Wy = extent
    step = 0.004
    out = []

    def tail_len():
        k = rng.choice(3, p=[0.2, 0.45, 0.35])
        lo, hi = [(0.0, 0.02), (0.08, 0.25), (0.25, 0.55)][k]
        return float(rng.uniform(lo, hi)) * (0.35 + 0.65 * min(exposure, 1.5))

    for axis, z, rad, offsets in mats:
        for off in offsets:
            half = (Lx if axis == 'x' else Wy) / 2 - 0.04
            s = np.arange(-half, half + step, step)
            if axis == 'x':
                P = np.stack([s, np.full_like(s, off), np.full_like(s, z)], axis=1)
                d = np.array([1.0, 0, 0])
            else:
                P = np.stack([np.full_like(s, off), s, np.full_like(s, z)], axis=1)
                d = np.array([0, 1.0, 0])
            fnc = sample_field(f_nc, origin, cell, P)
            ff = sample_field(f_full, origin, cell, P)
            inside = fnc > 0.0015
            if not inside.any():
                continue
            edges = np.diff(np.concatenate([[0], inside.astype(np.int8), [0]]))
            starts, ends = np.flatnonzero(edges == 1), np.flatnonzero(edges == -1) - 1
            runs = [(a, b) for a, b in zip(starts, ends) if b - a > 12]
            if not runs:
                continue
            margin = int(0.035 / step)
            n = len(s)
            ivs = []   # (i0, i1, tail_at_start, tail_at_end)
            for k, (a, b) in enumerate(runs):
                # exposed sub-runs of this run (concrete missing around the bar)
                expo = (ff[a:b + 1] < rad + 0.003)
                e = np.diff(np.concatenate([[0], expo.astype(np.int8), [0]]))
                for ea, eb in zip(np.flatnonzero(e == 1), np.flatnonzero(e == -1) - 1):
                    if eb - ea >= 10:
                        ivs.append([max(a, a + ea - margin), min(b, a + eb + margin), None, None])
                cut_end = b < n - 1
                cut_start = a > 0
                if cut_end:
                    nxt = runs[k + 1] if k + 1 < len(runs) else None
                    if nxt and (nxt[0] - b) * step < bridge_max and rng.random() < bridge_p:
                        seg = np.arange(max(b - margin, a), min(nxt[0] + margin, nxt[1]) + 1)
                        ivs.append([int(seg[0]), int(seg[-1]), None, ('bridge', rng.uniform(-0.03, 0.03), rng.uniform(-0.02, 0.03))])
                    elif rng.random() < min(1.0, 0.25 + 0.75 * exposure):
                        ivs.append([max(a, b - margin), b, None, ('tail', tail_len(), rng.uniform(4, 40), rng.uniform(20, 40))])
                if cut_start and not (k > 0 and (a - runs[k - 1][1]) * step < bridge_max):
                    if rng.random() < min(1.0, 0.25 + 0.75 * exposure):
                        ivs.append([a, min(b, a + margin), ('tail', tail_len(), rng.uniform(4, 40), rng.uniform(20, 40)), None])
            ivs.sort(key=lambda t: t[0])
            merged = []
            for iv in ivs:
                if merged and iv[0] <= merged[-1][1] + 2:
                    m = merged[-1]
                    m[1] = max(m[1], iv[1])
                    m[2] = m[2] or iv[2]
                    m[3] = m[3] or iv[3]
                else:
                    merged.append(list(iv))
            for i0, i1, t0, t1 in merged:
                seg = P[i0:i1 + 1].copy()
                end_cut = start_cut = None
                if t1 and t1[0] == 'bridge':
                    _, sag, lift = t1
                    perp = np.cross(d, [0, 0, 1.0])
                    u = np.linspace(0, 1, len(seg))
                    seg = seg + (np.sin(np.pi * u) * sag)[:, None] * perp[None, :] + (np.sin(np.pi * u) * lift)[:, None] * np.array([0, 0, 1.0])[None, :]
                elif t1:
                    _, L, bend, cut = t1
                    if L > 0.03:
                        seg = np.concatenate([seg, bent_path(seg[-1], d, L, rng, bend)[1:]])
                    end_cut = cut
                if t0:
                    _, L, bend, cut = t0
                    if L > 0.03:
                        seg = np.concatenate([bent_path(seg[0], -d, L, rng, bend)[1:][::-1], seg])
                    start_cut = cut
                if len(seg) >= 3:
                    out.append((seg, rad, end_cut, start_cut))
    return out
