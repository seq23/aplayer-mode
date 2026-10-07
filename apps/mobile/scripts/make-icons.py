"""Draws the A Player Mode app icons (store, adaptive, web/PWA) from the brand tokens.
Run: python3 apps/mobile/scripts/make-icons.py  (Pillow). Output is committed."""
from pathlib import Path
from PIL import Image, ImageDraw, ImageFont

ROOT = Path(__file__).resolve().parent.parent
FONT = next((ROOT.parent.parent / 'node_modules/@expo-google-fonts/outfit').rglob('Outfit_700Bold.ttf'))
INK, STONE, BRASS, MOSS = '#1E1C19', '#E9E5DE', '#A39780', '#3E4B3C'

def mark(size, bg, fg, scale=1.0, rule=True):
    img = Image.new('RGBA', (size, size), bg)
    d = ImageDraw.Draw(img)
    font = ImageFont.truetype(str(FONT), int(size * 0.33 * scale))
    text = 'APM'
    box = d.textbbox((0, 0), text, font=font)
    w, h = box[2] - box[0], box[3] - box[1]
    x, y = (size - w) / 2 - box[0], (size - h) / 2 - box[1] - size * 0.03 * scale
    d.text((x, y), text, font=font, fill=fg)
    if rule:
        rw, rh = size * 0.34 * scale, max(2, size * 0.022 * scale)
        ry = y + box[3] + size * 0.06 * scale
        d.rectangle([(size - rw) / 2, ry, (size + rw) / 2, ry + rh], fill=BRASS)
    return img

def save(img, path):
    path.parent.mkdir(parents=True, exist_ok=True)
    img.save(path, optimize=True)

save(mark(1024, INK, STONE).convert('RGB'), ROOT / 'assets/icon.png')
save(mark(1024, (0, 0, 0, 0), STONE, scale=0.62), ROOT / 'assets/adaptive-icon.png')
for size in (192, 512):
    save(mark(size, INK, STONE).convert('RGB'), ROOT / f'public/icons/icon-{size}.png')
    save(mark(size, INK, STONE, scale=0.72).convert('RGB'), ROOT / f'public/icons/maskable-{size}.png')
save(mark(180, INK, STONE).convert('RGB'), ROOT / 'public/icons/apple-touch-icon.png')
save(mark(48, INK, STONE, rule=False).convert('RGB'), ROOT / 'public/favicon.png')
print('icons written')
