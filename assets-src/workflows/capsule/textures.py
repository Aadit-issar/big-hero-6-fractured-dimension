"""Procedural PBR texture sets for the capsule family (numpy; PNG -> JPEG in the GLB).

 * wall atlas  (2048^2): backshell in two theta halves - off-white panels with recessed seams, rivet rows, fastener
                grids, access-panel outlines, screws and latches, small generic stencils, painted window frames,
                re-entry soot rising off the shoulder, flow streaks downstream of ports and vents, chipped paint to bare
                aluminium, rust-orange burn, scorch and heat tint round the breach, scratches.
 * heat-shield atlas (2048 x 1024): charred ablator blocks with filled gaps, pits and craters, char crack network,
                ash, glaze and rust-orange burn concentrated on the shoulder.
 * tile sets (512): whitepaint, gunmetal, primer, baremetal, honeycomb, blanket (MLI foil), isogrid, cabin,
                structure, avionics, floor, nozzle; plus a small emissive display.
All deterministic (seeded hash noise); 3D-position noise keeps the atlases seamless round the circumference.
"""
import math
import os
import sys
import time

import numpy as np

import kit
import layout as L
import shell as sh
from kit import TAU, STOT, S_E, S_B0, r_of, z_of, smoothstep, write_png, fbm, vnoise, hash01, worley2

SEED = kit.SEED
OUT = os.path.join(kit.HERE, 'build', 'tex')


# ------------------------------------------------------------------ helpers
def col(*c):
    return np.array(c, float)


def mix(a, b, t):
    t = np.asarray(t, float)[..., None]
    return np.asarray(a) * (1 - t) + np.asarray(b) * t


def normal_map(h, dx, dy, strength=1.0):
    """h metres; dx/dy metres per texel (broadcastable); image row 0 = top (v = 1)."""
    gy, gx = np.gradient(h)
    nx = -gx / dx * strength
    ny = gy / dy * strength
    nz = np.ones_like(h)
    Ln = np.sqrt(nx * nx + ny * ny + nz * nz)
    return np.stack([nx / Ln * 0.5 + 0.5, ny / Ln * 0.5 + 0.5, nz / Ln * 0.5 + 0.5], -1)


def pnoise(x, y, z, f, octaves=4, seed=0):
    return fbm(x * f, y * f, z * f, octaves, seed=seed)


def dome(d, r):
    return np.sqrt(np.clip(1 - (d / r) ** 2, 0, 1))


FONT = {
    'A': ['01110', '10001', '10001', '11111', '10001', '10001', '10001'], 'B': ['11110', '10001', '10001', '11110', '10001', '10001', '11110'],
    'C': ['01110', '10001', '10000', '10000', '10000', '10001', '01110'], 'D': ['11110', '10001', '10001', '10001', '10001', '10001', '11110'],
    'E': ['11111', '10000', '10000', '11110', '10000', '10000', '11111'], 'G': ['01110', '10001', '10000', '10111', '10001', '10001', '01111'],
    'H': ['10001', '10001', '10001', '11111', '10001', '10001', '10001'], 'I': ['01110', '00100', '00100', '00100', '00100', '00100', '01110'],
    'L': ['10000', '10000', '10000', '10000', '10000', '10000', '11111'], 'N': ['10001', '11001', '10101', '10011', '10001', '10001', '10001'],
    'O': ['01110', '10001', '10001', '10001', '10001', '10001', '01110'], 'P': ['11110', '10001', '10001', '11110', '10000', '10000', '10000'],
    'R': ['11110', '10001', '10001', '11110', '10100', '10010', '10001'], 'S': ['01111', '10000', '10000', '01110', '00001', '00001', '11110'],
    'T': ['11111', '00100', '00100', '00100', '00100', '00100', '00100'], 'U': ['10001', '10001', '10001', '10001', '10001', '10001', '01110'],
    'V': ['10001', '10001', '10001', '10001', '10001', '01010', '00100'], 'X': ['10001', '10001', '01010', '00100', '01010', '10001', '10001'],
    '0': ['01110', '10001', '10011', '10101', '11001', '10001', '01110'], '1': ['00100', '01100', '00100', '00100', '00100', '00100', '01110'],
    '2': ['01110', '10001', '00001', '00010', '00100', '01000', '11111'], '3': ['11110', '00001', '00001', '01110', '00001', '00001', '11110'],
    '4': ['00010', '00110', '01010', '10010', '11111', '00010', '00010'], '5': ['11111', '10000', '11110', '00001', '00001', '10001', '01110'],
    '7': ['11111', '00001', '00010', '00100', '01000', '01000', '01000'], '-': ['00000', '00000', '00000', '11111', '00000', '00000', '00000'],
    ' ': ['00000'] * 7,
}


def text_mask(x, y, text, height, stencil=True):
    """Bitmap stencil text centred on (0,0) in local metres; stencil bridges split the glyph strokes."""
    pix = height / 7.0
    total = len(text) * 6 * pix
    gx = (x + total / 2) / pix
    gy = (height / 2 - y) / pix
    inside = (gx >= 0) & (gx < len(text) * 6) & (gy >= 0) & (gy < 7)
    ci = np.clip(np.floor(gx).astype(int), 0, len(text) * 6 - 1)
    ch, cc = ci // 6, ci % 6
    ri = np.clip(np.floor(gy).astype(int), 0, 6)
    out = np.zeros(x.shape, bool)
    for k, c in enumerate(text):
        g = np.array([[1 if b == '1' else 0 for b in row] + [0] for row in FONT[c]])
        out |= inside & (ch == k) & (g[ri, np.clip(cc, 0, 5)] == 1)
    if stencil:
        fy = gy - np.floor(gy)
        out &= ~((ri == 3) & (fy > 0.35) & (fy < 0.65) & (cc == 2))
    return out


