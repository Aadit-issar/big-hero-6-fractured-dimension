"""Procedural PBR for the Baymax armour: glossy red paint atlas (per part, parametric UV) and shared grey tile sets.

The painter evaluates the part's own surface function f(s, t) per texel, so every pattern (chips, cracks, seams,
emblem, scorching) is computed in 3D metres and is free of UV stretch. Everything is seeded; no RNG state.
"""
import math
import os

import numpy as np

import kit
from kit import write_png, smoothstep, fbm, vnoise
from pylib.noise import hash01, worley3

SEED = kit.SEED
TEX = os.path.join(kit.HERE, 'build', 'tex')


def mix(a, b, t):
    t = np.asarray(t, float)[..., None]
    return np.asarray(a) * (1 - t) + np.asarray(b) * t


def ss(a, b, x):
    return smoothstep(a, b, x)


def normal_from_height(h, dxm, dym, strength=1.0):
    gy, gx = np.gradient(h)
    nx = -gx / dxm * strength
    ny = gy / dym * strength
    nz = np.ones_like(h)
    L = np.sqrt(nx * nx + ny * ny + nz * nz)
    return np.stack([nx / L * 0.5 + 0.5, ny / L * 0.5 + 0.5, nz / L * 0.5 + 0.5], -1)


def f3(P, scale, octaves=3, seed=0):
    return fbm(P[..., 0] * scale, P[..., 1] * scale, P[..., 2] * scale, octaves, seed=SEED + seed)


def crack_field(P, scale, seed, width):
    """Cellular crack network: 1 on the crack line, 0 away from it (width in metres)."""
    a, b = worley3(P[..., 0] * scale, P[..., 1] * scale, P[..., 2] * scale, SEED + seed)
    d = (b - a) / scale * 0.5          # approx metric distance to the cell boundary
    return 1.0 - ss(width * 0.4, width, d)


def star_cracks(P, centre, normal, radius, spokes=7, seed=0, width=0.0035):
    """Radial cracks from an impact: spokes with wobble, thinning with distance."""
    v = P - centre
    nn = normal / (np.linalg.norm(normal) + 1e-12)
    e1 = np.cross(nn, [0.3, 0.8, 0.5]); e1 /= np.linalg.norm(e1)
    e2 = np.cross(nn, e1)
    x, y = v @ e1, v @ e2
    r = np.hypot(x, y) + 1e-9
    ang = np.arctan2(y, x)
    wob = 0.22 * f3(np.stack([x, y, 0 * x], -1), 9.0, 2, seed)
    best = np.full(r.shape, 9.0)
    for k in range(spokes):
        a0 = TAU_ * (k + 0.35 * math.sin(k * 12.9898 + seed)) / spokes
        da = np.abs((ang - a0 - wob + math.pi) % (2 * math.pi) - math.pi)
        best = np.minimum(best, da * r)
    w = width * (1.1 - 0.8 * np.clip(r / radius, 0, 1))
    return (1.0 - ss(w * 0.5, w, best)) * ss(radius * 1.25, radius * 0.05, r)


TAU_ = 2 * math.pi


def tangent_disc(P, centre, normal, radius):
    """Signed distance (metres) to a circle drawn on the surface by planar projection at `centre`."""
    v = P - centre
    nn = normal / (np.linalg.norm(normal) + 1e-12)
    e1 = np.cross(nn, [0.0, 0.0, 1.0])
    if np.linalg.norm(e1) < 1e-6:
        e1 = np.cross(nn, [1.0, 0.0, 0.0])
    e1 /= np.linalg.norm(e1)
    e2 = np.cross(nn, e1)
    x, y = v @ e1, v @ e2
    front = (v @ nn) > -0.5 * radius
    return np.hypot(x, y) - radius, x, y, front


