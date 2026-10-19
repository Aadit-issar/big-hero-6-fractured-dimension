"""Industrial family helpers: planned UV atlas from sheet parameterisation, boundary smoothing, surface tagging.

Method: every solidified sheet carries its parameter coordinates (u, v), a sheet id and its mid-surface normal as
per-vertex attributes ('prm', 'nrm'). After all modifiers have run, loop UVs are computed in numpy: front faces land in
the sheet's front atlas rectangle, back faces in a mirrored rectangle, rims reuse the front footprint. Texel density is
uniform because the parameters are in metres."""
import math

import bpy  # noqa: F401
import numpy as np


# ------------------------------------------------------------------ boundary smoothing (torn rims)
def smooth_boundary(pts, tris, pinned, iters=6, lam=0.5):
    """Laplacian-smooth open boundary vertices along their chain (not the pinned ones): removes clip sawtooth."""
    pts = pts.copy()
    e = np.concatenate([tris[:, [0, 1]], tris[:, [1, 2]], tris[:, [2, 0]]])
    key = np.sort(e, axis=1)
    k = key[:, 0].astype(np.int64) * len(pts) + key[:, 1]
    uniq, inv, cnt = np.unique(k, return_inverse=True, return_counts=True)
    bmask = cnt[inv] == 1
    be = key[bmask]
    be = np.unique(be, axis=0)
    nb = {}
    for a, b in be:
        nb.setdefault(int(a), []).append(int(b))
        nb.setdefault(int(b), []).append(int(a))
    ids = [v for v, l in nb.items() if len(l) == 2 and not pinned[v]]
    if not ids:
        return pts
    ids = np.array(ids)
    n0 = np.array([nb[int(v)][0] for v in ids])
    n1 = np.array([nb[int(v)][1] for v in ids])
    for _ in range(iters):
        avg = 0.5 * (pts[n0] + pts[n1])
        pts[ids] += lam * (avg - pts[ids])
    return pts


# ------------------------------------------------------------------ tagging and atlas
def vertex_normals(verts, tris):
    n = np.zeros(verts.shape, dtype=np.float64)
    fn = np.cross(verts[tris[:, 1]] - verts[tris[:, 0]], verts[tris[:, 2]] - verts[tris[:, 0]])
    for k in range(3):
        np.add.at(n, tris[:, k], fn)
    ln = np.linalg.norm(n, axis=1, keepdims=True)
    return np.where(ln > 1e-12, n / np.maximum(ln, 1e-12), np.array([[0.0, 0.0, 1.0]]))


def tag(obj, uv, sheet_id, verts, tris):
    """Attach 'prm' (u, v, sheet id) and 'nrm' (mid-surface normal) point attributes. Call BEFORE solidify."""
    me = obj.data
    n = len(verts)
    prm = np.zeros((n, 4), np.float32)
    prm[:, :2] = uv
    prm[:, 2] = sheet_id
    prm[:, 3] = 1.0
    nrm = np.ones((n, 4), np.float32)
    nrm[:, :3] = vertex_normals(verts.astype(np.float64), tris)
    for name, arr in (('prm', prm), ('nrm', nrm)):
        a = me.color_attributes.new(name=name, type='FLOAT_COLOR', domain='POINT')
        a.data.foreach_set('color', arr.ravel())


def pack_rects(items, width, gap):
    """Shelf packing. items: list of (key, w, h) in metres; returns ({key: (x, y)}, used_height)."""
    items = sorted(items, key=lambda t: -t[2])
    pos, x, y, rowh = {}, 0.0, 0.0, 0.0
    for key, w, h in items:
        if x + w > width:
            x, y, rowh = 0.0, y + rowh + gap, 0.0
        pos[key] = (x, y)
        x += w + gap
        rowh = max(rowh, h)
    return pos, y + rowh


def build_layout(extents, atlas_px_w, px_per_m, gap_px=10):
    """extents: {sheet_id: (umin, vmin, w, h)} in metres. Returns layout dict with front/back rectangles and atlas size."""
    gap = gap_px / px_per_m
    width = atlas_px_w / px_per_m
    items = []
    for sid, (u0, v0, w, h) in extents.items():
        items.append(((sid, 0), w, h))
        items.append(((sid, 1), w, h))
    pos, used = pack_rects(items, width, gap)
    atlas_h_px = 256
    while atlas_h_px < used * px_per_m + gap_px:
        atlas_h_px *= 2
    return dict(extents=extents, pos=pos, aw=atlas_px_w / px_per_m, ah=atlas_h_px / px_per_m, size=(atlas_px_w, atlas_h_px), used=used)


def apply_uvs(obj, layout, rim_cos=0.35):
    """Compute loop UVs for the joined mesh from its 'prm'/'nrm' attributes."""
    me = obj.data
    nv = len(me.vertices)
    prm = np.empty(nv * 4, np.float32)
    nrm = np.empty(nv * 4, np.float32)
    me.color_attributes['prm'].data.foreach_get('color', prm)
    me.color_attributes['nrm'].data.foreach_get('color', nrm)
    prm, nrm = prm.reshape(-1, 4), nrm.reshape(-1, 4)[:, :3]
    nl = len(me.loops)
    vi = np.empty(nl, np.int32)
    me.loops.foreach_get('vertex_index', vi)
    npoly = len(me.polygons)
    start = np.empty(npoly, np.int32)
    me.polygons.foreach_get('loop_start', start)
    total = np.diff(np.append(start, nl))
    pn = np.empty(npoly * 3, np.float32)
    me.polygons.foreach_get('normal', pn)
    pn = pn.reshape(-1, 3)
    poly_of_loop = np.repeat(np.arange(npoly), total)
    fn = pn[poly_of_loop]
    # per-loop attribute lookups; side decided per polygon from the mean stored normal
    ln = nrm[vi]
    sums = np.zeros((npoly, 3))
    np.add.at(sums, poly_of_loop, ln)
    side_dot = np.einsum('ij,ij->i', pn, sums) / np.maximum(np.linalg.norm(sums, axis=1), 1e-9)
    back = side_dot < -rim_cos
    ids = np.rint(prm[vi][:, 2]).astype(int)
    uv = np.zeros((nl, 2), np.float32)
    aw, ah = layout['aw'], layout['ah']
    # polygon-level sheet id (first loop) so a polygon never straddles two rectangles
    pid = ids[start]
    for sid, (u0, v0, w, h) in layout['extents'].items():
        for side in (0, 1):
            x, y = layout['pos'][(sid, side)]
            polys = (pid == sid) & (back == bool(side))
            lm = polys[poly_of_loop]
            if not lm.any():
                continue
            u = prm[vi[lm]][:, 0] - u0
            v = prm[vi[lm]][:, 1] - v0
            if side:
                u = w - u
            uv[lm, 0] = (x + u) / aw
            uv[lm, 1] = (y + v) / ah
    layer = me.uv_layers.new(name='UVMap')
    layer.data.foreach_set('uv', uv.ravel())
    return back


def extents_from_sheets(sheets):
    """sheets: {id: (n,2) param array} -> extents."""
    out = {}
    for sid, uv in sheets.items():
        u0, v0 = uv.min(axis=0)
        u1, v1 = uv.max(axis=0)
        out[sid] = (float(u0), float(v0), float(u1 - u0) + 1e-4, float(v1 - v0) + 1e-4)
    return out
