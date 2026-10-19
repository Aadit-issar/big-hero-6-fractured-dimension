"""Deformed reinforcing bars (ribbed) as swept tubes, built only where they are exposed."""
import math

import numpy as np

SEGS = 8
PITCH = 0.016          # transverse rib pitch (m): stylised so ribs survive the ring spacing


def _unit(v):
    n = np.linalg.norm(v, axis=-1, keepdims=True)
    return v / np.maximum(n, 1e-12)


def resample(path, step):
    path = np.asarray(path, dtype=np.float64)
    seg = np.linalg.norm(np.diff(path, axis=0), axis=1)
    s = np.concatenate([[0], np.cumsum(seg)])
    total = s[-1]
    n = max(2, int(math.ceil(total / step)) + 1)
    t = np.linspace(0, total, n)
    return np.stack([np.interp(t, s, path[:, k]) for k in range(3)], axis=1), t


def sweep(path, radius, ribbed=True, end_cut_deg=None, start_cut_deg=None, ring_step=0.004, roll=0.0, segs=None, pitch=None, rib_amp=0.10, long_amp=0.07, radius_scale=None):
    """Swept tube along `path`. Returns (verts, tris, uv). Vertices are duplicated at the UV seam."""
    pts, s = resample(path, ring_step)
    n = len(pts)
    tan = _unit(np.gradient(pts, axis=0))
    # Parallel-transport frames.
    ref = np.array([0.0, 0.0, 1.0]) if abs(tan[0, 2]) < 0.9 else np.array([1.0, 0.0, 0.0])
    N = np.zeros_like(pts)
    N[0] = _unit(np.cross(tan[0], np.cross(ref, tan[0])))
    for i in range(1, n):
        axis = np.cross(tan[i - 1], tan[i])
        sn = np.linalg.norm(axis)
        if sn < 1e-9:
            N[i] = N[i - 1]
        else:
            ang = math.atan2(sn, float(np.dot(tan[i - 1], tan[i])))
            k = axis / sn
            v = N[i - 1]
            N[i] = v * math.cos(ang) + np.cross(k, v) * math.sin(ang) + k * np.dot(k, v) * (1 - math.cos(ang))
    B = np.cross(tan, N)
    SEGS_ = SEGS if segs is None else segs
    PITCH_ = PITCH if pitch is None else pitch
    th = np.linspace(0, 2 * math.pi, SEGS_ + 1)
    ct, st = np.cos(th), np.sin(th)
    r = np.full((n, SEGS_ + 1), float(radius))
    if radius_scale is not None:
        r = r * np.interp(s / max(s[-1], 1e-9), np.linspace(0, 1, len(radius_scale)), radius_scale)[:, None]
    if ribbed:
        transverse = rib_amp * np.cos(2 * math.pi * s / PITCH_)[:, None]
        longi = long_amp * (np.maximum(0, np.cos(2 * (th + roll))) ** 6)[None, :]
        r = r * (1.0 + transverse + longi)
    ring = pts[:, None, :] + r[:, :, None] * (ct[None, :, None] * N[:, None, :] + st[None, :, None] * B[:, None, :])
    # Angled snap faces: slide the end ring along the tangent proportionally to its lateral position.
    for cut, idx, sign in ((end_cut_deg, n - 1, 1.0), (start_cut_deg, 0, -1.0)):
        if cut:
            lateral = r[idx] * ct
            ring[idx] += sign * (math.tan(math.radians(cut)) * lateral)[:, None] * tan[idx][None, :]
    verts = ring.reshape(-1, 3)
    uv = np.stack([np.repeat(s / 0.25, SEGS_ + 1), np.tile(th / (2 * math.pi), n)], axis=1)
    quads = []
    for i in range(n - 1):
        a = i * (SEGS_ + 1)
        b = (i + 1) * (SEGS_ + 1)
        for j in range(SEGS_):
            quads.append((a + j, a + j + 1, b + j + 1, b + j))
    q = np.asarray(quads)
    tris = np.concatenate([q[:, [0, 1, 2]], q[:, [0, 2, 3]]])
    # End caps (fans around a centre vertex).
    extra_v, extra_uv, cap = [], [], []
    base = len(verts)
    for idx, flip in ((0, True), (n - 1, False)):
        centre = ring[idx, :SEGS_].mean(axis=0)
        cid = base + len(extra_v)
        extra_v.append(centre)
        extra_uv.append([s[idx] / 0.25, 0.5])
        for j in range(SEGS_):
            a, b = idx * (SEGS_ + 1) + j, idx * (SEGS_ + 1) + j + 1
            cap.append((cid, b, a) if flip else (cid, a, b))
    verts = np.concatenate([verts, np.asarray(extra_v)])
    uv = np.concatenate([uv, np.asarray(extra_uv)])
    tris = np.concatenate([tris, np.asarray(cap)])
    # Outward winding check: the first side quad's normal should point away from the axis.
    p0, p1, p2 = verts[tris[0, 0]], verts[tris[0, 1]], verts[tris[0, 2]]
    nrm = np.cross(p1 - p0, p2 - p0)
    if np.dot(nrm, p0 - pts[0]) < 0:
        tris = tris[:, ::-1]
    return verts.astype(np.float32), tris.astype(np.int32), uv.astype(np.float32)


