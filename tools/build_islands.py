"""Build js/islands.js: おじゃまピース用の「島」(対戦で地方をそろえると相手に送られる)

島は、地図データの中から有名な島の位置にあるポリゴンを取り出して作る。
parent: 日本は県の id、ほかは国のキー。その国が前のステージで完成済み（金色）なら "HOME"。

Usage:
  python3 tools/build_islands.py japan.geojson ne_50m_admin_0_countries.geojson js/asia.js js/world.js js/islands.js
"""
import json, math, re, sys
from shapely.geometry import shape, Point, MultiPolygon

japan_src, ne_src, asia_js, world_js, out = sys.argv[1:6]

ISLANDS = {
    "japan": [  # name, lon, lat, prefecture id
        ("佐渡島", 138.40, 38.05, 15), ("択捉島", 147.90, 44.95, 1), ("国後島", 145.90, 44.10, 1),
        ("利尻島", 141.24, 45.18, 1), ("奥尻島", 139.45, 42.15, 1), ("対馬", 129.32, 34.40, 42),
        ("壱岐", 129.71, 33.79, 42), ("福江島", 128.78, 32.70, 42), ("淡路島", 134.83, 34.38, 28),
        ("小豆島", 134.27, 34.50, 37), ("隠岐", 133.30, 36.25, 32), ("屋久島", 130.53, 30.35, 46),
        ("種子島", 130.98, 30.60, 46), ("奄美大島", 129.40, 28.30, 46), ("宮古島", 125.30, 24.78, 47),
        ("石垣島", 124.17, 24.42, 47), ("西表島", 123.80, 24.33, 47), ("伊豆大島", 139.38, 34.73, 13),
        ("八丈島", 139.79, 33.10, 13), ("天草下島", 130.10, 32.38, 43),
    ],
    "asia": [
        ("海南島", 109.70, 19.20, "CHN"), ("済州島", 126.55, 33.38, "KOR"), ("バリ島", 115.15, -8.40, "IDN"),
        ("セブ島", 123.90, 10.30, "PHL"), ("ソコトラ島", 53.90, 12.50, "YEM"), ("佐渡島", 138.40, 38.05, "JPN"),
        ("ロンボク島", 116.30, -8.60, "IDN"),
    ],
    "europe": [
        ("コルシカ島", 9.10, 42.15, "FRA"), ("ロードス島", 28.00, 36.20, "GRC"), ("マヨルカ島", 2.95, 39.60, "ESP"),
        ("メノルカ島", 4.10, 39.95, "ESP"), ("ゴットランド島", 18.50, 57.50, "SWE"), ("エーランド島", 16.60, 56.70, "SWE"),
        ("サハリン", 142.70, 50.00, "RUS"),
    ],
    "africa": [
        ("ザンジバル島", 39.35, -6.10, "TZA"), ("ペンバ島", 39.75, -5.20, "TZA"), ("マフィア島", 39.70, -7.85, "TZA"),
        ("ジェルバ島", 10.90, 33.80, "TUN"), ("テネリフェ島", -16.60, 28.30, "ESP"), ("ソコトラ島", 53.90, 12.50, "YEM"),
    ],
    "world": [
        ("ハワイ島", -155.50, 19.60, "USA"), ("ニューファンドランド島", -56.00, 48.60, "CAN"),
        ("バンクーバー島", -125.60, 49.65, "CAN"), ("タスマニア島", 146.60, -42.00, "AUS"),
        ("フエゴ島", -68.00, -54.30, "ARG"), ("ロングアイランド", -72.80, 40.85, "USA"),
        ("イサベラ島", -91.10, -0.80, "ECU"),
    ],
}

jp = json.load(open(japan_src, encoding="utf-8"))
jp_geom = {int(f["properties"]["id"]): shape(f["geometry"]).buffer(0) for f in jp["features"]}
ne = json.load(open(ne_src, encoding="utf-8"))
ne_geom = {}
for f in ne["features"]:
    k = f["properties"]["ADM0_A3"]
    g = shape(f["geometry"]).buffer(0)
    ne_geom[k] = g if k not in ne_geom else ne_geom[k].union(g)

asia = json.loads(re.search(r"window\.ASIA_DATA = (\{.*\});", open(asia_js, encoding="utf-8").read(), re.S).group(1))
world = json.loads(re.search(r"window\.WORLD_DATA = (\{.*\});", open(world_js, encoding="utf-8").read(), re.S).group(1))
stage_keys = {"asia": {p["key"] for p in asia["prefs"]}}
for st, d in world.items():
    stage_keys[st] = {p["key"] for p in d["prefs"]}


def polys_of(g):
    return list(g.geoms) if isinstance(g, MultiPolygon) else [g]


def find_poly(geom, lon, lat):
    pt = Point(lon, lat)
    ps = polys_of(geom)
    for p in ps:
        if p.contains(pt):
            return p
    near = sorted(ps, key=lambda p: p.distance(pt))
    if near and near[0].distance(pt) < 0.5:
        return near[0]
    return None


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


def ring_area(r):
    return sum(r[i][0] * r[(i + 1) % len(r)][1] - r[(i + 1) % len(r)][0] * r[i][1] for i in range(len(r))) / 2


def centroid(r):
    a = ring_area(r); cx = cy = 0
    for i in range(len(r)):
        x1, y1 = r[i]; x2, y2 = r[(i + 1) % len(r)]
        f = x1 * y2 - x2 * y1; cx += (x1 + x2) * f; cy += (y1 + y2) * f
    return cx / (6 * a), cy / (6 * a)


result = {}
nid = 1001
for st, items in ISLANDS.items():
    lst = []
    for name, lon, lat, parent in items:
        geom = jp_geom.get(parent) if st == "japan" else ne_geom.get(parent)
        if geom is None:
            print("  ! no geometry for parent", st, name, parent); continue
        poly = find_poly(geom, lon, lat)
        if poly is None:
            print("  ! island not found", st, name); continue
        kx = math.cos(math.radians(lat)) * 111.32
        r = [(x * kx, -y * 110.57) for x, y in poly.exterior.coords]
        if r[0] == r[-1]: r = r[:-1]
        if ring_area(r) < 0: r = r[::-1]
        minx = min(x for x, _ in r); miny = min(y for _, y in r)
        r = [(x - minx, y - miny) for x, y in r]
        area = ring_area(r)
        far = max(range(len(r)), key=lambda i: (r[i][0] - r[0][0]) ** 2 + (r[i][1] - r[0][1]) ** 2)
        eps = max(0.3, math.sqrt(area) * 0.02)
        s = rdp(r[: far + 1], eps)[:-1] + rdp(r[far:] + [r[0]], eps)[:-1]
        cx, cy = centroid(r)
        par = parent
        if st != "japan" and parent not in stage_keys[st]:
            par = "HOME"
        lst.append(dict(id=nid, key=f"ISL{nid}", name=name, short=name, island=True, parent=par,
                        area=round(area, 1), cx=round(cx, 1), cy=round(cy, 1),
                        polys=[[c for p in s for c in (round(p[0], 2), round(p[1], 2))]]))
        nid += 1
        print(f"  {st}: {name} → {par}  {area:,.0f} km²")
    result[st] = dict(prefs=lst)

open(out, "w", encoding="utf-8").write(
    "// generated by tools/build_islands.py — おじゃまピース（島）\n"
    "// 地図データ: 国土数値情報（国土交通省）, Natural Earth (public domain)\n"
    "window.ISLAND_DATA = " + json.dumps(result, ensure_ascii=False, separators=(",", ":")) + ";\n")
