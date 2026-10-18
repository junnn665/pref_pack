"""Build js/world.js: ヨーロッパ / アフリカ / 世界 ステージ（Natural Earth 1:50m, public domain）
and js/capitals.js (各国の首都・日本語名).

Each stage has a gold "HOME" piece = everything finished in the previous stages:
  europe: HOME = アジア（asia.js の国々）           + ヨーロッパの国
  africa: HOME = ユーラシア（アジア＋ヨーロッパ）   + アフリカの国
  world : HOME = ユーラシア＋アフリカ               + 南北アメリカ・オセアニアの国

Usage:
  python3 tools/build_world.py ne_50m_admin_0_countries.geojson ne_50m_populated_places.geojson js/asia.js js/world.js js/capitals.js
"""
import json, math, re, sys
from shapely.geometry import shape, Polygon, MultiPolygon
from shapely.ops import unary_union

src, places_src, asia_js, out, cap_out = sys.argv[1:6]
data = json.load(open(src, encoding="utf-8"))
asia = json.loads(re.search(r"window\.ASIA_DATA = (\{.*\});", open(asia_js, encoding="utf-8").read(), re.S).group(1))
ASIA_KEYS = [p["key"] for p in asia["prefs"]]

TYPES = {"Sovereign country", "Country", "Disputed", "Indeterminate"}
EXCLUDE = {"JEY", "GGY", "IMN", "ALD", "FLK", "VAT", "SMR", "MCO", "LIE", "AND", "MLT"}
MERGE = {"SOL": "SOM"}  # ソマリランドはソマリアに含める
SHORT = {
    "アメリカ合衆国": "アメリカ", "南アフリカ共和国": "南アフリカ", "マリ共和国": "マリ", "コソボ共和国": "コソボ",
    "ボスニア・ヘルツェゴビナ": "ボスニア", "コンゴ民主共和国": "コンゴ民主", "コンゴ共和国": "コンゴ",
    "中央アフリカ共和国": "中央アフリカ", "トリニダード・トバゴ": "トリニダード", "ドミニカ共和国": "ドミニカ",
    "パプアニューギニア": "パプア", "サントメ・プリンシペ": "サントメ", "ギニアビサウ": "ギニアビサウ",
    "ニュージーランド": "ニュージーランド", "グリーンランド": "グリーンランド",
}
MIN_AREA = 4000  # km²（これより小さい国は入れない）

STAGES = {
    "europe": dict(continents={"Europe"}, home_from=["asia"], home_name="アジア", lat0=50, lon_wrap=None,
                   regions=[("Northern Europe", "北ヨーロッパ"), ("Western Europe", "西ヨーロッパ"),
                            ("Southern Europe", "南ヨーロッパ"), ("Eastern Europe", "東ヨーロッパ")]),
    "africa": dict(continents={"Africa"}, home_from=["asia", "europe"], home_name="ユーラシア", lat0=20, lon_wrap=None,
                   regions=[("Northern Africa", "北アフリカ"), ("Western Africa", "西アフリカ"),
                            ("Middle Africa", "中部アフリカ"), ("Eastern Africa", "東アフリカ"),
                            ("Southern Africa", "南部アフリカ")]),
    "world": dict(continents={"North America", "South America", "Oceania"}, home_from=["asia", "europe", "africa"],
                  home_name="ユーラシア・アフリカ", lat0=25, lon_wrap=None,
                  regions=[("Northern America", "北アメリカ"), ("Central America", "中央アメリカ"),
                           ("Caribbean", "カリブ海"), ("South America", "南アメリカ"),
                           ("Australia and New Zealand", "オセアニア"), ("Melanesia", "オセアニア"),
                           ("Polynesia", "オセアニア"), ("Micronesia", "オセアニア")]),
}
# 海をはさんでつながる組み合わせ（HOME = これまでのステージ）
SEA_LINKS = {
    "europe": [("GBR", "FRA"), ("ISL", "NOR"), ("GRC", "HOME"), ("BGR", "HOME"), ("UKR", "HOME")],
    "africa": [("MAR", "HOME"), ("TUN", "HOME"), ("DJI", "HOME"), ("ERI", "HOME"), ("EGY", "HOME"), ("MDG", "MOZ")],
    "world": [("USA", "HOME"), ("NZL", "AUS"), ("AUS", "HOME"), ("PNG", "HOME"), ("GRL", "HOME")],
}

