"""Hero capsule shell remnant assembly (LOD-aware)."""
import numpy as np

import kit
import shell as sh
import exterior
import interior
from kit import Mesh

QUALITY = {
    0: dict(h0=0.085, h_hs=0.085, h_bottom=0.36, hmin=0.012, h_win=0.035, h_pw=0.24, damage=True, windows=True,
            str_step=0.05, frame_fine=0.022, frame_coarse=0.25, frame_rows=3, n_lathe=96, detail=2),
    1: dict(h0=0.13, h_hs=0.14, h_bottom=0.40, hmin=0.028, h_win=0.06, h_pw=0.40, damage=True, windows=True,
            str_step=0.07, frame_fine=0.04, frame_coarse=0.2, frame_rows=3, n_lathe=48, detail=1),
}


def hero(lod=0, parts=('shell', 'layers', 'hardware', 'interior')):
    Q = QUALITY[lod]
    P = []
    if 'shell' in parts:
        P += [sh.ablator(Q), sh.skin(Q)] + sh.deck(Q)
    if 'layers' in parts:
        P += [sh.pressure_wall(Q), sh.insulation(Q)] + sh.stringers(Q)
        for k, (z, d) in enumerate(((0.92, 0.14), (1.40, 0.11), (1.95, 0.10))):
            P += sh.ring_frame(z, d, Q, k)
    if 'interior' in parts:
        P += interior.interior(Q)
    if 'hardware' in parts:
        P += exterior.exterior(Q)
    return Mesh.concat(P)
