"""Top-down and side density maps of the decorative layout over the explorable space,
plus spread metrics. Input: JSON from scripts/placement-world.ts.
Usage: python scripts/placement-plot.py <world.json> <out.png> [title] [metrics.json]
"""
import json
import sys

import matplotlib
matplotlib.use('Agg')
import matplotlib.pyplot as plt
from matplotlib.patches import Circle
import numpy as np

src, out = sys.argv[1], sys.argv[2]
title = sys.argv[3] if len(sys.argv) > 3 else ''
metrics_out = sys.argv[4] if len(sys.argv) > 4 else None
w = json.load(open(src))

D = np.array([d['position'] for d in w['debris']]) if w['debris'] else np.zeros((0, 3))
R = np.array([d['radius'] for d in w['debris']]) if w['debris'] else np.zeros(0)
clusters = [d['cluster'] for d in w['debris']]
def group_of(c, d):
    return d.get('region') or ('vortex' if c.startswith('vortex-') else c)
groups = sorted(set(group_of(c, d) for c, d in zip(clusters, w['debris'])))

# Explorable volume used for the spread metrics: the island chamber (island
# centres ± 22 m horizontally, ± 14 m vertically), sampled on a fixed Halton set,
# excluding island clearance spheres. Fixed, seed-free and identical before/after.
C = np.array([i['centre'] for i in w['islands']])
lo = C.min(0) - np.array([22, 14, 22]); hi = C.max(0) + np.array([22, 14, 22])
def halton(i, b):
    f, r = 1.0, 0.0
    while i > 0:
        f /= b; r += f * (i % b); i //= b
    return r
P = np.array([[halton(i, 2), halton(i, 3), halton(i, 5)] for i in range(1, 6001)]) * (hi - lo) + lo
keep = np.ones(len(P), bool)
for isl in w['islands']:
    keep &= np.linalg.norm(P - np.array(isl['centre']), axis=1) > isl['clearance'] + 1
P = P[keep]
if len(D):
    nearest = np.min(np.linalg.norm(P[:, None, :] - D[None, :, :], axis=2), axis=1)
else:
    nearest = np.full(len(P), np.inf)
