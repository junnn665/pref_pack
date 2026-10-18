"""Build js/asia.js (アジア大陸ステージ) from Natural Earth 1:50m countries.

Usage:
  curl -LO https://raw.githubusercontent.com/nvkelso/natural-earth-vector/master/geojson/ne_50m_admin_0_countries.geojson
  pip install shapely
  python3 tools/build_asia.py ne_50m_admin_0_countries.geojson js/asia.js

Natural Earth is public domain.
"""
import json, math, sys
from shapely.geometry import shape

src, out = sys.argv[1], sys.argv[2]
data = json.load(open(src, encoding="utf-8"))

# 使う国: 短い表示名, 地域
COUNTRIES = {
    # 東アジア
    "CHN": ("中国", 0), "MNG": ("モンゴル", 0), "KOR": ("韓国", 0), "PRK": ("北朝鮮", 0),
    "JPN": ("日本", 0), "TWN": ("台湾", 0),
    # 東南アジア
    "VNM": ("ベトナム", 1), "LAO": ("ラオス", 1), "KHM": ("カンボジア", 1), "THA": ("タイ", 1),
    "MMR": ("ミャンマー", 1), "MYS": ("マレーシア", 1), "IDN": ("インドネシア", 1), "PHL": ("フィリピン", 1),
    "BRN": ("ブルネイ", 1), "TLS": ("東ティモール", 1),
    # 南アジア
    "IND": ("インド", 2), "PAK": ("パキスタン", 2), "BGD": ("バングラデシュ", 2), "NPL": ("ネパール", 2),
    "BTN": ("ブータン", 2), "LKA": ("スリランカ", 2), "AFG": ("アフガニスタン", 2),
    # 中央アジア
    "KAZ": ("カザフスタン", 3), "UZB": ("ウズベキスタン", 3), "TKM": ("トルクメニスタン", 3),
    "KGZ": ("キルギス", 3), "TJK": ("タジキスタン", 3),
    # 西アジア
    "TUR": ("トルコ", 4), "IRN": ("イラン", 4), "IRQ": ("イラク", 4), "SYR": ("シリア", 4),
    "SAU": ("サウジアラビア", 4), "YEM": ("イエメン", 4), "OMN": ("オマーン", 4), "ARE": ("UAE", 4),
    "QAT": ("カタール", 4), "KWT": ("クウェート", 4), "JOR": ("ヨルダン", 4), "ISR": ("イスラエル", 4),
    "PSX": ("パレスチナ", 4), "LBN": ("レバノン", 4), "GEO": ("ジョージア", 4), "ARM": ("アルメニア", 4),
    "AZE": ("アゼルバイジャン", 4), "CYP": ("キプロス", 4),
}
REGIONS = ["東アジア", "東南アジア", "南アジア", "中央アジア", "西アジア"]
# 海をはさんでつながる組み合わせ
SEA_LINKS = [("JPN", "KOR"), ("TWN", "CHN"), ("TWN", "PHL"), ("PHL", "MYS"), ("PHL", "IDN"),
             ("LKA", "IND"), ("CYP", "TUR"), ("CYP", "SYR"), ("QAT", "ARE"), ("JPN", "CHN")]

LAT0 = 30
KX = math.cos(math.radians(LAT0)) * 111.32
KY = 110.57
proj = lambda lon, lat: (lon * KX, -lat * KY)


def ring_area(r):
    return sum(r[i][0] * r[(i + 1) % len(r)][1] - r[(i + 1) % len(r)][0] * r[i][1] for i in range(len(r))) / 2


def centroid(r):
    a = ring_area(r); cx = cy = 0
    for i in range(len(r)):
        x1, y1 = r[i]; x2, y2 = r[(i + 1) % len(r)]
        f = x1 * y2 - x2 * y1; cx += (x1 + x2) * f; cy += (y1 + y2) * f
    return cx / (6 * a), cy / (6 * a)


def rdp(pts, eps):
    if len(pts) < 3: return pts
    (x1, y1), (x2, y2) = pts[0], pts[-1]
    dx, dy = x2 - x1, y2 - y1; n = math.hypot(dx, dy) or 1e-9
    dmax, idx = 0, 0
    for i in range(1, len(pts) - 1):
        d = abs(dy * pts[i][0] - dx * pts[i][1] + x2 * y1 - y2 * x1) / n
        if d > dmax: dmax, idx = d, i
    if dmax > eps: return rdp(pts[: idx + 1], eps)[:-1] + rdp(pts[idx:], eps)
    return [pts[0], pts[-1]]


def simplify(r, eps):
    far = max(range(len(r)), key=lambda i: (r[i][0] - r[0][0]) ** 2 + (r[i][1] - r[0][1]) ** 2)
    return rdp(r[: far + 1], eps)[:-1] + rdp(r[far:] + [r[0]], eps)[:-1]


