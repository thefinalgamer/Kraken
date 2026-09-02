"""
The link preview card. Writes public/og.png.

RUN THIS ONLY TO REGENERATE IT. The PNG is committed, so nothing at build or
request time needs Python. It exists so the card can be rebuilt rather than
being a mystery image nobody can reproduce, same as tools/trophy-frames.py.

    pip install pillow
    python3 tools/og-card.py

WHY IT MATTERS MORE THAN IT LOOKS. Every time somebody pastes the domain into
Discord, Twitch chat or a message, the unfurl IS the pitch, and until now it was
whatever the crawler scraped. A streamer's viewer sees this before they see the
site. 1200x630 is the size every platform crops from.

DELIBERATELY NO NUMBERS ON IT. "70 hunters" would be baked into a file that
never changes, and would be wrong within a month. The counts go in the og
description instead, which the page builds fresh from the database.
"""
from PIL import Image, ImageDraw, ImageFont, ImageFilter
import random

W, H = 1200, 630
DEEP   = (8, 16, 15)
GROUND = (12, 22, 24)
INK    = (230, 239, 236)
SOFT   = (147, 168, 166)
TEAL   = (32, 184, 153)
BRASS  = (216, 171, 62)

FONTS = '/usr/share/fonts/truetype/liberation/'
bold    = lambda s: ImageFont.truetype(FONTS + 'LiberationSans-Bold.ttf', s)
regular = lambda s: ImageFont.truetype(FONTS + 'LiberationSans-Regular.ttf', s)

# ---- ground, with the same deep-water feel as the site -------------------
img = Image.new('RGB', (W, H), GROUND)
d = ImageDraw.Draw(img)
for y in range(H):
    t = y / H
    d.line([(0, y), (W, y)],
           fill=tuple(int(GROUND[i] + (DEEP[i] - GROUND[i]) * t) for i in range(3)))

glow = Image.new('RGB', (W, H), (0, 0, 0))
ImageDraw.Draw(glow).ellipse([-260, -420, 900, 520], fill=(10, 58, 52))
img = Image.blend(img, Image.blend(img, glow, 0.55).filter(ImageFilter.GaussianBlur(120)), 0.9)
d = ImageDraw.Draw(img)

# a few motes, because the site has them and the card should feel like the site
random.seed(7)
for _ in range(46):
    x, y = random.uniform(0, W), random.uniform(0, H)
    r = random.uniform(1.2, 3.4)
    a = random.uniform(0.10, 0.30)
    d.ellipse([x - r, y - r, x + r, y + r],
              fill=tuple(int(GROUND[i] + (INK[i] - GROUND[i]) * a) for i in range(3)))

# ---- the mark ------------------------------------------------------------
mark = Image.open('public/Kraken.png').convert('RGBA').resize((196, 196), Image.LANCZOS)
img.paste(mark, (96, 150), mark)

# ---- the words -----------------------------------------------------------
x = 336
d.text((x, 176), 'Platinum Intel', font=bold(82), fill=INK)
d.text((x, 286), 'PlayStation trophy leaderboard', font=regular(40), fill=SOFT)

d.line([(x + 2, 372), (x + 128, 372)], fill=BRASS, width=4)

d.text((x, 404), 'Scored on how hard your trophies are,', font=regular(30), fill=SOFT)
d.text((x, 446), 'not how many you have.', font=regular(30), fill=SOFT)

d.text((x, 520), 'platinumintel.co.uk', font=bold(31), fill=TEAL)

img.save('public/og.png', optimize=True)
print('public/og.png', img.size)
