"""Montage hero material shots into the contact sheet: python contact.py <shotdir> <out.png> id1 id2 ..."""
import sys
from PIL import Image, ImageDraw
d, out, *ids = sys.argv[1:]
cols = 4
W, H = 500, 350
rows = (len(ids) + cols - 1) // cols
sheet = Image.new('RGB', (cols * W, rows * H), (30, 32, 36))
dr = ImageDraw.Draw(sheet)
for i, a in enumerate(ids):
    try:
        im = Image.open(f'{d}/{a}.glb-material-hero.png').convert('RGB').resize((W, H))
    except Exception:
        continue
    x, y = (i % cols) * W, (i // cols) * H
    sheet.paste(im, (x, y))
    dr.text((x + 8, y + 6), a, fill=(235, 235, 235))
sheet.save(out)