feats = {}
for f in data["features"]:
    pr = f["properties"]
    k = pr["ADM0_A3"]
    if pr["TYPE"] not in TYPES or k in EXCLUDE:
        continue
    k = MERGE.get(k, k)
    g = shape(f["geometry"]).buffer(0)
    if k in feats:
        feats[k]["geom"] = unary_union([feats[k]["geom"], g])
    else:
        feats[k] = dict(key=k, name=pr["NAME_JA"], continent=pr["CONTINENT"], sub=pr["SUBREGION"], geom=g)


def polys_of(g):
    return list(g.geoms) if isinstance(g, MultiPolygon) else [g]


def km_area(poly, lat0):
    kx = math.cos(math.radians(lat0)) * 111.32
    return abs(poly.area) * kx * 110.57


members_by_stage = {"asia": [k for k in ASIA_KEYS if k in feats]}
for st, cfg in STAGES.items():
    ks = []
    for k, f in feats.items():
        if f["continent"] not in cfg["continents"]:
            continue
        # 面積の小さい国は入れない
        if sum(km_area(p, abs(p.centroid.y)) for p in polys_of(f["geom"])) < MIN_AREA:
            continue
        ks.append(k)
    members_by_stage[st] = sorted(ks)


def main_polys(g, lat0):
    """keep the big polygons that are near the main one (drop far-away overseas parts and tiny islands)"""
    ps = sorted(polys_of(g), key=lambda p: p.area, reverse=True)
    big = ps[0]
    total = sum(p.area for p in ps)
    reach = 2.6 * math.sqrt(total)  # degrees-ish
    keep = []
    for p in ps:
        if p.area < big.area * 0.07:
            continue
        if p is not big and p.centroid.distance(big.centroid) > max(reach, 8):
            continue
        keep.append(p)
    return keep[:6]


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