# ------------------------------------------------------------------ wall (backshell) channels
def wall_channels(TH, SS):
    """Height (m), base colour (sRGB), roughness, metalness, AO for backshell points (TH, SS arrays)."""
    R = r_of(SS)
    Z = z_of(SS)
    Px, Py = R * np.cos(TH), R * np.sin(TH)
    # streak space: stretched along s
    Sx, Sy = 1.9 * np.cos(TH), 1.9 * np.sin(TH)
    h = np.zeros(TH.shape)
    # --- panels
    row, gi, dv, dh = L.panel_ids(TH, SS)
    pid = row * 131 + gi * 7
    seam = np.minimum(dv, dh)
    groove = np.exp(-(seam / 0.0016) ** 2)
    h -= 0.0011 * groove
    plevel = (hash01(pid, row, None, SEED + 5) - 0.5) * 0.0005
    oil = pnoise(Px, Py, Z, 3.0, 3, SEED + 6) * 0.00035
    h += plevel + oil
    # rivet rows both sides of seams (35 mm pitch), plus a few fastener grids
    rv = np.zeros(TH.shape)
    sp = 0.035
    a = ((SS / sp) % 1.0 - 0.5) * sp
    rv = np.maximum(rv, dome(np.hypot(a, dv - 0.011), 0.0028) * (dv < 0.02))
    X = TH * R
    a2 = ((X / sp) % 1.0 - 0.5) * sp
    rv = np.maximum(rv, dome(np.hypot(a2, dh - 0.011), 0.0028) * (dh < 0.02))
    grid_p = hash01(pid, row + 9, None, SEED + 8) < 0.22
    g1 = ((SS / 0.09) % 1.0 - 0.5) * 0.09
    g2 = ((X / 0.09) % 1.0 - 0.5) * 0.09
    rv = np.maximum(rv, dome(np.hypot(g1, g2), 0.0024) * grid_p * (seam > 0.04))
    h += rv * 0.0006
    # --- access panels, hatch outline areas, housings
    acc = np.zeros(TH.shape)
    acc_in = np.zeros(TH.shape)
    for nm, th0, s0, w, hh in L.ACCESS:
        sdf = L.rect_sdf(TH, SS, th0, s0, w, hh, 0.02)
        e = np.exp(-(sdf / 0.0016) ** 2)
        acc = np.maximum(acc, e)
        acc_in = np.maximum(acc_in, (sdf < 0) * 1.0)
        h -= e * 0.0012
        for sx in (-1, 1):
            for sy in (-1, 1):
                x, y = L.local_xy(TH, SS, th0 + sx * (w / 2 - 0.02) / r_of(s0), s0 + sy * (hh / 2 - 0.02))
                dd = np.hypot(x, y)
                h += dome(dd, 0.005) * 0.0006 - np.exp(-(np.abs(x * 0.7 + y * 0.7) / 0.0007) ** 2) * (dd < 0.004) * 0.0004
        x, y = L.local_xy(TH, SS, th0, s0 - hh / 2 + 0.03)
        slot = np.exp(-((np.maximum(np.abs(x) - 0.02, 0) ** 2 + np.maximum(np.abs(y) - 0.005, 0) ** 2) / 0.0012 ** 2))
        h -= slot * 0.0012
        acc = np.maximum(acc, slot)
    # --- flush stencil text, labels
    tm = np.zeros(TH.shape, bool)
    txt, th0, s0, hgt = L.ID_TEXT
    x, y = L.local_xy(TH, SS, th0, s0)
    tm |= text_mask(x, y, txt, hgt)
    for txt, th0, s0, hgt in L.STENCILS:
        x, y = L.local_xy(TH, SS, th0, s0)
        if np.any((np.abs(x) < 0.4) & (np.abs(y) < 0.1)):
            tm |= text_mask(x, y, txt, hgt)
    # small hazard band near the umbilical and "rescue" arrow chevrons by the hatch
    x, y = L.local_xy(TH, SS, L.TH_HATCH + 1.05, S_B0 + 0.47)
    band = (np.abs(y) < 0.018) & (np.abs(x) < 0.14)
    stripe = ((x + y) / 0.022 % 1.0) < 0.5
    x, y = L.local_xy(TH, SS, L.TH_HATCH, S_B0 + 0.40)
    chev = (np.abs(np.abs(x) * 0.8 + y) < 0.008) & (np.abs(x) < 0.05)
    # --- colours: off-white paint with per-panel variation and some greyer thermal panels
    n_p = pnoise(Px, Py, Z, 6.0, 4, SEED + 13) * 0.5 + 0.5
    hp = hash01(pid, row + 3, None, SEED + 17)
    paint_hi, paint_lo = col(0.80, 0.79, 0.75), col(0.66, 0.65, 0.61)
    base = mix(paint_lo, paint_hi, np.clip(0.30 + 0.7 * n_p, 0, 1))
    base = base * (0.94 + 0.09 * hp)[..., None]
    grey = (hp > 0.86)
    base = np.where(grey[..., None], base * col(0.86, 0.86, 0.85), base)
    warm = (hp < 0.08)
    base = np.where(warm[..., None], base * col(0.97, 0.93, 0.85), base)
    rough = 0.52 + 0.14 * n_p
    metal = np.zeros(TH.shape)
    # --- grime and soot
    sc = L.scorch(TH, SS)
    streak = fbm(Sx * 30, Sy * 30, SS * 1.6, 4, seed=SEED + 23) * 0.5 + 0.5
    streak2 = fbm(Sx * 90, Sy * 90, SS * 4, 3, seed=SEED + 24) * 0.5 + 0.5
    lift = smoothstep(S_B0 + 0.75, S_B0 - 0.02, SS)          # soot rising off the heat-shield lip
    blot = smoothstep(-0.35, 0.45, pnoise(Px, Py, Z, 2.2, 4, SEED + 26))
    soot = lift ** 1.2 * (0.25 + 0.55 * blot + 0.35 * streak) * (0.8 + 0.25 * streak2)
    # downstream streaks from ports, vents, windows and the engine bay (flow runs towards the apex: +s)
    srcs = [(t0, s0, 0.06, 0.55) for t0, s0 in L.RCS] + [(t0, s0, w * 0.4, 0.45) for t0, s0, w, hh in L.VENTS]
    srcs += [(w[1], w[2] + 0.2, 0.25 if w[0] == 'main' else 0.08, 0.35) for w in L.WINDOWS[:3]]
    srcs += [(L.ENGINE_BAY[0] + dx / 1.9, L.ENGINE_BAY[1] + 0.3, 0.12, 0.9) for dx in (-0.42, 0.0, 0.42)]
    srcs += [(nm_[1], nm_[2] + nm_[4] / 2, nm_[3] * 0.4, 0.5) for nm_ in L.HOUSINGS]
    flow = np.zeros(TH.shape)
    for t0, s0, wd, ln in srcs:
        x, y = L.local_xy(TH, SS, t0, s0)
        f = np.exp(-(x / (wd * 0.7 * (1 + 0.5 * np.clip(y, 0, None) / ln))) ** 2) * np.exp(-np.clip(y, 0, None) / ln) * smoothstep(-0.03, 0.02, y)
        flow = np.maximum(flow, f)
    soot += flow * (0.2 + 0.7 * streak2) * 0.45
    # gravity runs below horizontal seams and around access panels
    runs = np.zeros(TH.shape)
    for e in L.ROW_EDGES[1:-1]:
        y = e - SS
        runs = np.maximum(runs, np.exp(-np.clip(y, 0, None) / 0.07) * (y > 0) * smoothstep(0.62, 0.9, streak2))
    soot += runs * 0.35
    soot += sc * (0.55 + 0.6 * streak) * 1.1
    soot = np.clip(soot + groove * 0.35 + rv * 0.2 + acc * 0.3, 0, 1)
    sootc = mix(col(0.11, 0.095, 0.08), col(0.035, 0.03, 0.028), np.clip(sc + lift * 0.5, 0, 1))
    base = mix(base, sootc, soot * 0.82)
    # rust-orange burn tint near the lip and the breach
    burn_n = pnoise(Px, Py, Z, 9.0, 4, SEED + 25)
    burn = np.clip(smoothstep(S_B0 + 0.35, S_B0 - 0.02, SS) * smoothstep(-0.25, 0.35, burn_n) + sc * smoothstep(-0.1, 0.45, burn_n) * 0.9, 0, 1)
    base = mix(base, col(0.42, 0.17, 0.05), burn * 0.42)
    # heat tint ring right at the tear
    D = L.breach_D(TH, SS)[0]
    tint = smoothstep(0.16, 0.0, D) * (D > -0.05)
    base = mix(base, col(0.16, 0.10, 0.07), tint * 0.6)
    # --- chipped paint -> bare aluminium (edge-weighted), rust in the heat zone
    ch = pnoise(Px, Py, Z, 22.0, 5, SEED + 29)
    edge_w = np.clip(groove * 1.2 + acc * 1.0 + np.exp(-(np.minimum(seam, 1) / 0.02) ** 2) * 0.5 + lift * 0.8 + sc * 0.55 + smoothstep(0.3, 0.0, D) * 0.45, 0, 2)
    chip_t = 0.62 - 0.30 * edge_w
    chip = smoothstep(chip_t, chip_t + 0.04, ch)
    rust_t = np.clip(chip * smoothstep(-0.1, 0.5, burn_n + 0.6 * sc + 0.4 * lift), 0, 1)
    bare = mix(col(0.55, 0.55, 0.56), col(0.40, 0.40, 0.41), streak2)
    rustc = mix(col(0.30, 0.13, 0.05), col(0.55, 0.25, 0.07), np.clip(0.5 + burn_n, 0, 1))
    base = mix(base, mix(bare, rustc, rust_t), chip)
    metal = np.maximum(metal, chip * (1 - rust_t) * 0.9)
    rough = np.where(chip > 0.5, 0.38 + 0.45 * rust_t, rough)
    h -= chip * 0.00012
    # scratches (fine directional lines)
    scr = fbm(Px * 2, Py * 2, Z * 260, 2, seed=SEED + 41)
    scratch = smoothstep(0.80, 0.86, np.abs(scr)) * smoothstep(0.2, 0.7, n_p)
    base = mix(base, col(0.60, 0.60, 0.61), scratch * 0.5)
    metal = np.maximum(metal, scratch * 0.5)
    # --- stencils (paint lost where chipped)
    base = mix(base, col(0.07, 0.07, 0.075), tm * (1 - chip * 0.8) * 0.92)
    base = np.where((band & stripe)[..., None], col(0.70, 0.52, 0.06) * (1 - soot[..., None] * 0.5), base)
    base = np.where((band & ~stripe)[..., None], col(0.06, 0.06, 0.06), base)
    base = mix(base, col(0.07, 0.07, 0.075), chev * 0.9)
    # --- painted window surrounds (anti-glare black) and window glass (seen on the far LOD where frames are dropped)
    wsd = L.windows_sdf(TH, SS)
    surround = smoothstep(0.075, 0.045, wsd)
    base = mix(base, col(0.06, 0.06, 0.065), surround * 0.9)
    base = np.where((wsd < 0)[..., None], col(0.02, 0.025, 0.03), base)
    rough = np.where(wsd < 0, 0.08, np.where(surround > 0.5, 0.45, rough))
    # crew hatch outline (LOD painting) and engine-bay shadow
    hs_ = L.rect_sdf(TH, SS, L.HATCH[1], L.HATCH[2], L.HATCH[3] + 0.2, L.HATCH[4] + 0.2, 0.1)
    ao = 1 - np.clip(groove * 0.6 + acc * 0.5 + rv * 0.1 + slot_ao(TH, SS), 0, 0.8)
    rough = np.clip(rough + soot * 0.18, 0.05, 1)
    return h, np.clip(base, 0, 1), rough, metal, ao


