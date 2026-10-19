"""Fetch and prepare the CC0 Poly Haven texture sets used by the pilot assets (reproducible).

Downloads 2K JPEGs from Poly Haven's CDN (CC0 1.0, https://polyhaven.com/license), downsizes to 1K
and applies a documented grade. Run with any Python that has Pillow:
  python -I assets-src/pilots/prepare_textures.py
Outputs assets-src/pilots/textures/*.jpg (committed) and textures/SOURCES.json.
"""
import io
import json
import os
import urllib.request

from PIL import Image, ImageEnhance

OUT = os.path.join(os.path.dirname(__file__), 'textures')
HEADERS = {'User-Agent': 'bh6-asset-pipeline/1.0 (personal project; CC0 textures)'}
SIZE = 1024

# set id -> (output prefix, saturation, brightness)  [applied to the diffuse map only]
SETS = {
    'concrete_wall_007': ('concrete_wall_007', 0.30, 0.86),   # cast faces: formwork-marked grey concrete
    'concrete_debris': ('concrete_debris', 0.22, 0.95),       # fresh fracture: crushed aggregate in paste (brick reds muted)
    'rust_coarse_01': ('rebar_rust', 0.80, 0.62),             # rebar: mill scale and rust
}


def get(url):
    return urllib.request.urlopen(urllib.request.Request(url, headers=HEADERS), timeout=90).read()


def main():
    os.makedirs(OUT, exist_ok=True)
    sources = {}
    for sid, (prefix, sat, bright) in SETS.items():
        info = json.loads(get(f'https://api.polyhaven.com/info/{sid}'))
        files = json.loads(get(f'https://api.polyhaven.com/files/{sid}'))
        sources[sid] = {'name': info.get('name'), 'authors': info.get('authors'), 'url': f'https://polyhaven.com/a/{sid}', 'licence': 'CC0 1.0',
                        'files': {k: files[k]['2k']['jpg']['url'] for k in ('Diffuse', 'nor_gl', 'arm')}}
        for key, tag in (('Diffuse', 'diff'), ('nor_gl', 'nor_gl'), ('arm', 'arm')):
            im = Image.open(io.BytesIO(get(files[key]['2k']['jpg']['url']))).convert('RGB').resize((SIZE, SIZE), Image.LANCZOS)
            if tag == 'diff':
                im = ImageEnhance.Color(im).enhance(sat)
                im = ImageEnhance.Brightness(im).enhance(bright)
            im.save(os.path.join(OUT, f'{prefix}_{tag}_1k.jpg'), quality=88, optimize=True)
            print(prefix, tag, 'ok')
    json.dump(sources, open(os.path.join(OUT, 'SOURCES.json'), 'w'), indent=1)


if __name__ == '__main__':
    main()