def paint_atlas(name, f, keep, W, H, seams=(), impacts=(), disc=None, emblem=None, base=(0.62, 0.028, 0.040), seed=0,
                crack_scale=5.0, wear=1.0):
    """Write <name>_color/normal/orm.png into build/tex."""
    j = (np.arange(W) + 0.5) / W
    i = (np.arange(H) + 0.5) / H
    S, T = np.meshgrid(j, 1 - i)
    P = f(S.ravel(), T.ravel()).reshape(H, W, 3)
    dxm = np.linalg.norm(np.gradient(P, axis=1), axis=-1) + 1e-6
    dym = np.linalg.norm(np.gradient(P, axis=0), axis=-1) + 1e-6
    m = keep(S.ravel(), T.ravel(), P.reshape(-1, 3)).reshape(H, W)
    flat = P.reshape(-1, 3)

    # ---- damage proximity
    dmg = ss(0.26, 0.0, m)
    for c, R, _ in impacts:
        d = np.linalg.norm(P - np.asarray(c), axis=-1)
        dmg = np.maximum(dmg, ss(1.6 * R, 0.15 * R, d))
    dmg = np.clip(dmg * wear, 0, 1)
    edge = ss(0.07, 0.0, m)

    # ---- seams
    groove = np.zeros((H, W))
    seam_edge = np.zeros((H, W))
    for sd in seams:
        d = np.abs(sd(P.reshape(-1, 3)).reshape(H, W))
        groove = np.maximum(groove, 1.0 - ss(0.0012, 0.0030, d))
        seam_edge = np.maximum(seam_edge, 1.0 - ss(0.004, 0.012, d))

    # ---- cracks: cellular network (stronger near damage) + star cracks from impacts
    crk = crack_field(P, crack_scale, seed + 1, 0.0030) * ss(0.45, 0.95, dmg)
    crk2 = crack_field(P, crack_scale * 2.7, seed + 2, 0.0018) * ss(0.7, 1.0, dmg)
    for c, R, _ in impacts:
        crk = np.maximum(crk, star_cracks(P, np.asarray(c), (np.asarray(c) - P.reshape(-1, 3).mean(0)), R * 2.0, 6, seed + 4, 0.0028))
    patch = ss(0.35, 0.65, 0.5 + 0.5 * f3(P, 3.0, 2, seed + 6))
    hair = crack_field(P, 2.3, seed + 8, 0.0016) * patch * wear
    cracks = np.clip(np.maximum(np.maximum(crk, crk2), hair), 0, 1)
    crack_halo = np.clip(cracks * 0 + (1 - ss(0.0, 0.014, 0.014 * (1 - cracks))), 0, 1)

    # ---- chips (paint to bare grey metal)
    n1 = 0.5 + 0.5 * f3(P, 13.0, 3, seed + 3)
    n2 = 0.5 + 0.5 * f3(P, 41.0, 2, seed + 4)
    chipf = 0.62 * n1 + 0.38 * n2 + 0.62 * dmg + 0.30 * edge + 0.30 * seam_edge + 0.45 * cracks - 0.62 * wear
    nicks = ss(0.80, 0.86, vnoise(flat[:, 0] * 70, flat[:, 1] * 70, flat[:, 2] * 70, SEED + seed + 12).reshape(H, W))
    sc = 1.0 - ss(0.0, 0.035, np.abs(f3(P * np.array([1.0, 1.0, 9.0]), 14.0, 2, seed + 13))) * 1.0
    scr_line = sc * ss(0.45, 0.8, patch) * 0.0 + (1 - ss(0.0, 0.03, np.abs(f3(P * np.array([9.0, 1.0, 1.0]), 11.0, 2, seed + 14)))) * ss(0.5, 0.8, n1)
    chip = np.clip(ss(0.52, 0.58, chipf) + nicks * wear * 0.6 + scr_line * 0.45 * wear * (1 - ss(0.5, 0.8, n2)), 0, 1)
    chip_edge = ss(0.46, 0.55, chipf) * (1 - chip)             # dark ring where the paint lifts
    # ---- scuffs, grime
    scr = np.abs(f3(P * np.array([1.0, 7.0, 1.0]), 26.0, 2, seed + 7))
    scuff = (1 - ss(0.0, 0.05, scr)) * ss(0.25, 0.7, n1) * 0.55
    grime = np.clip(0.75 * dmg * ss(0.3, 0.8, 0.5 + 0.5 * f3(P, 6.0, 3, seed + 9)) + 0.25 * ss(0.4, 0.9, n2) * 0.4, 0, 1)

    cracks = cracks * (1 - 0.85 * chip)
    # ---- paint colour
    v = 0.86 + 0.22 * vnoise(flat[:, 0] * 2.4, flat[:, 1] * 2.4, flat[:, 2] * 2.4, SEED + seed + 11).reshape(H, W)
    red = np.asarray(base)[None, None, :] * v[..., None]
    red = mix(red, red * 1.35 + np.array([0.05, 0.03, 0.03]), scuff * 0.7)
    col = red
    rough = 0.20 + 0.10 * n2 + 0.22 * grime + 0.2 * scuff
    metal = np.zeros((H, W))
    height = np.zeros((H, W))

    # emblem / disc overlays (drawn on the paint layer)
    if disc is not None:
        c, nrm, R, rgb = disc
        d, x, y, front = tangent_disc(P, np.asarray(c), np.asarray(nrm), R)
        inside = front & (d < 0)
        col = mix(col, np.asarray(rgb)[None, None, :] * (0.9 + 0.2 * n1[..., None]), inside * 1.0)
        rough = np.where(inside, 0.10 + 0.1 * n2, rough)
        height += inside * (-0.0004)
    if emblem is not None:
        c, nrm, R = emblem
        d, x, y, front = tangent_disc(P, np.asarray(c), np.asarray(nrm), R)
        ring = front & (np.abs(d) < 0.0065)
        # line - dot - line motif: horizontal bar with two dots
        bar = front & (np.abs(y) < 0.0055) & (np.abs(x) < R * 0.52)
        dots = front & ((np.hypot(np.abs(x) - R * 0.50, y) < R * 0.17))
        logo = ring | bar | dots
        white = np.array([0.80, 0.80, 0.78])
        col = mix(col, white[None, None, :] * (0.88 + 0.2 * n2[..., None]), logo * 1.0)
        rough = np.where(logo, 0.36, rough)
        height += logo * 0.0003

    # ---- bare metal where paint is lost
    mcol = np.array([0.50, 0.49, 0.47])[None, None, :] * (0.7 + 0.5 * n2[..., None])
    mcol = mix(mcol, np.array([0.30, 0.20, 0.16]), ss(0.55, 0.9, 1 - n1) * 0.35 * grime)     # light rust / soot staining
    col = mix(col, mcol, chip)
    col = mix(col, col * 0.18, chip_edge * 0.8)
    rough = np.where(chip > 0.5, 0.42 + 0.25 * n1, rough)
    metal = np.maximum(metal, chip * 0.85)
    height += -0.0008 * chip + -0.0003 * chip_edge * 0

    # ---- grime darkens paint and metal alike
    col = col * (1 - 0.40 * grime[..., None] * (1 - chip[..., None] * 0.5))
    # ---- cracks and panel gaps
    col = mix(col, np.array([0.015, 0.012, 0.012]), cracks * 0.92)
    col = mix(col, np.array([0.012, 0.011, 0.011]), groove * 0.95)
    rough = np.where(cracks > 0.4, 0.85, rough)
    height += -0.0026 * cracks - 0.0030 * groove
    ao = 1.0 - 0.55 * groove - 0.45 * cracks - 0.18 * chip_edge - 0.2 * grime
    orm = np.stack([np.clip(ao, 0, 1), np.clip(rough, 0.05, 1), np.clip(metal, 0, 1)], -1)
    nrm = normal_from_height(height * 1.6, dxm, dym)
    write_png(os.path.join(TEX, f'{name}_color.png'), np.clip(col, 0, 1))
    write_png(os.path.join(TEX, f'{name}_normal.png'), nrm)
    write_png(os.path.join(TEX, f'{name}_orm.png'), orm)