def slot_ao(TH, SS):
    """Contact shadow under raised hardware (engine bay, housings, hatch frame, RCS pods)."""
    a = np.zeros(TH.shape)
    th0, s0, w, hh = L.ENGINE_BAY
    a = np.maximum(a, smoothstep(0.08, -0.02, L.rect_sdf(TH, SS, th0, s0, w, hh, 0.1)) * 0.55)
    for nm, t0, s0_, bw, bh in L.HOUSINGS:
        a = np.maximum(a, smoothstep(0.05, -0.01, L.rect_sdf(TH, SS, t0, s0_, bw, bh + 0.08, 0.02)) * 0.5)
    a = np.maximum(a, smoothstep(0.05, 0.0, np.abs(L.rect_sdf(TH, SS, L.HATCH[1], L.HATCH[2], L.HATCH[3] + 0.22, L.HATCH[4] + 0.22, 0.1))) * 0.35)
    for t0, s0_ in L.RCS:
        a = np.maximum(a, smoothstep(0.04, 0.0, L.rect_sdf(TH, SS, t0, s0_, 0.27, 0.22, 0.03)) * 0.4)
    return a


# ------------------------------------------------------------------ heat shield channels
def hs_channels(TH, SS):
    R = r_of(SS)
    Z = z_of(SS)
    Px, Py = R * np.cos(TH), R * np.sin(TH)
    h = np.zeros(TH.shape)
    rows = np.array(L.HS_ROWS)
    ri = np.clip(np.searchsorted(rows, SS, side='right') - 1, 0, len(L.HS_COUNT) - 1)
    cnt = np.array(L.HS_COUNT)[ri]
    ph = np.mod(TH, TAU) / TAU * cnt + (ri % 2) * 0.5
    bi = np.floor(ph).astype(int) % np.maximum(cnt, 1)
    f = ph - np.floor(ph)
    dv = np.where(cnt > 1, np.minimum(f, 1 - f) * TAU / cnt * R, 9.0)
    dh = np.min([np.abs(SS - e) for e in rows[1:-1]], axis=0)
    gap_d = np.minimum(dv, dh)
    gap = smoothstep(0.0045, 0.0015, gap_d)
    bid = ri * 97 + bi
    hb = hash01(bid, ri, None, SEED + 9)
    h += (hb - 0.5) * 0.0016 - gap * 0.0018
    # pits / craters and crack network
    w1 = worley2((Px * 0.8 + Z * 0.6) / 0.012, (Py * 0.8 - Z * 0.6) / 0.012, seed=SEED + 61)
    pits = smoothstep(0.42, 0.10, w1[0]) * (hash01(np.floor(w1[2] * 1e6).astype(np.int64), None, None, SEED + 62) < 0.45)
    w2 = worley2((Px + Z * 0.3) / 0.035, (Py - Z * 0.4) / 0.035, seed=SEED + 63)
    crack = smoothstep(0.06, 0.0, w2[1] - w2[0]) * smoothstep(-0.2, 0.3, fbm(Px * 8, Py * 8, Z * 8, 2, seed=SEED + 64))
    grain = fbm(Px * 140, Py * 140, Z * 140, 3, seed=SEED + 65)
    char = fbm(Px * 7, Py * 7, Z * 7, 4, seed=SEED + 66)
    h += -pits * 0.0016 - crack * 0.0010 + grain * 0.00035 + char * 0.0012
    # plugs (round filled repair plugs) on some blocks
    pc = (bi + 0.5 - (ri % 2) * 0.5) / np.maximum(cnt, 1) * TAU
    smid = 0.5 * (rows[ri] + rows[np.minimum(ri + 1, len(rows) - 1)])
    x, y = L.local_xy(TH, SS, pc, smid)
    plug = (np.hypot(x - 0.05, y + 0.03) < 0.018) & (hb > 0.6) & (cnt > 1)
    h += np.where(plug, -0.0004, 0.0)
    # lip fasteners
    yl = SS - (S_E - 0.035)
    al = ((TH * R / 0.09) % 1.0 - 0.5) * 0.09
    lipb = dome(np.hypot(al, yl), 0.006)
    h += lipb * 0.0008
    # --- colours
    shoulder = smoothstep(1.55, 2.25, SS)
    base = mix(col(0.028, 0.026, 0.025), col(0.085, 0.078, 0.07), np.clip(0.5 + 0.8 * char, 0, 1))
    base = base * (0.75 + 0.5 * hb)[..., None]
    ash = smoothstep(0.25, 0.6, fbm(Px * 3, Py * 3, Z * 3, 4, seed=SEED + 67)) * (0.4 + 0.6 * shoulder)
    base = mix(base, col(0.26, 0.24, 0.22), ash * 0.45)
    # rust-orange burn: patchy, strongest on the shoulder, along gaps and cracks
    bn = fbm(Px * 5, Py * 5, Z * 5, 5, seed=SEED + 68)
    spots = smoothstep(0.55, 0.8, fbm(Px * 22, Py * 22, Z * 22, 3, seed=SEED + 70) * 0.5 + 0.5)
    burn = np.clip(smoothstep(0.30, 0.65, bn + 0.12 * shoulder) * (0.25 + 0.75 * shoulder) * 0.8 + gap * 0.35 * smoothstep(0.0, 0.4, bn) + crack * 0.25 + spots * 0.5 * shoulder, 0, 1)
    burnc = mix(col(0.30, 0.10, 0.03), col(0.66, 0.29, 0.07), np.clip(0.5 + bn * 1.5, 0, 1))
    base = mix(base, burnc, burn * 0.7)
    # flow streaks radiating from the stagnation region (fine radial striation)
    phi = np.arctan2(Py, Px)
    stri = fbm(np.cos(phi) * 60, np.sin(phi) * 60, SS * 2.5, 3, seed=SEED + 69)
    base = base * (0.92 + 0.12 * stri)[..., None]
    base = mix(base, col(0.025, 0.022, 0.02), gap * 0.7 + pits * 0.5)
    base = mix(base, col(0.20, 0.19, 0.18), plug * 0.8)
    base = mix(base, col(0.30, 0.30, 0.31), lipb * 0.6)
    # spall scars and breach scorch: darker, wetter-looking
    sc = L.scorch(TH, SS)
    base = mix(base, col(0.02, 0.018, 0.016), sc * 0.5)
    sp = L.spall_keep(TH, SS)
    pit = smoothstep(0.012, -0.012, sp)
    base = mix(base, mix(col(0.20, 0.13, 0.08), col(0.07, 0.05, 0.04), smoothstep(-0.3, 0.3, grain)), pit * 0.85)
    h -= pit * 0.001 - (fbm(Px * 60, Py * 60, Z * 60, 2, seed=SEED + 71) * 0.0012) * pit
    glaze = smoothstep(0.35, 0.75, char + 0.3 * shoulder) * (1 - burn)
    rough = np.clip(0.88 - 0.42 * glaze - 0.1 * lipb + 0.06 * grain, 0.3, 1)
    metal = lipb * 0.8
    ao = 1 - np.clip(gap * 0.6 + pits * 0.5 + crack * 0.3, 0, 0.8)
    return h, np.clip(base, 0, 1), rough, metal, ao


