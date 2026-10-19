"""Thin Blender (bpy) helpers shared by the pilot assets."""
import math
import os

import bpy  # noqa: F401  (must precede bmesh)
import bmesh  # noqa: E402
import numpy as np


def reset():
    bpy.ops.wm.read_factory_settings(use_empty=True)
    bpy.context.scene.unit_settings.system = 'METRIC'
    bpy.context.scene.unit_settings.scale_length = 1.0


def mesh_object(name, verts, tris, collection=None):
    """Create a mesh object from numpy arrays (float32 Nx3, int Mx3)."""
    verts = np.ascontiguousarray(verts, dtype=np.float32)
    tris = np.ascontiguousarray(tris, dtype=np.int32)
    me = bpy.data.meshes.new(name)
    me.vertices.add(len(verts))
    me.vertices.foreach_set('co', verts.ravel())
    me.loops.add(len(tris) * 3)
    me.loops.foreach_set('vertex_index', tris.ravel())
    me.polygons.add(len(tris))
    me.polygons.foreach_set('loop_start', np.arange(0, len(tris) * 3, 3, dtype=np.int32))
    me.update()
    me.validate()
    obj = bpy.data.objects.new(name, me)
    (collection or bpy.context.scene.collection).objects.link(obj)
    return obj


def dissolve_flat_and_triangulate(obj, angle_deg=0.15):
    """Merge coplanar faces (the flat cast faces) and re-triangulate."""
    bm = bmesh.new()
    bm.from_mesh(obj.data)
    bmesh.ops.dissolve_limit(bm, angle_limit=math.radians(angle_deg), verts=bm.verts[:], edges=bm.edges[:], use_dissolve_boundaries=False)
    bmesh.ops.triangulate(bm, faces=bm.faces[:], quad_method='SHORT_EDGE', ngon_method='BEAUTY')
    bm.to_mesh(obj.data)
    bm.free()
    obj.data.update()


def decimate(obj, target_tris):
    """Quadric-error collapse decimation down to ~target_tris (keeps silhouette and creases)."""
    cur = len(obj.data.polygons)
    if cur <= target_tris:
        return cur
    bpy.ops.object.select_all(action='DESELECT')
    bpy.context.view_layer.objects.active = obj
    obj.select_set(True)
    mod = obj.modifiers.new('decimate', 'DECIMATE')
    mod.decimate_type = 'COLLAPSE'
    mod.ratio = target_tris / cur
    mod.use_collapse_triangulate = True
    bpy.ops.object.modifier_apply(modifier=mod.name)
    return len(obj.data.polygons)


def validate_clean(obj):
    """Let Blender drop degenerate faces / unused data; returns True if it changed the mesh."""
    changed = obj.data.validate(verbose=False, clean_customdata=True)
    obj.data.update()
    return changed


def shade_by_angle(obj, angle_deg=38.0):
    me = obj.data
    bm = bmesh.new()
    bm.from_mesh(me)
    for f in bm.faces:
        f.smooth = True
    limit = math.radians(angle_deg)
    for e in bm.edges:
        if len(e.link_faces) == 2 and e.calc_face_angle(0.0) > limit:
            e.smooth = False
    bm.to_mesh(me)
    bm.free()
    me.update()


def set_loop_uvs(obj, uv_per_loop, name='UVMap'):
    me = obj.data
    layer = me.uv_layers.new(name=name)
    layer.data.foreach_set('uv', np.ascontiguousarray(uv_per_loop, dtype=np.float32).ravel())


def set_vertex_colors(obj, rgba_per_vertex, name='Col'):
    me = obj.data
    attr = me.color_attributes.new(name=name, type='FLOAT_COLOR', domain='POINT')
    attr.data.foreach_set('color', np.ascontiguousarray(rgba_per_vertex, dtype=np.float32).ravel())


def export_glb(path, objects, jpeg_quality=88, extra=None):
    os.makedirs(os.path.dirname(path), exist_ok=True)
    bpy.ops.object.select_all(action='DESELECT')
    for o in objects:
        o.select_set(True)
    kwargs = dict(
        filepath=path, export_format='GLB', use_selection=True, export_apply=False, export_yup=True,
        export_texcoords=True, export_normals=True, export_tangents=False, export_materials='EXPORT',
        export_image_format='JPEG', export_jpeg_quality=jpeg_quality, export_cameras=False, export_lights=False,
        export_vertex_color='ACTIVE', export_active_vertex_color_when_no_material=False,
        export_extras=False, export_animations=False, export_draco_mesh_compression_enable=False,
    )
    if extra:
        kwargs.update(extra)
    bpy.ops.export_scene.gltf(**kwargs)
    return os.path.getsize(path)


