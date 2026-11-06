"""Draws the A Player Mode icons (store, adaptive, web/PWA, favicon) from the brand tokens.
The mark (design system approved 6 Nov 2026, https://claude.ai/artifact/QewMGNAFFtkKtdLokLmdSd):
an Ink square, an Outfit 700 "A" in Paper and, under it, a brass rule cut into five bars, one per
role. Under 40 px the five bars become one. The store icons are full-bleed squares (the stores
round the corners); the web icons carry the 22 % corner themselves.
Run: python3 apps/mobile/scripts/make-icons.py [extra_dir]  (Pillow). Output is committed.
With extra_dir, the site icons (favicon-16/32, apple-touch-icon, icon-512, logo-mark-1024) are
also written there, for aplayermode.com."""
import sys
from pathlib import Path
from PIL import Image, ImageDraw, ImageFont

ROOT = Path(__file__).resolve().parent.parent
FONT = next((ROOT.parent.parent / 'node_modules/@expo-google-fonts/outfit').rglob('Outfit_700Bold.ttf'))
INK, PAPER, BRASS = '#1E1C19', '#F6F4F0', '#A39780'
SS = 4  # supersampling, so small sizes stay crisp


def mark(size, bg=INK, fg=PAPER, scale=1.0, corner=0.0, bars=None):
    """scale shrinks the glyph and bars inside the canvas (safe zone for adaptive/maskable)."""
    S = size * SS
    img = Image.new('RGBA', (S, S), (0, 0, 0, 0))
    d = ImageDraw.Draw(img)
    if bg is not None:
        if corner:
            d.rounded_rectangle([0, 0, S - 1, S - 1], radius=int(S * corner), fill=bg)
        else:
            d.rectangle([0, 0, S, S], fill=bg)
    m = S * scale                      # the mark's own box, centred
    off = (S - m) / 2
    font = ImageFont.truetype(str(FONT), int(m * 0.52))
    box = d.textbbox((0, 0), 'A', font=font)
    w, h = box[2] - box[0], box[3] - box[1]
    x = off + (m - w) / 2 - box[0]
    y = off + (m - m * 0.14 - h) / 2 - box[1]
    d.text((x, y), 'A', font=font, fill=fg)
    n = bars if bars is not None else (5 if size * scale >= 40 else 1)
    left, right = off + m * 0.22, off + m * 0.78
    bh = max(SS, m * 0.035)
    by = off + m * (1 - 0.19) - bh
    if n == 1:
        d.rectangle([left, by, right, by + bh], fill=BRASS)
    else:
        span = right - left
        bw, gap = span * 0.14, span * 0.075
        for i in range(5):
            bx = left + i * (bw + gap)
            d.rectangle([bx, by, bx + bw, by + bh], fill=BRASS)
    return img.resize((size, size), Image.LANCZOS)


def save(img, path, rgb=False):
    path.parent.mkdir(parents=True, exist_ok=True)
    (img.convert('RGB') if rgb else img).save(path, optimize=True)


# The app (Expo): store icon full-bleed, no transparency; adaptive foreground inside the 66 % safe zone.
save(mark(1024), ROOT / 'assets/icon.png', rgb=True)
save(mark(1024, bg=None, scale=0.62), ROOT / 'assets/adaptive-icon.png')
for size in (192, 512):
    save(mark(size, corner=0.22), ROOT / f'public/icons/icon-{size}.png')
    save(mark(size, scale=0.8), ROOT / f'public/icons/maskable-{size}.png', rgb=True)
save(mark(180), ROOT / 'public/icons/apple-touch-icon.png', rgb=True)
save(mark(48, corner=0.22), ROOT / 'public/favicon.png')

if len(sys.argv) > 1:
    out = Path(sys.argv[1])
    save(mark(1024), out / 'logo-mark-1024.png', rgb=True)
    save(mark(512, corner=0.22), out / 'icon-512.png')
    save(mark(180), out / 'apple-touch-icon.png', rgb=True)
    save(mark(32, corner=0.22), out / 'favicon-32.png')
    save(mark(16, corner=0.22), out / 'favicon-16.png')
print('icons written')