# ------------------------------------------------------------------ atlas writer
def atlas(name, chan_fn, W, H, s_of_v, s_lo, s_hi, outdir=OUT, chunk=128):
    """Two-half (theta) atlas matching shell.atlas_corner_uv; v within a half -> s by s_of_v (0..1)."""
    t0 = time.time()
    Hh = H // 2
    hgt = np.zeros((H, W), np.float32)
    colr = np.zeros((H, W, 3), np.float32)
    orm = np.zeros((H, W, 3), np.float32)
    dxm = np.zeros((H, 1), np.float32)
    dym = np.zeros((H, 1), np.float32)
    u = (np.arange(W) + 0.5) / W
    for half in (0, 1):
        lo = half * math.pi
        th_row = (lo - sh.ATLAS_PAD) + u * (math.pi + 2 * sh.ATLAS_PAD)
        rows = np.arange(Hh) + (0 if half == 0 else Hh)
        v = 1 - (rows + 0.5) / H
        vh = (v - (0.5 * (1 - half) + 0.004)) / (0.5 - 0.008)
        ss = s_of_v(np.clip(vh, 0, 1))
        for c0 in range(0, Hh, chunk):
            rr = rows[c0:c0 + chunk]
            S = np.repeat(ss[c0:c0 + chunk, None], W, 1)
            T = np.repeat(th_row[None], len(rr), 0)
            h, b, ro, me, ao = chan_fn(T, S)
            hgt[rr] = h; colr[rr] = b
            orm[rr] = np.stack([ao, ro, me], -1)
        dxm[rows, 0] = (math.pi + 2 * sh.ATLAS_PAD) / W * r_of(ss)
        dsv = np.gradient(ss) * -1
        dym[rows, 0] = np.maximum(np.abs(dsv), 1e-5)
    hgt = np.nan_to_num(hgt)
    nrm = np.zeros((H, W, 3), np.float32)
    for half in (0, 1):
        sl = slice(0, Hh) if half == 0 else slice(Hh, H)
        nrm[sl] = normal_map(hgt[sl], dxm[sl], dym[sl], 1.0)
    write_png(os.path.join(outdir, f'{name}_color.png'), colr)
    write_png(os.path.join(outdir, f'{name}_normal.png'), nrm)
    write_png(os.path.join(outdir, f'{name}_orm.png'), orm)
    print(name, W, H, f'{time.time() - t0:.1f}s', flush=True)


