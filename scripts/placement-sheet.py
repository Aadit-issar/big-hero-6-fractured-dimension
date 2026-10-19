"""Contact sheet of placement captures; with two dirs, a side-by-side before/after sheet.
Usage: python scripts/placement-sheet.py <out.png> <dirA> [dirB] [names comma list]"""
import os
import sys
from PIL import Image, ImageDraw

out, a = sys.argv[1], sys.argv[2]
b = sys.argv[3] if len(sys.argv) > 3 and os.path.isdir(sys.argv[3]) else None
names = sys.argv[4].split(',') if len(sys.argv) > 4 else (sys.argv[3].split(',') if len(sys.argv) > 3 and not b else None)
if not names:
    names = sorted(f[:-4] for f in os.listdir(a) if f.endswith(('.png', '.jpg')) and not f.startswith(('sheet', 'density', 'compare')))
W, H = 640, 360
cols = 2 if b else 4
rows = len(names) if b else (len(names) + cols - 1) // cols
sheet = Image.new('RGB', (cols * W, rows * (H + 22)), (12, 10, 20))
d = ImageDraw.Draw(sheet)
for i, n in enumerate(names):
    for k, folder in enumerate([a, b] if b else [a]):
        p = os.path.join(folder, n + '.jpg')
        if not os.path.exists(p):
            p = os.path.join(folder, n + '.png')
        if not os.path.exists(p):
            continue
        im = Image.open(p).convert('RGB').resize((W, H), Image.LANCZOS)
        c, r = (k, i) if b else (i % cols, i // cols)
        sheet.paste(im, (c * W, r * (H + 22) + 22))
        label = f"{'BEFORE' if k == 0 else 'AFTER'}  {n}" if b else n
        d.text((c * W + 6, r * (H + 22) + 5), label, fill=(230, 230, 230))
sheet.save(out, quality=88) if out.endswith('.jpg') else sheet.save(out)
print(out, sheet.size)
