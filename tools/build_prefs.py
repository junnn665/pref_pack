"""Convert japan.geojson into a compact prefs.js for the game.

- keeps the largest polygon of each prefecture (drops small/remote islands)
- projects lon/lat to km (equirectangular around 36N)
- simplifies outlines (RDP) and builds a convex hull for physics
- moves Okinawa closer to Kyushu (map inset style)
"""
import json, math, sys

src, out = sys.argv[1], sys.argv[2]
data = json.load(open(src, encoding="utf-8"))

KX = math.cos(math.radians(36)) * 111.32
KY = 110.57


def proj(lon, lat):
    return (lon * KX, -lat * KY)


def area(ring):
    a = 0.0
    for i in range(len(ring)):
        x1, y1 = ring[i]
        x2, y2 = ring[(i + 1) % len(ring)]
        a += x1 * y2 - x2 * y1
    return a / 2


def centroid(ring):
    a = area(ring)
    cx = cy = 0.0
    for i in range(len(ring)):
        x1, y1 = ring[i]
        x2, y2 = ring[(i + 1) % len(ring)]
        f = x1 * y2 - x2 * y1
        cx += (x1 + x2) * f
        cy += (y1 + y2) * f
    return (cx / (6 * a), cy / (6 * a))


def rdp(pts, eps):
    if len(pts) < 3:
        return pts
    (x1, y1), (x2, y2) = pts[0], pts[-1]
    dx, dy = x2 - x1, y2 - y1
    norm = math.hypot(dx, dy) or 1e-9
    dmax, idx = 0, 0
    for i in range(1, len(pts) - 1):
        px, py = pts[i]
        d = abs(dy * px - dx * py + x2 * y1 - y2 * x1) / norm
        if d > dmax:
            dmax, idx = d, i
    if dmax > eps:
        return rdp(pts[: idx + 1], eps)[:-1] + rdp(pts[idx:], eps)
    return [pts[0], pts[-1]]


def simplify_ring(ring, eps):
    # split ring in two halves so RDP works on a closed loop
    n = len(ring)
    far = max(range(n), key=lambda i: (ring[i][0] - ring[0][0]) ** 2 + (ring[i][1] - ring[0][1]) ** 2)
    a = rdp(ring[: far + 1], eps)
    b = rdp(ring[far:] + [ring[0]], eps)
    return a[:-1] + b[:-1]


def hull(pts):
    pts = sorted(set(pts))
    def cross(o, a, b):
        return (a[0] - o[0]) * (b[1] - o[1]) - (a[1] - o[1]) * (b[0] - o[0])
    lo, up = [], []
    for p in pts:
        while len(lo) >= 2 and cross(lo[-2], lo[-1], p) <= 0:
            lo.pop()
        lo.append(p)
    for p in reversed(pts):
        while len(up) >= 2 and cross(up[-2], up[-1], p) <= 0:
            up.pop()
        up.append(p)
    return lo[:-1] + up[:-1]


def dedupe(pts, tol=0.5):
    out = []
    for q in pts:
        if out and math.hypot(out[-1][0] - q[0], out[-1][1] - q[1]) < tol:
            continue
        out.append(q)
    while len(out) > 3 and math.hypot(out[0][0] - out[-1][0], out[0][1] - out[-1][1]) < tol:
        out.pop()
    return out


def reduce_hull(h, maxn):
    h = h[:]
    while len(h) > maxn:
        best, bi = None, 0
        for i in range(len(h)):
            a, b, c = h[i - 1], h[i], h[(i + 1) % len(h)]
            t = abs((b[0] - a[0]) * (c[1] - a[1]) - (c[0] - a[0]) * (b[1] - a[1]))
            if best is None or t < best:
                best, bi = t, i
        h.pop(bi)
    return h


REGIONS = [
    ("北海道", [1]),
    ("東北", list(range(2, 8))),
    ("関東", list(range(8, 15))),
    ("中部", list(range(15, 24))),
    ("近畿", list(range(24, 31))),
    ("中国", list(range(31, 36))),
    ("四国", list(range(36, 40))),
    ("九州・沖縄", list(range(40, 48))),
]
region_of = {pid: ri for ri, (_, ids) in enumerate(REGIONS) for pid in ids}