def wall_atlas(W=2048, H=2048):
    atlas('wall', wall_channels, W, H, lambda v: S_B0 + v * (STOT - S_B0), S_B0, STOT)


def hs_atlas(W=2048, H=1024):
    atlas('hs', hs_channels, W, H, sh.hs_s_of_v, 0.0, S_E)


def region_tex(name, chan_fn, th_lo, th_hi, s_lo, s_hi, n=1024):
    """Dedicated texture over a parameter rectangle (for shell fragments): u = theta, v = s, both linear."""
    u = (np.arange(n) + 0.5) / n
    th = th_lo + u * (th_hi - th_lo)
    v = 1 - (np.arange(n) + 0.5) / n
    ss = s_lo + v * (s_hi - s_lo)
    T, S = np.meshgrid(th, ss)
    h, b, ro, me, ao = chan_fn(T, S)
    dx = (th_hi - th_lo) / n * r_of(ss)[:, None]
    dy = (s_hi - s_lo) / n
    write_png(os.path.join(OUT, f'{name}_color.png'), b)
    write_png(os.path.join(OUT, f'{name}_normal.png'), normal_map(h, dx, dy))
    write_png(os.path.join(OUT, f'{name}_orm.png'), np.stack([ao, ro, me], -1))


# ------------------------------------------------------------------ seamless tile sets
def _grid(n):
    u = (np.arange(n) + 0.5) / n
    return np.meshgrid(u, u)


def _pn(x, y, px, py, seed):
    xi, yi = np.floor(x), np.floor(y)
    fx, fy = x - xi, y - yi
    ux, uy = fx * fx * (3 - 2 * fx), fy * fy * (3 - 2 * fy)
    xi, yi = xi.astype(np.int64), yi.astype(np.int64)

    def c(dx, dy):
        return hash01((xi + dx) % px, (yi + dy) % py, None, seed)
    return (c(0, 0) * (1 - ux) + c(1, 0) * ux) * (1 - uy) + (c(0, 1) * (1 - ux) + c(1, 1) * ux) * uy


