"""Build one industrial candidate: python run.py <module> <asset_id> [--px 2048] [--samples 16] [--no-bake]"""
import argparse
import importlib
import os
import sys
import time

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
ap = argparse.ArgumentParser()
ap.add_argument('module')
ap.add_argument('asset')
ap.add_argument('--px', type=int, default=2048)
ap.add_argument('--samples', type=int, default=16)
ap.add_argument('--no-bake', action='store_true')
a = ap.parse_args()
mod = importlib.import_module(a.module)
spec = mod.ASSETS[a.asset]
import finish  # noqa: E402
t0 = time.time()
groups = spec['build']()
print({k: (len(v.t) if v is not None else 0) for k, v in groups.items()}, f'build {time.time() - t0:.1f}s', flush=True)
stats = finish.finish(a.asset, groups, paint_rgb=spec.get('paint', (0.2, 0.05, 0.04)), rust_gain=spec.get('rust_gain', 0.8), wear_gain=spec.get('wear_gain', 1.0),
                      bake_px=a.px, samples=a.samples, skip_bake=a.no_bake, bevel=spec.get('bevel', 0.0012))
finish.write_manifest_entry(stats, spec['replaces'], spec['category'], spec['label'], 'Textured PBR candidate (industrial kit); review.')
print(stats, f'total {time.time() - t0:.1f}s')
