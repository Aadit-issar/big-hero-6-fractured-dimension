"""Side-by-side comparison sheet: the three reference images against matching stills of the armoured Baymax.
Usage: python scripts/baymax-compare.py [evidence_dir] [reference_dir]"""
import os
import sys
from PIL import Image, ImageDraw

ev = sys.argv[1] if len(sys.argv) > 1 else 'docs/evidence/baymax'
ref = sys.argv[2] if len(sys.argv) > 2 else r'C:\Users\aadit\BigHero6\Design\Baymax Design'
rows = [('2.jpg', 'three-quarter.png', 'reference 2.jpg | three-quarter, wings deployed'),
        ('3.jpg', 'front.png', 'reference 3.jpg | front, wings deployed'),
        ('images.jpg', 'rear-thrusters.png', 'reference images.jpg (rear) | rear in cruise: wings, ports, nozzles')]
H = 560
sheet = Image.new('RGB', (1300, H * len(rows) + 30 * len(rows)), (18, 16, 36))
d = ImageDraw.Draw(sheet)
y = 0
for r, o, label in rows:
    a = Image.open(os.path.join(ref, r)).convert('RGB')
    b = Image.open(os.path.join(ev, o)).convert('RGB')
    a = a.resize((int(a.width * H / a.height), H))
    b = b.resize((int(b.width * H / b.height), H))
    d.text((10, y + 8), label, fill=(200, 190, 255))
    sheet.paste(a, (10, y + 30))
    sheet.paste(b, (1300 - b.width - 10, y + 30))
    y += H + 30
sheet.save(os.path.join(ev, 'compare-with-reference.png'))
print('saved compare-with-reference.png', sheet.size)