def tp(U, V, f, octaves=4, seed=0):
    """Tileable fbm on the unit square (integer lattice periods), roughly [-1, 1]."""
    f = max(1, int(round(f)))
    tot, amp, nrm = 0.0, 1.0, 0.0
    for o in range(octaves):
        ff = f * 2 ** o
        tot = tot + amp * (_pn(U * ff + 0.37 * o, V * ff + 0.71 * o, ff, ff, seed + 31 * o) * 2 - 1)
        nrm += amp
        amp *= 0.5
    return tot / nrm


def tworley(U, V, cells, seed=0):
    """Tileable worley (F1, F2, id) with integer cells per tile."""
    x, y = U * cells, V * cells
    xi, yi = np.floor(x).astype(np.int64), np.floor(y).astype(np.int64)
    f1 = np.full(x.shape, 9.0); f2 = np.full(x.shape, 9.0); cid = np.zeros(x.shape)
    for dx in (-1, 0, 1):
        for dy in (-1, 0, 1):
            cx, cy = xi + dx, yi + dy
            wx, wy = cx % cells, cy % cells
            px = cx + 0.5 + (hash01(wx, wy, None, seed) - 0.5) * 0.9
            py = cy + 0.5 + (hash01(wx, wy, None, seed + 7) - 0.5) * 0.9
            d = np.hypot(px - x, py - y)
            closer = d < f1
            f2 = np.where(closer, f1, np.minimum(f2, d))
            cid = np.where(closer, hash01(wx, wy, None, seed + 13), cid)
            f1 = np.where(closer, d, f1)
    return f1, f2, cid


def grooves(U, V, nx, ny, w):
    fu, fv = (U * nx) % 1.0, (V * ny) % 1.0
    d = np.minimum(np.minimum(fu, 1 - fu) / nx, np.minimum(fv, 1 - fv) / ny)
    return np.exp(-(d / w) ** 2), np.floor(U * nx).astype(int) + 97 * np.floor(V * ny).astype(int)


def write_set(name, base, h, rough, metal, ao, tile_m, emit=None):
    n = base.shape[0]
    d = tile_m / n
    write_png(os.path.join(OUT, f'{name}_color.png'), np.clip(base, 0, 1))
    write_png(os.path.join(OUT, f'{name}_normal.png'), normal_map(h, d, d))
    write_png(os.path.join(OUT, f'{name}_orm.png'), np.stack([np.clip(ao, 0, 1), np.clip(rough, 0.04, 1), np.clip(metal, 0, 1)], -1))
    if emit is not None:
        write_png(os.path.join(OUT, f'{name}_emit.png'), np.clip(emit, 0, 1))


def painted(U, V, n, base_lo, base_hi, tile_m, seed, nx=2, ny=2, metal0=0.0, rough0=0.5, wear=0.6, grime=0.5, vents=False):
    g, pid = grooves(U, V, nx, ny, 0.004)
    n1 = tp(U, V, 6, 5, seed) * 0.5 + 0.5
    fine = tp(U, V, 40, 3, seed + 3) * 0.5 + 0.5
    base = mix(base_lo, base_hi, np.clip(0.2 + 0.9 * n1, 0, 1)) * (0.95 + 0.08 * hash01(pid, 5, None, seed + 4))[..., None]
    h = -g * 0.0012 + (fine - 0.5) * 0.00015
    ch = tp(U, V, 18, 5, seed + 6)
    chip = smoothstep(0.45 - wear * 0.25 * (1 + g * 2), 0.5 - wear * 0.25 * (1 + g * 2), ch)
    rust = smoothstep(0.1, 0.4, tp(U, V, 9, 3, seed + 8)) * chip
    base = mix(base, mix(col(0.52, 0.52, 0.53), col(0.45, 0.20, 0.06), rust), chip)
    dirt = np.clip(smoothstep(0.0, 0.5, tp(U, V, 4, 4, seed + 9)) * grime + g * 0.5, 0, 1)
    base = mix(base, col(0.06, 0.055, 0.05), dirt * 0.55)
    rough = np.clip(rough0 + 0.2 * (fine - 0.5) + 0.25 * dirt + 0.2 * rust - 0.1 * chip * (1 - rust), 0.1, 1)
    metal = np.clip(metal0 * (1 - chip) + chip * (1 - rust) * 0.9, 0, 1)
    h -= chip * 0.00015
    ao = 1 - np.clip(g * 0.6, 0, 0.8)
    if vents:
        fu, fv = (U * nx) % 1.0, (V * ny) % 1.0
        slot = (np.abs(fu - 0.5) < 0.30) & (np.abs(((fv * 7) % 1.0) - 0.5) < 0.16) & (fv > 0.55) & (fv < 0.9) & (pid % 3 == 1)
        h -= slot * 0.0015
        base = np.where(slot[..., None], base * 0.3, base)
        ao = ao - slot * 0.4
    for sx in (0.08, 0.92):
        for sy in (0.08, 0.92):
            dd = np.hypot(((U * nx) % 1.0 - sx) / nx, ((V * ny) % 1.0 - sy) / ny) * tile_m
            h += dome(dd, 0.004) * 0.0007
    return base, h, rough, metal, ao