def bent_path(start, direction, length, rng, total_bend_deg, ring_step=0.01):
    """A protruding bar: starts along `direction`, curving in a random plane with a kink."""
    d = _unit(np.asarray(direction, dtype=np.float64))
    side = _unit(np.cross(d, rng.normal(size=3)))
    n = max(2, int(length / ring_step))
    pts = [np.asarray(start, dtype=np.float64)]
    t = d.copy()
    k_total = math.radians(total_bend_deg)
    kink_at = rng.uniform(0.25, 0.8)
    kink = math.radians(rng.uniform(-25, 25))
    for i in range(1, n + 1):
        u = i / n
        dtheta = (k_total / n) * (0.4 + 1.2 * u) + (kink * 0.5 if abs(u - kink_at) < 0.5 / n else 0.0)
        t = _unit(t * math.cos(dtheta) + side * math.sin(dtheta))
        pts.append(pts[-1] + t * (length / n))
    return np.asarray(pts)


def plan_bars(solid_f, seed, extent):
    """Lay out two mats (Ø12 along x, Ø10 along y; top and bottom) and return geometry segments.

    `solid_f(P)` returns the concrete field at world points (positive = solid). Geometry is
    created only where a bar is exposed: bridging free gaps and protruding from broken faces.
    """
    rng = np.random.default_rng(seed)
    Lx, Wy = extent
    mats = []
    for z in (0.079, -0.079):
        mats.append(('x', z, 0.008, np.arange(-Wy / 2 + 0.07, Wy / 2 - 0.05, 0.20)))
    for z in (0.066, -0.066):
        mats.append(('y', z, 0.006, np.arange(-Lx / 2 + 0.10, Lx / 2 - 0.05, 0.25)))
    out = []
    step = 0.004
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
            f = solid_f(P)
            solid = f > 0.0015
            # runs of solid
            edges = np.diff(np.concatenate([[0], solid.astype(np.int8), [0]]))
            starts, ends = np.flatnonzero(edges == 1), np.flatnonzero(edges == -1) - 1
            runs = [(a, b) for a, b in zip(starts, ends) if b - a > 12]
            if not runs:
                continue
            margin = int(0.04 / step)
            for k, (a, b) in enumerate(runs):
                # Right end of this run: bridge to the next run, or protrude.
                if b < len(s) - 1:
                    if k + 1 < len(runs) and (runs[k + 1][0] - b) * step < 0.9:
                        a2 = runs[k + 1][0]
                        seg = P[max(b - margin, 0):min(a2 + margin, len(s) - 1) + 1]
                        sag = rng.uniform(-0.03, 0.03)
                        perp = np.cross(d, [0, 0, 1.0])
                        u = np.linspace(0, 1, len(seg))
                        seg = seg + (np.sin(np.pi * u) * sag)[:, None] * perp[None, :] + (np.sin(np.pi * u) * rng.uniform(-0.02, 0.03))[:, None] * np.array([0, 0, 1.0])[None, :]
                        out.append((seg, rad, None, None))
                    else:
                        L = float(rng.choice([rng.uniform(0.0, 0.02), rng.uniform(0.08, 0.25), rng.uniform(0.25, 0.55)], p=[0.15, 0.45, 0.40]))
                        base = P[max(b - margin, 0):b + 1]
                        if L > 0.03:
                            tail = bent_path(P[b], d, L, rng, rng.uniform(5, 75))
                            seg = np.concatenate([base, tail[1:]])
                        else:
                            seg = np.concatenate([base, (P[b] + d * L)[None, :]]) if L > 0.004 else base
                        out.append((seg, rad, float(rng.uniform(20, 40)), None))
                # Left end of this run: protrude only (a bridge from the left was created by the previous run).
                if a > 0 and (k == 0 or (a - runs[k - 1][1]) * step >= 0.9):
                    L = float(rng.choice([rng.uniform(0.0, 0.02), rng.uniform(0.08, 0.25), rng.uniform(0.25, 0.55)], p=[0.15, 0.45, 0.40]))
                    base = P[a:min(a + margin, len(s) - 1) + 1][::-1]
                    if L > 0.03:
                        tail = bent_path(P[a], -d, L, rng, rng.uniform(5, 75))
                        seg = np.concatenate([base, tail[1:]])
                    else:
                        seg = np.concatenate([base, (P[a] - d * L)[None, :]]) if L > 0.004 else base
                    out.append((seg, rad, float(rng.uniform(20, 40)), None))
    return out
