"""Parametric sheet-metal meshes (numpy): grids, sub-cell contour clipping, merging.

A sheet is the mid-surface of a metal plate. Blender's Solidify later gives it real thickness,
including on torn boundaries created here by clipping against a mask isoline.
"""
import numpy as np


def grid_mesh(u, v, mapper):
    """Triangulated grid over parameter arrays u (n) and v (m). mapper(U, V) -> (n*m, 3).

    Returns (points (n*m,3), uvs (n*m,2), tris (T,3))."""
    n, m = len(u), len(v)
    U, V = np.meshgrid(u, v, indexing='ij')
    pts = mapper(U.ravel(), V.ravel())
    uvs = np.stack([U.ravel(), V.ravel()], axis=1)
    idx = np.arange(n * m).reshape(n, m)
    a, b, c, d = idx[:-1, :-1].ravel(), idx[1:, :-1].ravel(), idx[1:, 1:].ravel(), idx[:-1, 1:].ravel()
    # Alternate the diagonal for an even triangulation.
    flip = ((np.arange(n - 1)[:, None] + np.arange(m - 1)[None, :]) % 2 == 0).ravel()
    t1 = np.where(flip[:, None], np.stack([a, b, c], 1), np.stack([a, b, d], 1))
    t2 = np.where(flip[:, None], np.stack([a, c, d], 1), np.stack([b, c, d], 1))
    return pts, uvs, np.concatenate([t1, t2])


def clip_mesh(pts, uvs, tris, mask):
    """Keep the part of the mesh where mask > 0, clipping triangles at the mask = 0 isoline.

    New vertices are linear interpolations along edges (positions and parameter coordinates)."""
    inside = mask > 0
    tf = inside[tris]
    count = tf.sum(axis=1)
    keep_full = tris[count == 3]
    new_pts, new_uvs = [pts], [uvs]
    base = len(pts)
    edge_index = {}
    extra_pts, extra_uvs = [], []

    def edge_vertex(a, b):
        """Vertex ids on edges (a, b) where a is inside and b outside (arrays)."""
        lo, hi = np.minimum(a, b), np.maximum(a, b)
        key = lo.astype(np.int64) * len(pts) + hi
        uniq, inv = np.unique(key, return_inverse=True)
        out = np.empty(len(uniq), dtype=np.int64)
        ua = np.empty(len(uniq), dtype=np.int64)
        ub = np.empty(len(uniq), dtype=np.int64)
        ua[inv], ub[inv] = a, b
        ma, mb = mask[ua], mask[ub]
        t = np.clip(ma / (ma - mb), 0.18, 0.82)   # no sliver triangles: keeps Solidify stable at torn rims
        pnew = pts[ua] + t[:, None] * (pts[ub] - pts[ua])
        unew = uvs[ua] + t[:, None] * (uvs[ub] - uvs[ua])
        start = base + sum(len(x) for x in extra_pts)
        extra_pts.append(pnew)
        extra_uvs.append(unew)
        out[:] = start + np.arange(len(uniq))
        return out[inv]

    # Normalise each partial triangle so the inside vertices come first (preserving winding).
    out_tris = [keep_full]
    # One vertex inside.
    sel = tris[count == 1]
    if len(sel):
        f = tf[count == 1]
        r = np.argmax(f, axis=1)
        v0 = sel[np.arange(len(sel)), r]
        v1 = sel[np.arange(len(sel)), (r + 1) % 3]
        v2 = sel[np.arange(len(sel)), (r + 2) % 3]
        e01 = edge_vertex(v0, v1)
        e02 = edge_vertex(v0, v2)
        out_tris.append(np.stack([v0, e01, e02], axis=1))
    # Two vertices inside: the outside vertex is the odd one.
    sel = tris[count == 2]
    if len(sel):
        f = tf[count == 2]
        r = np.argmin(f, axis=1)            # index of the outside vertex
        c_out = sel[np.arange(len(sel)), r]
        a_in = sel[np.arange(len(sel)), (r + 1) % 3]
        b_in = sel[np.arange(len(sel)), (r + 2) % 3]
        e_a = edge_vertex(a_in, c_out)      # on edge a-c
        e_b = edge_vertex(b_in, c_out)      # on edge b-c
        # Cycle order is (c_out, a_in, b_in): quad a_in, b_in, e_b, e_a.
        out_tris.append(np.stack([a_in, b_in, e_b], axis=1))
        out_tris.append(np.stack([a_in, e_b, e_a], axis=1))
    all_pts = np.concatenate([pts] + extra_pts) if extra_pts else pts
    all_uvs = np.concatenate([uvs] + extra_uvs) if extra_uvs else uvs
    t = np.concatenate(out_tris)
    # Compact unused vertices.
    used = np.unique(t.ravel())
    remap = -np.ones(len(all_pts), dtype=np.int64)
    remap[used] = np.arange(len(used))
    return all_pts[used], all_uvs[used], remap[t]


def merge(meshes):
    """Concatenate (pts, tris) pairs; returns (pts, tris, offsets)."""
    pts, tris, off, offs = [], [], 0, []
    for p, t in meshes:
        pts.append(p)
        tris.append(t + off)
        offs.append(off)
        off += len(p)
    return np.concatenate(pts), np.concatenate(tris), offs