def build_stage(st, cfg):
    lat0 = cfg["lat0"]
    KX = math.cos(math.radians(lat0)) * 111.32
    KY = 110.57
    proj = lambda x, y: (x * KX, -y * KY)
    keys = members_by_stage[st]
    home_keys = [k for s in cfg["home_from"] for k in members_by_stage[s]]

    # HOME = これまでのステージの国をまとめた形（少し簡略化）
    home_geom = unary_union([feats[k]["geom"] for k in home_keys]).simplify(0.25)
    hp = sorted(polys_of(home_geom), key=lambda p: p.area, reverse=True)
    home_polys = [Polygon(p.exterior) for p in hp if p.area >= hp[0].area * 0.004][:14]

    regions = []
    region_idx = {}
    for sub, name in cfg["regions"]:
        if name not in region_idx:
            region_idx[name] = len(regions) + 1  # 0 is HOME
            regions.append(name)
    regions = [cfg["home_name"]] + regions

    # HOME の隣接判定には、各国の本土（遠い海外領土を除いた形）だけを使う
    home_full = unary_union([pp for k in home_keys for pp in main_polys(feats[k]["geom"], lat0)])
    pieces = [dict(key="HOME", name=cfg["home_name"], region=0, polys=home_polys, full=home_full)]
    for k in keys:
        f = feats[k]
        sub_name = dict(cfg["regions"]).get(f["sub"])
        if sub_name is None:
            print("  ! no region for", k, f["sub"]); continue
        mp = main_polys(f["geom"], lat0)
        pieces.append(dict(key=k, name=f["name"], region=region_idx[sub_name], polys=mp, full=unary_union(mp)))

    # adjacency: land borders + short sea crossings, then join any separate groups by the closest pair
    n = len(pieces)
    adj = [set() for _ in range(n)]
    dist = {}
    for i in range(n):
        for j in range(i + 1, n):
            d = pieces[i]["full"].distance(pieces[j]["full"])
            dist[(i, j)] = d
            if d < 0.5:  # 国境 or 海峡（50km くらいまで）
                adj[i].add(j); adj[j].add(i)
    kidx = {pc["key"]: i for i, pc in enumerate(pieces)}
    for a, b in SEA_LINKS.get(st, []):
        if a in kidx and b in kidx:
            adj[kidx[a]].add(kidx[b]); adj[kidx[b]].add(kidx[a])
    for i in range(n):  # 島国は 4° 以内の近い国とつなぐ
        if not adj[i]:
            near = sorted((dist[(min(i, j), max(i, j))], j) for j in range(n) if j != i)
            for d, j in near[:3]:
                if d < 4:
                    adj[i].add(j); adj[j].add(i)

    def comps():
        seen, out = set(), []
        for s in range(n):
            if s in seen: continue
            c, stack = {s}, [s]
            while stack:
                for t in adj[stack.pop()]:
                    if t not in c: c.add(t); stack.append(t)
            seen |= c; out.append(c)
        return out
    cs = comps()
    while len(cs) > 1:
        best = None
        for a in range(len(cs)):
            for b in range(a + 1, len(cs)):
                for i in cs[a]:
                    for j in cs[b]:
                        d = dist[(min(i, j), max(i, j))]
                        if best is None or d < best[0]: best = (d, i, j)
        _, i, j = best
        adj[i].add(j); adj[j].add(i)
        print(f"  link {pieces[i]['name']} - {pieces[j]['name']} ({best[0]:.1f}°)")
        cs = comps()

    # project + simplify
    rings_all = []
    for pc in pieces:
        rings = []
        for p in pc["polys"]:
            r = [proj(x, y) for x, y in p.exterior.coords]
            if r[0] == r[-1]: r = r[:-1]
            if ring_area(r) < 0: r = r[::-1]
            rings.append(r)
        pc["rings"] = rings
        rings_all += rings
    minx = min(x for r in rings_all for x, _ in r); miny = min(y for r in rings_all for _, y in r)
    maxx = max(x for r in rings_all for x, _ in r); maxy = max(y for r in rings_all for _, y in r)

    result = []
    for i, pc in enumerate(pieces):
        rings = [[(x - minx, y - miny) for x, y in r] for r in pc["rings"]]
        area = sum(ring_area(r) for r in rings)
        eps = max(2.0, math.sqrt(area) * (0.006 if pc["key"] == "HOME" else 0.012))
        polys = []
        for r in rings:
            s = simplify(r, eps)
            if len(s) >= 3:
                polys.append([c for p in s for c in (round(p[0], 1), round(p[1], 1))])
        big = max(rings, key=ring_area)
        cx, cy = centroid(big)
        name = pc["name"]
        result.append(dict(id=i + 1, key=pc["key"], name=name, short=SHORT.get(name, name), region=pc["region"],
                           area=round(area, 1), cx=round(cx, 1), cy=round(cy, 1), polys=polys,
                           hulls=polys, adj=sorted(j + 1 for j in adj[i])))
    return dict(regions=regions, regionMembers=[[r["id"] for r in result if r["region"] == ri] for ri in range(len(regions))],
                extent=[round(maxx - minx, 1), round(maxy - miny, 1)], prefs=result)


world = {}
for st, cfg in STAGES.items():
    print("==", st, len(members_by_stage[st]), "countries")
    world[st] = build_stage(st, cfg)
    for r in world[st]["prefs"]:
        print("   ", r["short"], "→", [world[st]["prefs"][a - 1]["short"] for a in r["adj"]])

open(out, "w", encoding="utf-8").write(
    "// generated by tools/build_world.py — do not edit by hand\n// 地図データ: Natural Earth (public domain)\n"
    "window.WORLD_DATA = " + json.dumps(world, ensure_ascii=False, separators=(",", ":")) + ";\n")

# capitals (Japanese names)
places = json.load(open(places_src, encoding="utf-8"))
caps = {}
for f in places["features"]:
    p = f["properties"]
    if p.get("ADM0CAP") != 1 or not p.get("NAME_JA"):
        continue
    k = p["ADM0_A3"]
    primary = p.get("FEATURECLA") == "Admin-0 capital"
    if k not in caps or (primary and not caps[k][1]):
        caps[k] = (p["NAME_JA"], primary)
need = set(ASIA_KEYS) | {k for st in STAGES for k in members_by_stage[st]}
capitals = {k: caps[k][0] for k in sorted(need) if k in caps}
print("capitals", len(capitals), "/", len(need), "missing:", sorted(need - set(capitals)))
open(cap_out, "w", encoding="utf-8").write(
    "// generated by tools/build_world.py — 首都（Natural Earth populated places の日本語名）\n"
    "window.CAPITALS = " + json.dumps(capitals, ensure_ascii=False, separators=(",", ":")) + ";\n")
