"""Assemble public/assets/models/candidates/concrete/manifest.json from meta/*.json (run after builds)."""
import glob, json, os
here = os.path.dirname(os.path.abspath(__file__))
out = {}
for p in sorted(glob.glob(os.path.join(here, 'meta', '*.json'))):
    out[os.path.basename(p)[:-5]] = json.load(open(p))
dst = os.path.join(here, '..', '..', '..', 'public', 'assets', 'models', 'candidates', 'concrete', 'manifest.json')
json.dump(out, open(dst, 'w'), indent=1)
print(len(out), 'entries')
