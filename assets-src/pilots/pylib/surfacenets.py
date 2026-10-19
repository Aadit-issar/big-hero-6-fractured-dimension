"""Vectorised naive surface nets (numpy). f > 0 is solid.

`f` is a 3D float32 array of field samples at lattice points; world position of
sample (i, j, k) is origin + (i, j, k) * cell. Returns (vertices, triangles) with
outward-facing winding (counter-clockwise seen from outside the solid).
"""
import numpy as np

# Corner offsets of a cell, in (dx, dy, dz), and the 12 cell edges as corner index pairs.
CORNERS = np.array([[0, 0, 0], [1, 0, 0], [0, 1, 0], [1, 1, 0], [0, 0, 1], [1, 0, 1], [0, 1, 1], [1, 1, 1]], dtype=np.int64)
EDGES = [(0, 1), (2, 3), (4, 5), (6, 7), (0, 2), (1, 3), (4, 6), (5, 7), (0, 4), (1, 5), (2, 6), (3, 7)]


def surface_nets(f, origin, cell):
    nx, ny, nz = f.shape
    solid = f > 0
    # Active cells: corner signs are mixed.
    count = np.zeros((nx - 1, ny - 1, nz - 1), dtype=np.uint8)
    for dx, dy, dz in CORNERS:
        count += solid[dx:nx - 1 + dx, dy:ny - 1 + dy, dz:nz - 1 + dz]
    active = np.flatnonzero((count > 0) & (count < 8))
    del count
    cx, cy, cz = np.unravel_index(active, (nx - 1, ny - 1, nz - 1))
    n = active.size
    # Corner field values for every active cell.
    vals = np.empty((n, 8), dtype=np.float32)
    for c, (dx, dy, dz) in enumerate(CORNERS):
        vals[:, c] = f[cx + dx, cy + dy, cz + dz]
    acc = np.zeros((n, 3), dtype=np.float64)
    cnt = np.zeros(n, dtype=np.float64)
    for a, b in EDGES:
        fa, fb = vals[:, a].astype(np.float64), vals[:, b].astype(np.float64)
        cross = (fa > 0) != (fb > 0)
        t = np.where(cross, fa / np.where(cross, fa - fb, 1.0), 0.0)
        pa, pb = CORNERS[a], CORNERS[b]
        acc += cross[:, None] * (pa[None, :] + t[:, None] * (pb - pa)[None, :])
        cnt += cross
    verts = (np.stack([cx, cy, cz], axis=1) + acc / np.maximum(cnt, 1)[:, None]) * cell + np.asarray(origin)
    del vals, acc, cnt
    # Cell -> vertex id lookup (sorted active ids).
    def vid(ix, iy, iz):
        flat = (ix * (ny - 1) + iy) * (nz - 1) + iz
        pos = np.searchsorted(active, flat)
        return pos

    quads = []
    # Axis 0 (edges along x between samples i and i+1), cells (i, j-1..j, k-1..k).
    for axis in range(3):
        sl_a = [slice(None)] * 3
        sl_b = [slice(None)] * 3
        sl_a[axis] = slice(0, f.shape[axis] - 1)
        sl_b[axis] = slice(1, f.shape[axis])
        sa, sb = solid[tuple(sl_a)], solid[tuple(sl_b)]
        edge = np.argwhere(sa != sb)
        # Valid only when the neighbouring cells exist (j>=1,k>=1 on the other two axes).
        o1, o2 = [(1, 2), (2, 0), (0, 1)][axis]
        keep = (edge[:, o1] >= 1) & (edge[:, o2] >= 1) & (edge[:, o1] < f.shape[o1] - 1) & (edge[:, o2] < f.shape[o2] - 1)
        edge = edge[keep]
        inside_first = sa[tuple(edge.T)]
        def cell(d1, d2):
            idx = edge.copy()
            idx[:, o1] -= d1
            idx[:, o2] -= d2
            return vid(idx[:, 0], idx[:, 1], idx[:, 2])
        v00, v10, v11, v01 = cell(1, 1), cell(0, 1), cell(0, 0), cell(1, 0)
        q = np.stack([v00, v10, v11, v01], axis=1)
        q = np.where(inside_first[:, None], q, q[:, ::-1])
        quads.append(q)
    quads = np.concatenate(quads, axis=0)
    # Triangulate along the shorter diagonal.
    p = verts
    d02 = np.linalg.norm(p[quads[:, 0]] - p[quads[:, 2]], axis=1)
    d13 = np.linalg.norm(p[quads[:, 1]] - p[quads[:, 3]], axis=1)
    use02 = (d02 <= d13)[:, None]
    tri_a = np.where(use02, quads[:, [0, 1, 2]], quads[:, [0, 1, 3]])
    tri_b = np.where(use02, quads[:, [0, 2, 3]], quads[:, [1, 2, 3]])
    tris = np.concatenate([tri_a, tri_b], axis=0)
    return verts.astype(np.float32), tris.astype(np.int64)
