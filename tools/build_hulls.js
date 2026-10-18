// 当たり判定を「本当の形」にする:
// 各県・各国の輪郭を少し簡略化してから、凸形のパーツに分解し、hull/hulls として書き戻す。
// （物理エンジンは凸形しか扱えないので、凹んだ形は複数の凸パーツの組み合わせで表す）
//
// 使い方:  npm install poly-decomp@0.3.0
//          node tools/build_hulls.js js/prefs.js js/asia.js
const fs = require("fs");
const decomp = require("poly-decomp");

const TOL = 0.03;         // 簡略化の細かさ（面積の平方根に対する割合）
const MIN_PART = 0.004;   // これより小さい破片（全体面積比）は捨てる

function area(p) {
  let a = 0;
  for (let i = 0; i < p.length; i++) {
    const [x1, y1] = p[i], [x2, y2] = p[(i + 1) % p.length];
    a += x1 * y2 - x2 * y1;
  }
  return a / 2;
}

function rdp(pts, eps) {
  if (pts.length < 3) return pts;
  const [x1, y1] = pts[0], [x2, y2] = pts[pts.length - 1];
  const dx = x2 - x1, dy = y2 - y1, n = Math.hypot(dx, dy) || 1e-9;
  let dmax = 0, idx = 0;
  for (let i = 1; i < pts.length - 1; i++) {
    const d = Math.abs(dy * pts[i][0] - dx * pts[i][1] + x2 * y1 - y2 * x1) / n;
    if (d > dmax) { dmax = d; idx = i; }
  }
  if (dmax > eps) return rdp(pts.slice(0, idx + 1), eps).slice(0, -1).concat(rdp(pts.slice(idx), eps));
  return [pts[0], pts[pts.length - 1]];
}

function simplifyRing(r, eps) {
  let far = 0, best = -1;
  r.forEach((p, i) => { const d = (p[0] - r[0][0]) ** 2 + (p[1] - r[0][1]) ** 2; if (d > best) { best = d; far = i; } });
  const a = rdp(r.slice(0, far + 1), eps);
  const b = rdp(r.slice(far).concat([r[0]]), eps);
  return a.slice(0, -1).concat(b.slice(0, -1));
}

const isConvex = (p) => {
  let sign = 0;
  for (let i = 0; i < p.length; i++) {
    const a = p[i], b = p[(i + 1) % p.length], c = p[(i + 2) % p.length];
    const cr = (b[0] - a[0]) * (c[1] - b[1]) - (b[1] - a[1]) * (c[0] - b[0]);
    if (Math.abs(cr) < 1e-9) continue;
    if (!sign) sign = Math.sign(cr); else if (Math.sign(cr) !== sign) return false;
  }
  return true;
};

// 輪郭の小さな「ねじれ（自己交差）」を、交差した間の点を消してほどく
function untangle(r) {
  const o = (p, q, s) => Math.sign((q[0] - p[0]) * (s[1] - p[1]) - (q[1] - p[1]) * (s[0] - p[0]));
  const cross = (a, b, c, d) => o(a, b, c) !== o(a, b, d) && o(c, d, a) !== o(c, d, b);
  for (let guard = 0; guard < 200; guard++) {
    const n = r.length;
    let hit = null;
    for (let i = 0; i < n && !hit; i++) {
      for (let j = i + 2; j < n; j++) {
        if (i === 0 && j === n - 1) continue;
        if (cross(r[i], r[(i + 1) % n], r[j], r[(j + 1) % n])) { hit = [i, j]; break; }
      }
    }
    if (!hit) return r;
    const [i, j] = hit;
    // 短い方のループを消す
    if (j - i <= n / 2) r.splice(i + 1, j - i);
    else r = r.slice(i + 1, j + 1);
  }
  return r;
}

function decompose(flat, totalArea, name) {
  let orig = [];
  for (let i = 0; i < flat.length; i += 2) orig.push([flat[i], flat[i + 1]]);
  orig = untangle(orig);
  const base = Math.sqrt(Math.abs(area(orig)));
  // 簡略化すると自己交差することがあるので、うまく分解できる細かさを探す
  for (const k of [1, 0.7, 0.5, 1.4, 0.35, 2, 0.25, 0.15]) {
    let ring = simplifyRing(orig, Math.max(0.4, base * TOL * k));
    decomp.removeDuplicatePoints(ring, 0.5);
    if (ring.length < 3) continue;
    decomp.makeCCW(ring);
    decomp.removeCollinearPoints(ring, 0.01);
    if (!decomp.isSimple(ring)) ring = untangle(ring);
    if (ring.length < 3 || !decomp.isSimple(ring)) continue;
    const parts = decomp.quickDecomp(ring);
    if (!parts.length || !parts.every(isConvex)) continue;
    return finish(parts, totalArea);
  }
  console.warn("could not decompose", name, "— using its hull");
  return finish([orig], totalArea);
}

function finish(parts, totalArea) {
  return parts
    .filter((p) => p.length >= 3 && Math.abs(area(p)) >= totalArea * MIN_PART)
    .map((p) => p.flatMap(([x, y]) => [Math.round(x * 10) / 10, Math.round(y * 10) / 10]));
}

for (const file of process.argv.slice(2)) {
  const src = fs.readFileSync(file, "utf8");
  const m = src.match(/^(.*?window\.(\w+) = )(\{.*\});\s*$/s);
  if (!m) throw new Error(`unexpected format: ${file}`);
  const data = JSON.parse(m[3]);
  let totalParts = 0;
  for (const p of data.prefs) {
    const polys = p.polys || [p.poly];
    const hulls = [];
    for (const poly of polys) hulls.push(...decompose(poly, p.area, p.name));
    if (!hulls.length) { console.warn("no parts for", p.name); continue; }
    delete p.hull;
    p.hulls = hulls;
    totalParts += hulls.length;
  }
  fs.writeFileSync(file, m[1] + JSON.stringify(data) + ";\n");
  console.log(file, "pieces", data.prefs.length, "parts", totalParts,
    "max/piece", Math.max(...data.prefs.map((p) => p.hulls.length)));
}
