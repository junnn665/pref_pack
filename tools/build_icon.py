"""Generate the home-screen icon (SVG) from js/prefs.js.

Usage: python3 tools/build_icon.py js/prefs.js icons/icon.svg [--maskable]

Design: a wooden box packed with the Japanese archipelago in region colours,
with Hokkaido dropping in from above.
"""
import json, sys, re

src, out = sys.argv[1], sys.argv[2]
maskable = "--maskable" in sys.argv

text = open(src, encoding="utf-8").read()
data = json.loads(re.search(r"window\.PREF_DATA = (\{.*\});", text, re.S).group(1))

COLORS = ["#7fb7e8", "#86cfb0", "#f5ae62", "#a3d06a", "#f29abf", "#b6a3e6", "#f3cd52", "#ef8a7c"]
STROKE = ["#5b84a7", "#60957f", "#b07d46", "#75964c", "#ae6f89", "#8375a5", "#af933b", "#ac6359"]

S = 512
# maskable icons get cropped to a circle-ish safe zone (inner 80%), so shrink the art
k = 0.78 if maskable else 1.0
off = S * (1 - k) / 2

# box geometry (in 512 space before k)
BX0, BX1, BTOP, BBOT, WALL = 40, 472, 196, 474, 24
IN_X0, IN_X1, IN_Y1 = BX0 + WALL, BX1 - WALL, BBOT - WALL

prefs = data["prefs"]
ew, eh = data["extent"]

# Hokkaido drops from above: lift it and fit the rest in the box
body = [p for p in prefs if p["id"] != 1]
hok = next(p for p in prefs if p["id"] == 1)


def bbox(ps):
    xs = [p["poly"][i] for p in ps for i in range(0, len(p["poly"]), 2)]
    ys = [p["poly"][i + 1] for p in ps for i in range(0, len(p["poly"]), 2)]
    return min(xs), min(ys), max(xs), max(ys)


# tilt the archipelago so Kyushu→Aomori runs nearly horizontal and fills the box
import math
ANG = math.radians(16)
ca, sa = math.cos(ANG), math.sin(ANG)
for p in body:
    pts = p["poly"]
    p["poly"] = [v for i in range(0, len(pts), 2)
                 for v in (pts[i] * ca - pts[i + 1] * sa, pts[i] * sa + pts[i + 1] * ca)]

bx0, by0, bx1, by1 = bbox(body)
inner_w = IN_X1 - IN_X0 - 14
inner_h = IN_Y1 - BTOP + 40
sc = min(inner_w / (bx1 - bx0), inner_h / (by1 - by0))
tx = IN_X0 + (IN_X1 - IN_X0 - (bx1 - bx0) * sc) / 2 - bx0 * sc
ty = IN_Y1 - 8 - by1 * sc


def path(p, sx, sy, dx, dy):
    pts = p["poly"]
    d = []
    for i in range(0, len(pts), 2):
        d.append(f"{'M' if i == 0 else 'L'}{pts[i] * sx + dx:.1f} {pts[i + 1] * sy + dy:.1f}")
    return "".join(d) + "Z"


parts = []
for p in body:
    r = p["region"]
    parts.append(f'<path d="{path(p, sc, sc, tx, ty)}" fill="{COLORS[r]}" stroke="#fffaf1" stroke-width="2.6" stroke-linejoin="round"/>')

# Hokkaido: same scale, placed above the box, slightly tilted
hx0, hy0, hx1, hy1 = bbox([hok])
hcx, hcy = (hx0 + hx1) / 2, (hy0 + hy1) / 2
hok_path = path(hok, sc * 0.9, sc * 0.9, -hcx * sc * 0.9, -hcy * sc * 0.9)
hok_svg = (
    f'<g transform="translate(380 108) rotate(20)">'
    f'<path d="{hok_path}" fill="{COLORS[0]}" stroke="#fffaf1" stroke-width="3" stroke-linejoin="round"/></g>'
)

svg = f'''<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 {S} {S}" width="{S}" height="{S}">
<defs>
  <radialGradient id="bg" cx="50%" cy="35%" r="75%">
    <stop offset="0" stop-color="#fff6e3"/>
    <stop offset="1" stop-color="#f1e2c6"/>
  </radialGradient>
  <linearGradient id="wood" x1="0" y1="0" x2="0" y2="1">
    <stop offset="0" stop-color="#d6b47c"/>
    <stop offset="1" stop-color="#b98f55"/>
  </linearGradient>
  <filter id="sh" x="-20%" y="-20%" width="140%" height="140%">
    <feDropShadow dx="0" dy="6" stdDeviation="6" flood-color="#5a4320" flood-opacity=".28"/>
  </filter>
</defs>
<rect width="{S}" height="{S}" fill="url(#bg)"/>
<g transform="translate({off:.1f} {off:.1f}) scale({k})">
  <g filter="url(#sh)">
    <rect x="{BX0}" y="{BTOP}" width="{BX1 - BX0}" height="{BBOT - BTOP}" rx="10" fill="url(#wood)"/>
    <rect x="{IN_X0}" y="{BTOP - 1}" width="{IN_X1 - IN_X0}" height="{IN_Y1 - BTOP + 1}" fill="#fffaf1"/>
  </g>
  <g>{''.join(parts)}</g>
  <rect x="{BX0}" y="{BBOT - 8}" width="{BX1 - BX0}" height="8" rx="4" fill="#9c7a45"/>
  <g filter="url(#sh)">{hok_svg}</g>
  <g stroke="#e0a52a" stroke-width="8" stroke-linecap="round" opacity=".85">
    <line x1="332" y1="12" x2="332" y2="34"/>
    <line x1="372" y1="4" x2="372" y2="26"/>
    <line x1="412" y1="12" x2="412" y2="34"/>
  </g>
</g>
</svg>
'''
open(out, "w", encoding="utf-8").write(svg)
print("wrote", out, len(svg), "bytes")