inside = (D >= lo).all(1) & (D <= hi).all(1) if len(D) else np.zeros(0, bool)
# Horizontal 15 m cells over the chamber footprint.
cell = 15.0
nx, nz = int(np.ceil((hi[0] - lo[0]) / cell)), int(np.ceil((hi[2] - lo[2]) / cell))
grid = np.zeros((nz, nx))
for p in D[inside]:
    grid[min(nz - 1, int((p[2] - lo[2]) // cell)), min(nx - 1, int((p[0] - lo[0]) // cell))] += 1
counts = np.sort(grid.ravel())
gini = float((2 * np.arange(1, len(counts) + 1) - len(counts) - 1).dot(counts) / (len(counts) * counts.sum())) if counts.sum() else 1.0
# Clustering: share of all pieces inside the densest 20 m sphere.
dens = max((np.linalg.norm(D - p, axis=1) < 20).sum() for p in D) if len(D) else 0
metrics = {
    'debris': int(len(D)), 'debrisInChamber': int(inside.sum()), 'formations': len(w['formations']),
    'microbots': int(sum(f['units'] for f in w['formations'])),
    'chamberBox': [lo.round(1).tolist(), hi.round(1).tolist()],
    'emptyDistance_m': {'median': float(np.median(nearest).round(1)), 'p90': float(np.percentile(nearest, 90).round(1)), 'max': float(nearest.max().round(1))},
    'fractionWithin12m': float((nearest < 12).mean().round(3)), 'fractionWithin20m': float((nearest < 20).mean().round(3)),
    'cells15m': {'total': int(grid.size), 'occupied': int((grid > 0).sum()), 'occupiedFraction': float(((grid > 0).sum() / grid.size).round(3)), 'gini': round(gini, 3), 'max': int(grid.max())},
    'densest20mShare': round(dens / max(1, len(D)), 3),
    'byRegion': {g: sum(1 for c, d in zip(clusters, w['debris']) if group_of(c, d) == g) for g in groups},
}

fig, axes = plt.subplots(1, 2, figsize=(20, 10), gridspec_kw={'width_ratios': [1.25, 1]})
for ax, (a, b, la, lb) in zip(axes, [(0, 2, 'x (m)', 'z (m)'), (2, 1, 'z (m)', 'y (m)')]):
    ax.set_facecolor('#0d0b16')
    H = np.array([h['world'] for h in w['hazard']]); hz = np.array([h['hazard'] for h in w['hazard']])
    m = hz > 0.4
    ax.scatter(H[m, a], H[m, b], c=hz[m], cmap='autumn_r', s=6, alpha=0.18, vmin=0.4, vmax=0.7, label='hazard > 0.4 (t=0)')
    cav = np.array(w['cavern'])
    ax.plot(cav[:, a], cav[:, b], color='#555577', lw=1, ls='--', label='cavern centreline')
    for isl in w['islands']:
        p = np.array(isl['path'])
        ax.plot(p[:, a], p[:, b], color='#3d6f6a', lw=0.6, alpha=0.6)
        ax.add_patch(Circle((isl['centre'][a], isl['centre'][b]), isl['clearance'], color='#5fd0c0', alpha=0.35))
        if a == 0: ax.text(isl['centre'][a], isl['centre'][b], isl['id'].replace('island-', ''), color='white', fontsize=8, ha='center', va='center')
    F = np.array(w['foldPoints'])
    if len(F): ax.scatter(F[:, a], F[:, b], marker='x', s=10, color='#78f1e4', alpha=0.5, label='fold endpoints (swept)')
    cmap = plt.get_cmap('tab20')
    for k, g in enumerate(groups):
        idx = [i for i, (c, d) in enumerate(zip(clusters, w['debris'])) if group_of(c, d) == g]
        ax.scatter(D[idx, a], D[idx, b], s=np.clip(R[idx] * 14, 4, 120), color=cmap(k % 20), edgecolor='black', lw=0.3, label=f'{g} ({len(idx)})')
    for f in w['formations']:
        ax.add_patch(Circle((f['centre'][a], f['centre'][b]), max(1.2, f['radius']), fill=False, color='#ffd166', lw=1))
    o, t = np.array(w['opening']), np.array(w['openingTarget'])
    ax.annotate('', xy=(o[a] + (t[a] - o[a]) * 0.25, o[b] + (t[b] - o[b]) * 0.25), xytext=(o[a], o[b]), arrowprops=dict(color='white', arrowstyle='->'))
    ax.plot(o[a], o[b], 'w*', ms=12, label='opening pose')
    ax.add_patch(plt.Rectangle((lo[a], lo[b]), hi[a] - lo[a], hi[b] - lo[b], fill=False, color='#888', ls=':', lw=1))
    ax.set_xlabel(la); ax.set_ylabel(lb); ax.set_aspect('equal'); ax.grid(color='#333', lw=0.4)
    if a == 0: ax.invert_yaxis()
axes[0].set_title('Top-down (x–z): debris, islands (clearance), folds, hazard')
axes[1].set_title('Side (z–y)')
axes[0].set_xlim(-100, 135); axes[0].set_ylim(40, -230)
axes[1].set_xlim(-230, 40); axes[1].set_ylim(-45, 110)
axes[0].legend(loc='lower left', fontsize=7, ncol=2, facecolor='#222', labelcolor='white')
fig.suptitle(f"{title}  —  {metrics['debris']} pieces, chamber cells occupied {metrics['cells15m']['occupied']}/{metrics['cells15m']['total']}, "
             f"median empty distance {metrics['emptyDistance_m']['median']} m, densest-20m share {metrics['densest20mShare']}", fontsize=12)
fig.tight_layout()
fig.savefig(out, dpi=110)
print(json.dumps(metrics, indent=1))
if metrics_out:
    json.dump(metrics, open(metrics_out, 'w'), indent=1)