# ------------------------------------------------------------------ seamless tiles
def _pn(x, y, px, py, seed=0):
    xi, yi = np.floor(x), np.floor(y)
    fx, fy = x - xi, y - yi
    ux, uy = fx * fx * (3 - 2 * fx), fy * fy * (3 - 2 * fy)
    xi, yi = xi.astype(np.int64), yi.astype(np.int64)

    def c(dx, dy):
        return hash01((xi + dx) % px, (yi + dy) % py, np.zeros_like(xi), seed)
    return (c(0, 0) * (1 - ux) + c(1, 0) * ux) * (1 - uy) + (c(0, 1) * (1 - ux) + c(1, 1) * ux) * uy


def _pf(x, y, p, octaves=4, seed=0):
    tot, amp, nr, k = 0.0, 1.0, 0.0, 1
    for o in range(octaves):
        tot = tot + amp * (_pn(x * k, y * k, p * k, p * k, seed + 31 * o) * 2 - 1)
        nr += amp
        amp *= 0.5
        k *= 2
    return tot / nr


def tile_set(name, kind, N=1024):
    """Seamless tile sets: 'liner' (light grey primed inner plating), 'rim' (exposed laminate edge), 'gunmetal'."""
    u = (np.arange(N) + 0.5) / N
    X, Y = np.meshgrid(u, u)
    p = 8
    n1 = 0.5 + 0.5 * _pf(X * p, Y * p, p, 4, 3)
    n2 = 0.5 + 0.5 * _pf(X * 32, Y * 32, 32, 2, 9)
    brush = 0.5 + 0.5 * _pf(X * 6, Y * 160, 160, 2, 15)
    h = np.zeros((N, N))
    if kind == 'liner':
        col = mix(np.array([0.60, 0.61, 0.60]), np.array([0.47, 0.47, 0.46]), n1) * (0.94 + 0.1 * n2[..., None])
        # panel seams every 0.25 tile unit, rivets
        gx = np.abs(((X * 4) % 1) - 0.5)
        gy = np.abs(((Y * 4) % 1) - 0.5)
        seam = np.maximum(ss(0.485, 0.497, gx), ss(0.485, 0.497, gy))
        col = mix(col, col * 0.35, seam)
        h -= 0.0016 * seam
        rv = np.zeros((N, N))
        for cx in (0.04, 0.46):
            pass
        fx, fy = (X * 4) % 1, (Y * 4) % 1
        rv = np.maximum(1 - ss(0.012, 0.022, np.hypot(fx - 0.09, fy - 0.09)), 1 - ss(0.012, 0.022, np.hypot(fx - 0.91, fy - 0.91)))
        col = mix(col, col * 1.15, rv)
        h += 0.0012 * rv
        dirt = ss(0.55, 0.95, n1) * 0.5
        col = col * (1 - 0.35 * dirt[..., None])
        scr = ss(0.8, 0.95, brush) * 0.25
        col = mix(col, np.array([0.7, 0.7, 0.7]), scr)
        rough = 0.5 + 0.25 * n2
        metal = np.full((N, N), 0.25)
        ao = 1 - 0.5 * seam
    elif kind == 'rim':
        # fractured sheet edge: pale grey metal with dark crust and red paint skin flecks
        col = mix(np.array([0.58, 0.57, 0.55]), np.array([0.26, 0.25, 0.25]), n1) * (0.85 + 0.3 * brush[..., None])
        fleck = ss(0.72, 0.8, n2)
        col = mix(col, np.array([0.55, 0.04, 0.05]), fleck * 0.8)
        h += 0.0006 * (n2 - 0.5)
        rough = 0.45 + 0.25 * n1
        metal = np.full((N, N), 0.8) * (1 - fleck)
        ao = np.ones((N, N))
    else:  # gunmetal
        col = mix(np.array([0.13, 0.135, 0.145]), np.array([0.26, 0.265, 0.28]), n1 * 0.7 + 0.5 * brush * 0.4)
        wear = ss(0.68, 0.9, n2) * 0.55
        col = mix(col, np.array([0.42, 0.42, 0.43]), wear)
        h += 0.0003 * (brush - 0.5)
        rough = 0.32 + 0.3 * brush * 0.5 + 0.2 * wear
        metal = np.full((N, N), 0.92)
        ao = np.ones((N, N))
    nrm = normal_from_height(h * 2.0, 1.0 / N * 0.5, 1.0 / N * 0.5)
    write_png(os.path.join(TEX, f'{name}_color.png'), np.clip(col, 0, 1))
    write_png(os.path.join(TEX, f'{name}_normal.png'), nrm)
    write_png(os.path.join(TEX, f'{name}_orm.png'), np.stack([ao, np.clip(rough, 0.05, 1), metal], -1))