def tile_sets(n=512):
    U, V = _grid(n)
    t = time.time()
    write_set('whitepaint', *painted(U, V, n, col(0.62, 0.61, 0.57), col(0.80, 0.79, 0.75), 0.4, SEED + 100, 2, 2, 0.0, 0.5, 0.5, 0.45), 0.4)
    write_set('gunmetal', *painted(U, V, n, col(0.13, 0.135, 0.14), col(0.28, 0.285, 0.30), 0.3, SEED + 110, 3, 3, 0.75, 0.45, 0.7, 0.5, vents=True), 0.3)
    write_set('avionics', *painted(U, V, n, col(0.10, 0.105, 0.11), col(0.19, 0.195, 0.205), 0.25, SEED + 120, 2, 4, 0.1, 0.55, 0.4, 0.3, vents=True), 0.25)
    write_set('structure', *painted(U, V, n, col(0.36, 0.37, 0.38), col(0.52, 0.53, 0.54), 0.3, SEED + 130, 1, 1, 0.3, 0.5, 0.5, 0.5), 0.3)
    b, h, r, m, a = painted(U, V, n, col(0.30, 0.34, 0.27), col(0.43, 0.47, 0.37), 0.4, SEED + 140, 1, 1, 0.0, 0.6, 0.5, 0.6)
    write_set('primer', b, h, r, m, a, 0.4)
    # cabin wall: light grey panels, fastener rows, small label plates
    g, pid = grooves(U, V, 2, 3, 0.003)
    n1 = tp(U, V, 5, 4, SEED + 150) * 0.5 + 0.5
    base = mix(col(0.48, 0.48, 0.47), col(0.66, 0.66, 0.64), n1) * (0.93 + 0.1 * hash01(pid, 2, None, SEED + 151))[..., None]
    fu, fv = (U * 2) % 1.0, (V * 3) % 1.0
    lab = (np.abs(fu - 0.25) < 0.08) & (np.abs(fv - 0.75) < 0.04) & (pid % 2 == 0)
    base = np.where(lab[..., None], col(0.12, 0.12, 0.13), base)
    rings = (np.hypot(((U * 16) % 1 - 0.5), ((V * 3) % 1.0 - 0.06) * 5) < 0.12)
    h = -g * 0.001 + rings * 0.0004
    base = mix(base, col(0.06, 0.06, 0.06), g * 0.6)
    write_set('cabin', base, h, 0.55 + 0.1 * n1, 0.05 + 0 * n1, 1 - g * 0.6, 0.5)
    # bare metal (torn edges): bright scratched aluminium, soot
    sc = tp(U, V * 0.1, 80, 2, SEED + 160)
    n1 = tp(U, V, 8, 4, SEED + 161) * 0.5 + 0.5
    base = mix(col(0.45, 0.45, 0.46), col(0.70, 0.70, 0.71), np.clip(0.5 + sc, 0, 1))
    base = mix(base, col(0.10, 0.08, 0.07), smoothstep(0.45, 0.8, n1) * 0.7)
    write_set('baremetal', base, sc * 0.0002, 0.32 + 0.3 * n1, 0.95 - 0.5 * smoothstep(0.45, 0.8, n1), np.ones_like(n1), 0.1)
    # honeycomb ablator (broken edges): hex cells, dark char with tan fibre core
    q = U * 18 / 0.866
    r = V * 18
    cx = np.round(q)
    cy = np.round(r - (cx % 2) * 0.5) + (cx % 2) * 0.5
    d = np.hypot((q - cx) * 0.866, r - cy)
    wall = smoothstep(0.38, 0.46, d)
    n1 = tp(U, V, 6, 4, SEED + 170) * 0.5 + 0.5
    fill = mix(col(0.16, 0.12, 0.09), col(0.36, 0.27, 0.18), n1)
    base = mix(fill, col(0.06, 0.05, 0.045), wall * 0.8)
    base = mix(base, col(0.03, 0.028, 0.026), smoothstep(0.55, 0.85, n1) * 0.7)
    write_set('honeycomb', base, wall * 0.0007 - (1 - wall) * 0.0004 + (n1 - 0.5) * 0.001, 0.9 - 0.1 * wall, 0 * n1, 1 - (1 - wall) * 0.3, 0.12)
    # blanket: crinkled MLI foil (gold / bronze) with soot and stitch lines
    f1, f2, cid = tworley(U, V, 40, SEED + 180)
    crink = (f2 - f1)
    n1 = tp(U, V, 5, 4, SEED + 181) * 0.5 + 0.5
    base = mix(col(0.26, 0.17, 0.06), col(0.46, 0.33, 0.13), np.clip(cid * 0.6 + n1 * 0.5, 0, 1))
    stitch = (np.abs(((U * 4) % 1.0) - 0.5) < 0.006) & (((V * 60) % 1.0) < 0.6)
    base = np.where(stitch[..., None], col(0.2, 0.18, 0.15), base)
    base = mix(base, col(0.05, 0.04, 0.035), smoothstep(0.40, 0.85, n1) * 0.8)
    write_set('blanket', base, crink * 0.0012 + cid * 0.0006, 0.30 + 0.25 * smoothstep(0.55, 0.9, n1), 0.9 - 0.6 * smoothstep(0.55, 0.9, n1), 1 - 0.3 * smoothstep(0.1, 0.0, crink), 0.25)
    # isogrid pressure-wall outer face: triangular pockets
    s3 = math.sqrt(3)
    x, y = U * 6, V * 6 * s3 / 2 / (s3 / 2)
    l1 = np.abs(((y / (s3 / 2)) % 1.0) - 0.5)
    l2 = np.abs((((y * 0.5 + x * s3 / 2) / (s3 / 2)) % 1.0) - 0.5)
    l3 = np.abs((((y * 0.5 - x * s3 / 2) / (s3 / 2)) % 1.0) - 0.5)
    rib = smoothstep(0.43, 0.47, np.maximum(np.maximum(l1, l2), l3))
    n1 = tp(U, V, 6, 4, SEED + 190) * 0.5 + 0.5
    base = mix(col(0.20, 0.21, 0.20), col(0.33, 0.34, 0.33), n1)
    base = mix(base, col(0.44, 0.44, 0.45), rib * 0.5)
    base = mix(base, col(0.05, 0.045, 0.04), smoothstep(0.35, 0.8, n1) * 0.75)
    write_set('isogrid', base, rib * 0.003, 0.45 - rib * 0.15, 0.6 + 0.3 * rib, 1 - (1 - rib) * 0.25, 0.5)
    # floor: anti-slip tread plate
    a = ((U * 20 + V * 20) % 1.0 - 0.5); b_ = ((U * 20 - V * 20) % 1.0 - 0.5)
    tread = np.where(((np.floor(U * 20) + np.floor(V * 20)) % 2) == 0, np.exp(-(a / 0.12) ** 2), np.exp(-(b_ / 0.12) ** 2)) * (np.abs(a + b_) < 0.6)
    n1 = tp(U, V, 4, 4, SEED + 200) * 0.5 + 0.5
    base = mix(col(0.16, 0.16, 0.17), col(0.30, 0.30, 0.31), n1)
    base = mix(base, col(0.42, 0.42, 0.43), tread * 0.5)
    write_set('floor', base, tread * 0.0012, 0.55 - 0.2 * tread, 0.6 + 0.3 * tread, np.ones_like(n1), 0.6)
    # nozzle interior: heat-tinted, sooty metal
    n1 = tp(U, V, 5, 4, SEED + 210) * 0.5 + 0.5
    band = np.sin(V * TAU * 3 + n1 * 3) * 0.5 + 0.5
    base = mix(col(0.18, 0.12, 0.08), col(0.20, 0.20, 0.30), band * 0.5)
    base = mix(base, col(0.03, 0.025, 0.02), smoothstep(0.35, 0.75, n1) * 0.8)
    write_set('nozzle', base, (n1 - 0.5) * 0.0006, 0.55 + 0.3 * n1, 0.7 * (1 - n1), np.ones_like(n1), 0.3)
    # emissive display (simple bar graph and text lines), 256
    m = 256
    Us, Vs = _grid(m)
    em = np.zeros((m, m, 3))
    frame = (Us < 0.03) | (Us > 0.97) | (Vs < 0.04) | (Vs > 0.96)
    lines = (((Vs * 14) % 1.0) < 0.35) & (Us > 0.08) & (Us < 0.08 + 0.4 * hash01(np.floor(Vs * 14).astype(int), None, None, SEED + 220)) & (Vs > 0.5)
    bars = (Vs < 0.12 + 0.3 * hash01(np.floor(Us * 12).astype(int), None, None, SEED + 221)) & (((Us * 12) % 1.0) < 0.6) & (Us > 0.5) & (Vs > 0.08)
    wave = np.abs(Vs - (0.28 + 0.08 * np.sin(Us * 30))) < 0.012
    em[frame] = (0.10, 0.28, 0.42)
    em[lines] = (0.35, 0.75, 0.95)
    em[bars] = (0.20, 0.55, 0.85)
    em[wave & (Us < 0.48)] = (0.95, 0.65, 0.20)
    base = em * 0.25 + 0.02
    write_png(os.path.join(OUT, 'screen_color.png'), base)
    write_png(os.path.join(OUT, 'screen_normal.png'), np.broadcast_to(np.array([0.5, 0.5, 1.0]), (m, m, 3)))
    write_png(os.path.join(OUT, 'screen_orm.png'), np.broadcast_to(np.array([1.0, 0.2, 0.0]), (m, m, 3)))
    write_png(os.path.join(OUT, 'screen_emit.png'), em)
    print('tiles', f'{time.time() - t:.1f}s', flush=True)