ADJ = {
    1: [2], 2: [1, 3, 5], 3: [2, 4, 5], 4: [3, 5, 6, 7], 5: [2, 3, 4, 6],
    6: [4, 5, 7, 15], 7: [4, 6, 8, 9, 10, 15], 8: [7, 9, 11, 12],
    9: [7, 8, 10, 11], 10: [7, 9, 11, 15, 20], 11: [8, 9, 10, 12, 13, 19, 20],
    12: [8, 11, 13], 13: [11, 12, 14, 19], 14: [13, 19, 22],
    15: [6, 7, 10, 16, 20], 16: [15, 17, 20, 21], 17: [16, 18, 21],
    18: [17, 21, 25, 26], 19: [11, 13, 14, 20, 22],
    20: [10, 11, 15, 16, 19, 21, 22, 23], 21: [16, 17, 18, 20, 23, 24, 25],
    22: [14, 19, 20, 23], 23: [20, 21, 22, 24], 24: [21, 23, 25, 26, 29, 30],
    25: [18, 21, 24, 26], 26: [18, 24, 25, 27, 28, 29], 27: [26, 28, 29, 30],
    28: [26, 27, 31, 33, 36], 29: [24, 26, 27, 30], 30: [24, 27, 29],
    31: [28, 32, 33, 34], 32: [31, 34, 35], 33: [28, 31, 34, 37],
    34: [31, 32, 33, 35, 38], 35: [32, 34, 40], 36: [28, 37, 38, 39],
    37: [33, 36, 38], 38: [34, 36, 37, 39], 39: [36, 38], 40: [35, 41, 43, 44],
    41: [40, 42], 42: [41], 43: [40, 44, 45, 46], 44: [40, 43, 45],
    45: [43, 44, 46], 46: [43, 45, 47], 47: [46],
}
# make symmetric
for a, bs in list(ADJ.items()):
    for b in bs:
        if a not in ADJ[b]:
            ADJ[b].append(a)

prefs = {}
for f in data["features"]:
    pid = int(f["properties"]["id"])
    name = f["properties"]["nam_ja"]
    g = f["geometry"]
    polys = g["coordinates"] if g["type"] == "MultiPolygon" else [g["coordinates"]]
    rings = [[proj(*p) for p in poly[0]] for poly in polys]
    ring = max(rings, key=lambda r: abs(area(r)))
    if ring[0] == ring[-1]:
        ring = ring[:-1]
    if area(ring) < 0:
        ring = ring[::-1]
    prefs[pid] = dict(name=name, ring=ring)

# move Okinawa next to Kagoshima (inset)
ok, kg = prefs[47], prefs[46]
ocx, ocy = centroid(ok["ring"])
kcx, kcy = centroid(kg["ring"])
tx, ty = kcx - 150 - ocx, kcy + 130 - ocy
ok["ring"] = [(x + tx, y + ty) for x, y in ok["ring"]]

# normalise coordinates so Japan's bbox starts at 0,0
allpts = [p for v in prefs.values() for p in v["ring"]]
minx = min(p[0] for p in allpts)
miny = min(p[1] for p in allpts)

result = []
for pid in sorted(prefs):
    v = prefs[pid]
    ring = [(x - minx, y - miny) for x, y in v["ring"]]
    a = abs(area(ring))
    eps = max(0.6, math.sqrt(a) * 0.012)
    simp = simplify_ring(ring, eps)
    h = dedupe(reduce_hull(dedupe(hull(ring)), 18))
    cx, cy = centroid(ring)
    name = v["name"]
    short = name if name == "北海道" else name[:-1]
    result.append(dict(
        id=pid, name=name, short=short, region=region_of[pid],
        area=round(a, 1), cx=round(cx, 1), cy=round(cy, 1),
        poly=[c for p in simp for c in (round(p[0], 1), round(p[1], 1))],
        hull=[c for p in h for c in (round(p[0], 1), round(p[1], 1))],
        adj=sorted(ADJ[pid]),
    ))

maxx = max(p[0] for p in allpts) - minx
maxy = max(p[1] for p in allpts) - miny
js = "// generated by tools/build_prefs.py — do not edit by hand\n"
js += "// 地図データ: 国土数値情報（行政区域データ）国土交通省 を加工 (via dataofjapan/land)\n"
js += "window.PREF_DATA = " + json.dumps(dict(
    regions=[r[0] for r in REGIONS],
    regionMembers=[r[1] for r in REGIONS],
    extent=[round(maxx, 1), round(maxy, 1)],
    prefs=result,
), ensure_ascii=False, separators=(",", ":")) + ";\n"
open(out, "w", encoding="utf-8").write(js)
print("prefs", len(result), "extent", round(maxx), round(maxy), "bytes", len(js))
print("poly pts", sum(len(r["poly"]) // 2 for r in result))