def clean_mesh(obj, min_island_fraction=0.04):
    """Remove duplicate (zero-volume) face pairs, loose geometry and tiny floating islands.

    Returns a dict of what was removed and the remaining non-manifold edge count."""
    bm = bmesh.new()
    bm.from_mesh(obj.data)
    seen = {}
    dup = []
    for f in bm.faces:
        key = tuple(sorted(v.index for v in f.verts))
        if key in seen:
            dup.extend([f, seen[key]])
        else:
            seen[key] = f
    removed_dup = len(set(dup))
    if dup:
        bmesh.ops.delete(bm, geom=list(set(dup)), context='FACES')
    loose = [v for v in bm.verts if not v.link_faces]
    if loose:
        bmesh.ops.delete(bm, geom=loose, context='VERTS')
    # Connected components by face adjacency (shared edges); keep islands that are not tiny.
    bm.faces.ensure_lookup_table()
    comp = {}
    sizes = []
    for f in bm.faces:
        if f.index in comp:
            continue
        stack, cid, n = [f], len(sizes), 0
        comp[f.index] = cid
        while stack:
            g = stack.pop()
            n += 1
            for e in g.edges:
                for h in e.link_faces:
                    if h.index not in comp:
                        comp[h.index] = cid
                        stack.append(h)
        sizes.append(n)
    keep_min = max(sizes) * min_island_fraction if sizes else 0
    drop = [f for f in bm.faces if sizes[comp[f.index]] < keep_min]
    if drop:
        bmesh.ops.delete(bm, geom=drop, context='FACES')
    loose = [v for v in bm.verts if not v.link_faces]
    if loose:
        bmesh.ops.delete(bm, geom=loose, context='VERTS')
    nonmanifold = sum(1 for e in bm.edges if not e.is_manifold)
    bm.to_mesh(obj.data)
    bm.free()
    obj.data.update()
    return {'duplicate_faces_removed': removed_dup, 'islands': len(sizes), 'island_faces_removed': len(drop), 'non_manifold_edges': nonmanifold}


def plate_mesh(outline, holes, to3d):
    """Flat plate mid-surface: a polygon with circular holes, filled with a constrained triangulation.

    outline: (N,2) counter-clockwise polygon; holes: list of (cx, cy, r, n); to3d(u, v) -> (3,) world point.
    Returns (verts (K,3) float32, tris (T,3) int32)."""
    bm = bmesh.new()
    loops = [np.asarray(outline, dtype=np.float64)]
    for cx, cy, r, n in holes:
        a = np.linspace(0, 2 * math.pi, n, endpoint=False)
        loops.append(np.stack([cx + r * np.cos(a), cy + r * np.sin(a)], axis=1))
    edges = []
    for lp in loops:
        vs = [bm.verts.new(to3d(p[0], p[1])) for p in lp]
        for i in range(len(vs)):
            edges.append(bm.edges.new((vs[i], vs[(i + 1) % len(vs)])))
    res = bmesh.ops.triangle_fill(bm, use_beauty=True, use_dissolve=False, edges=edges)
    faces = [f for f in bm.faces]
    verts = np.array([v.co[:] for v in bm.verts], dtype=np.float32)
    index = {v: i for i, v in enumerate(bm.verts)}
    tris = np.array([[index[v] for v in f.verts] for f in faces], dtype=np.int32)
    bm.free()
    return verts, tris


def rounded_rect(w, h, r, n=5):
    """Counter-clockwise rounded-rectangle outline centred on the origin (w along u, h along v)."""
    pts = []
    for cx, cy, a0 in ((w / 2 - r, h / 2 - r, 0.0), (-w / 2 + r, h / 2 - r, math.pi / 2), (-w / 2 + r, -h / 2 + r, math.pi), (w / 2 - r, -h / 2 + r, 3 * math.pi / 2)):
        for k in range(n):
            a = a0 + (math.pi / 2) * k / (n - 1)
            pts.append((cx + r * math.cos(a), cy + r * math.sin(a)))
    return np.asarray(pts)


def solidify(obj, thickness, offset=0.0, even=False):
    bpy.ops.object.select_all(action='DESELECT')
    bpy.context.view_layer.objects.active = obj
    obj.select_set(True)
    mod = obj.modifiers.new('solid', 'SOLIDIFY')
    mod.thickness, mod.offset, mod.use_even_offset = thickness, offset, even
    bpy.ops.object.modifier_apply(modifier=mod.name)


def bevel(obj, width, segments=2, angle_deg=35.0):
    bpy.ops.object.select_all(action='DESELECT')
    bpy.context.view_layer.objects.active = obj
    obj.select_set(True)
    mod = obj.modifiers.new('bevel', 'BEVEL')
    mod.width, mod.segments, mod.limit_method, mod.angle_limit = width, segments, 'ANGLE', math.radians(angle_deg)
    bpy.ops.object.modifier_apply(modifier=mod.name)
