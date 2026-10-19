"""Mesh analysis helpers (numpy): field sampling, normals, cavity AO, box-projected UVs."""
import numpy as np


def sample_field(f, origin, cell, P):
    """Trilinear sample of a lattice field at world points P (N,3)."""
    g = (P - origin) / cell
    i = np.clip(np.floor(g).astype(np.int64), 0, np.array(f.shape) - 2)
    t = np.clip(g - i, 0.0, 1.0)
    out = 0.0
    for dx in (0, 1):
        for dy in (0, 1):
            for dz in (0, 1):
                w = (t[:, 0] if dx else 1 - t[:, 0]) * (t[:, 1] if dy else 1 - t[:, 1]) * (t[:, 2] if dz else 1 - t[:, 2])
                out = out + w * f[i[:, 0] + dx, i[:, 1] + dy, i[:, 2] + dz]
    return out


def vertex_normals(verts, tris):
    """Area-weighted vertex normals; unreferenced vertices get +z so downstream maths never sees NaN."""
    n = np.zeros(verts.shape, dtype=np.float64)
    fn = np.cross(verts[tris[:, 1]] - verts[tris[:, 0]], verts[tris[:, 2]] - verts[tris[:, 0]])
    for k in range(3):
        np.add.at(n, tris[:, k], fn)
    length = np.linalg.norm(n, axis=1, keepdims=True)
    n = np.where(length > 1e-12, n / np.maximum(length, 1e-12), np.array([[0.0, 0.0, 1.0]]))
    return n


def cavity_ao(f, origin, cell, verts, normals):
    """Neutral cavity occlusion from a solid field: cracks, craters and re-entrant corners darken."""
    ref = np.where(np.abs(normals[:, [2]]) < 0.9, np.array([[0, 0, 1.0]]), np.array([[1.0, 0, 0]]))
    t1 = np.cross(normals, ref)
    t1 /= np.linalg.norm(t1, axis=1, keepdims=True)
    t2 = np.cross(normals, t1)
    dirs = [normals, normals + 0.8 * t1, normals - 0.8 * t1, normals + 0.8 * t2, normals - 0.8 * t2, normals + 0.8 * (t1 + t2), normals - 0.8 * (t1 + t2)]
    occ, wsum = 0.0, 0.0
    for dist, w in ((0.012, 1.0), (0.03, 0.9), (0.06, 0.7), (0.11, 0.5)):
        for d in dirs:
            d = d / np.linalg.norm(d, axis=1, keepdims=True)
            occ = occ + w * (sample_field(f, origin, cell, verts + normals * 0.003 + d * dist) > 0.0)
            wsum += w
    return 1.0 - occ / wsum


def face_axes_smoothed(verts, tris, passes=2):
    """Dominant projection axis per face, majority-filtered over edge neighbours (fewer UV islands)."""
    n = np.cross(verts[tris[:, 1]] - verts[tris[:, 0]], verts[tris[:, 2]] - verts[tris[:, 0]])
    ax = np.argmax(np.abs(n), axis=1)
    sign = np.sign(np.take_along_axis(n, ax[:, None], axis=1)[:, 0])
    sign[sign == 0] = 1
    nv = len(verts)
    e = np.concatenate([tris[:, [0, 1]], tris[:, [1, 2]], tris[:, [2, 0]]])
    key = np.sort(e, axis=1)
    flat = key[:, 0].astype(np.int64) * nv + key[:, 1]
    order = np.argsort(flat, kind='stable')
    sf = flat[order]
    same = sf[1:] == sf[:-1]
    ia, ib = order[:-1][same] % len(tris), order[1:][same] % len(tris)
    for _ in range(passes):
        votes = np.zeros((len(tris), 3))
        np.add.at(votes, (np.arange(len(tris)), ax), 1.6)
        np.add.at(votes, (ia, ax[ib]), 1.0)
        np.add.at(votes, (ib, ax[ia]), 1.0)
        ax = np.argmax(votes, axis=1)
    return ax, sign


def box_uv(verts, tris, ax, sign, tile):
    """Per-corner UVs: planar projection along each face's axis; 1 UV unit = `tile` metres (per face)."""
    P = verts[tris]
    uv = np.empty((len(tris), 3, 2), dtype=np.float32)
    for a in range(3):
        m = ax == a
        if not m.any():
            continue
        u_axis, v_axis = [(1, 2), (0, 2), (0, 1)][a]
        uv[m, :, 0] = (P[m][:, :, u_axis] * sign[m][:, None]) / tile[m][:, None]
        uv[m, :, 1] = P[m][:, :, v_axis] / tile[m][:, None]
    return uv.reshape(-1, 2)