def hull(pts):
    pts = sorted(set(pts))
    cr = lambda o, a, b: (a[0] - o[0]) * (b[1] - o[1]) - (a[1] - o[1]) * (b[0] - o[0])
    lo, up = [], []
    for p in pts:
        while len(lo) >= 2 and cr(lo[-2], lo[-1], p) <= 0: lo.pop()
        lo.append(p)
    for p in reversed(pts):
        while len(up) >= 2 and cr(up[-2], up[-1], p) <= 0: up.pop()
        up.append(p)
    return lo[:-1] + up[:-1]


def reduce_hull(h, n):
    h = h[:]
    while len(h) > n:
        bi = min(range(len(h)), key=lambda i: abs((h[i][0] - h[i - 1][0]) * (h[(i + 1) % len(h)][1] - h[i - 1][1]) - (h[(i + 1) % len(h)][0] - h[i - 1][0]) * (h[i][1] - h[i - 1][1])))
        h.pop(bi)
    return h


feats = {f["properties"]["ADM0_A3"]: f for f in data["features"] if f["properties"]["ADM0_A3"] in COUNTRIES}
missing = set(COUNTRIES) - set(feats)
assert not missing, missing

# adjacency from real borders (geometries within ~0.05°)
geoms = {k: shape(f["geometry"]).buffer(0) for k, f in feats.items()}
adj = {k: set() for k in feats}
keys = sorted(feats)
for i, a in enumerate(keys):
    for b in keys[i + 1:]:
        if geoms[a].distance(geoms[b]) < 0.05:
            adj[a].add(b); adj[b].add(a)
for a, b in SEA_LINKS:
    adj[a].add(b); adj[b].add(a)

pieces = []
for k in keys:
    g = feats[k]["geometry"]
    polys = g["coordinates"] if g["type"] == "MultiPolygon" else [g["coordinates"]]
    rings = []
    for poly in polys:
        r = [proj(*p) for p in poly[0]]
        if r[0] == r[-1]: r = r[:-1]
        if ring_area(r) < 0: r = r[::-1]
        rings.append(r)
    rings.sort(key=ring_area, reverse=True)
    big = ring_area(rings[0])
    # 小さい島は落とす（本体の 7% 以上の島は残す。日本は四国まで入る）
    rings = [r for r in rings if ring_area(r) >= big * 0.07][:6]
    pieces.append(dict(key=k, rings=rings))

allpts = [p for pc in pieces for r in pc["rings"] for p in r]
minx = min(p[0] for p in allpts); miny = min(p[1] for p in allpts)
maxx = max(p[0] for p in allpts); maxy = max(p[1] for p in allpts)

idx = {pc["key"]: i + 1 for i, pc in enumerate(pieces)}
result = []
for pc in pieces:
    rings = [[(x - minx, y - miny) for x, y in r] for r in pc["rings"]]
    area = sum(ring_area(r) for r in rings)
    eps = max(2.0, math.sqrt(area) * 0.012)
    polys, hulls = [], []
    for r in rings:
        s = simplify(r, eps)
        if len(s) < 3: continue
        polys.append([c for p in s for c in (round(p[0], 1), round(p[1], 1))])
        h = reduce_hull(hull(r), 14)
        hulls.append([c for p in h for c in (round(p[0], 1), round(p[1], 1))])
    cx, cy = centroid(rings[0])
    short, region = COUNTRIES[pc["key"]]
    result.append(dict(
        id=idx[pc["key"]], key=pc["key"], name=short, short=short, region=region,
        area=round(area, 1), cx=round(cx, 1), cy=round(cy, 1),
        polys=polys, hulls=hulls, adj=sorted(idx[x] for x in adj[pc["key"]]),
    ))

# 全部つながっているか確認
seen, stack = {1}, [1]
by = {r["id"]: r for r in result}
while stack:
    for n in by[stack.pop()]["adj"]:
        if n not in seen: seen.add(n); stack.append(n)
assert len(seen) == len(result), [by[i]["name"] for i in by if i not in seen]

js = "// generated by tools/build_asia.py — do not edit by hand\n// 地図データ: Natural Earth (public domain)\n"
js += "window.ASIA_DATA = " + json.dumps(dict(
    regions=REGIONS,
    regionMembers=[[r["id"] for r in result if r["region"] == i] for i in range(len(REGIONS))],
    extent=[round(maxx - minx, 1), round(maxy - miny, 1)],
    prefs=result,
), ensure_ascii=False, separators=(",", ":")) + ";\n"
open(out, "w", encoding="utf-8").write(js)
print("countries", len(result), "extent", round(maxx - minx), round(maxy - miny), "bytes", len(js))
for r in result:
    print(r["name"], [by[a]["name"] for a in r["adj"]])