def downscale_all(divs=(2, 4)):
    """Box-filtered copies for the LODs (build/tex/div2, div4); normal maps renormalised."""
    import glob
    for f in glob.glob(os.path.join(OUT, '*.png')):
        img = _read_png(f)
        for d in divs:
            h, w = img.shape[:2]
            if min(h, w) // d < 16:
                continue
            a = img[:h - h % d, :w - w % d].reshape(h // d, d, w // d, d, -1).mean((1, 3))
            if f.endswith('_normal.png'):
                v = a / 255.0 * 2 - 1
                v /= np.linalg.norm(v, axis=-1, keepdims=True) + 1e-9
                a = (v * 0.5 + 0.5) * 255
            write_png(os.path.join(OUT, f'div{d}', os.path.basename(f)), (a + 0.5).clip(0, 255).astype(np.uint8))


def _read_png(path):
    import zlib as z
    import struct as st
    data = open(path, 'rb').read()
    pos = 8
    idat = b''
    while pos < len(data):
        ln, = st.unpack('>I', data[pos:pos + 4]); typ = data[pos + 4:pos + 8]
        body = data[pos + 8:pos + 8 + ln]
        if typ == b'IHDR':
            w, h, bd, ct = st.unpack('>IIBB', body[:10])
        elif typ == b'IDAT':
            idat += body
        pos += 12 + ln
    ch = {0: 1, 2: 3, 6: 4}[ct]
    raw = np.frombuffer(z.decompress(idat), np.uint8).reshape(h, w * ch + 1)
    assert (raw[:, 0] == 0).all(), 'only unfiltered PNGs (our own writer)'
    return raw[:, 1:].reshape(h, w, ch).astype(np.float32)


if __name__ == '__main__':
    os.makedirs(OUT, exist_ok=True)
    what = sys.argv[1:] or ['tiles', 'wall', 'hs', 'down']
    if 'tiles' in what:
        tile_sets()
    if 'wall' in what:
        wall_atlas()
    if 'hs' in what:
        hs_atlas()
    if 'frags' in what:
        import parts
        for nm, fn in (('frag', wall_channels), ('frag2', wall_channels), ('fraghs', hs_channels)):
            a0, a1, b0, b1 = parts.FRAG_UV[nm]
            region_tex(nm, fn, a0, a1, b0, b1, 1024)
            print(nm, flush=True)
    if 'down' in what:
        downscale_all()
