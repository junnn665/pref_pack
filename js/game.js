/* 都道府県ゲーム（中濱Games）
 * 都道府県を箱に落として詰める。地図で隣り合う県がふれるとくっつく。
 * 日本列島が完成したら、そのままアジア大陸へ。アジア大陸まで完成させたら全クリア。
 */
(() => {
  "use strict";

  const { Engine, Bodies, Body, Composite, Events, Vertices } = Matter;

  // ---------- constants ----------
  const W = 400;            // logical canvas size
  const H = 680;
  const WALL = 12;
  const BOX_L = WALL;
  const BOX_R = W - WALL;
  const FLOOR = H - WALL;
  const HANG_Y = 74;        // where the current piece hangs
  const DROP_COOLDOWN = 450;
  const SHUFFLE_COOLDOWN = 1200;
  const LAP_LINE = 18;      // 周回ごとにあふれ線が下がる量
  const LINE_DROP = 70;     // 対戦のおじゃま
  const FONT = '"M PLUS Rounded 1c", sans-serif';

  // ゲームモード
  //  exp:       合体時の縮み具合（大きいほど 1 ピースが小さく、詰めやすい）
  //  lineY:     あふれラインの高さ（小さいほど上＝余裕が増える）
  //  overLimit: ラインを超えてからゲームオーバーまでの猶予(ms)
  //  neighbor:  次のピースを「箱にあるもののおとなり」にする確率
  //  hint:      今落とすピースとくっつけるかたまりを光らせる
  const MODES = {
    normal: { name: "ふつう", exp: 0.232, lineY: 150, overLimit: 2200, neighbor: 0, hint: false },
    easy:   { name: "かんたん", exp: 0.257, lineY: 142, overLimit: 3000, neighbor: 0.4, hint: true },
  };
  let mode = "normal";
  let LINE_Y = MODES.normal.lineY;
  let EXP = MODES.normal.exp;
  let OVER_LIMIT = MODES.normal.overLimit;

  // ---------- stages ----------
  function buildStage(data, colors, info) {
    const pieces = {};
    let total = 0;
    for (const p of data.prefs) {
      const polys = p.polys || [p.poly];
      const hulls = p.hulls || [p.hull];
      const path = new Path2D();
      let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
      for (const poly of polys) {
        for (let i = 0; i < poly.length; i += 2) {
          const x = poly[i], y = poly[i + 1];
          if (i === 0) path.moveTo(x, y); else path.lineTo(x, y);
          minX = Math.min(minX, x); maxX = Math.max(maxX, x);
          minY = Math.min(minY, y); maxY = Math.max(maxY, y);
        }
        path.closePath();
      }
      // 当たり判定の形。ほぼ同じ点が続くと物理エンジンが壊れて床をすり抜けるので取り除く
      const hullPts = hulls.map((h) => {
        const pts = [];
        for (let i = 0; i < h.length; i += 2) {
          const q = { x: h[i], y: h[i + 1] };
          const prev = pts[pts.length - 1];
          if (prev && Math.hypot(prev.x - q.x, prev.y - q.y) < 0.5) continue;
          pts.push(q);
        }
        while (pts.length > 3 && Math.hypot(pts[0].x - pts[pts.length - 1].x, pts[0].y - pts[pts.length - 1].y) < 0.5) pts.pop();
        return pts;
      }).filter((h) => h.length >= 3);
      pieces[p.id] = {
        ...p, path, hullPts, adjSet: new Set(p.adj),
        color: colors[p.region], stroke: shade(colors[p.region], -0.28),
        bbox: { minX, minY, maxX, maxY },
      };
      total += p.area;
    }
    const [ew, eh] = data.extent;
    return {
      ...info,
      pieces,
      ids: Object.keys(pieces).map(Number),
      total, ew, eh,
      sTotal: Math.min((BOX_R - BOX_L - 30) / ew, (FLOOR - 150 - 40) / eh),
      regions: data.regions,
      regionMembers: data.regionMembers,
      colors,
      strokes: colors.map((c) => shade(c, -0.28)),
    };
  }

  const STAGES = {
    japan: buildStage(window.PREF_DATA, [
      "#7fb7e8", // 北海道
      "#86cfb0", // 東北
      "#f5ae62", // 関東
      "#a3d06a", // 中部
      "#f29abf", // 近畿
      "#b6a3e6", // 中国
      "#f3cd52", // 四国
      "#ef8a7c", // 九州・沖縄
    ], { key: "japan", name: "日本", finalName: "日本列島", regionName: (r) => `${r}地方`, skipRegions: [0], clearBonus: 3000, par: 240, finalTime: 60 }),
    asia: buildStage(window.ASIA_DATA, [
      "#ef8a7c", // 東アジア
      "#86cfb0", // 東南アジア
      "#f5ae62", // 南アジア
      "#7fb7e8", // 中央アジア
      "#b6a3e6", // 西アジア
    ], { key: "asia", name: "アジア", finalName: "アジア大陸", regionName: (r) => r, skipRegions: [], clearBonus: 6000, par: 300, expAdd: 0.025, finalTime: 90 }),
  };
  let ST = STAGES.japan;

  function scaleFor(area, st = ST, exp = EXP) {
    return st.sTotal * Math.pow(area / st.total, exp - 0.5);
  }

  // ---------- DOM ----------
  const $ = (id) => document.getElementById(id);
  const canvas = $("game");
  const ctx = canvas.getContext("2d");
  const nextCanvas = $("nextCanvas");
  const nctx = nextCanvas.getContext("2d");
  const ui = {
    score: $("score"), remain: $("remain"), nextName: $("nextName"), stageTag: $("stageTag"),
    shuffleBtn: $("shuffleBtn"), toast: $("toast"),
    start: $("startScreen"), menu: $("menuScreen"), result: $("resultScreen"),
    bestNormal: $("bestNormal"), bestEasy: $("bestEasy"),
    resultTitle: $("resultTitle"), resultSub: $("resultSub"), resultScore: $("resultScore"),
    resultRegions: $("resultRegions"), resultBreakdown: $("resultBreakdown"), newBest: $("newBest"),
  };

  // ---------- storage ----------
  const store = {
    get(k, d) { try { const v = localStorage.getItem(k); return v == null ? d : JSON.parse(v); } catch { return d; } },
    set(k, v) { try { localStorage.setItem(k, JSON.stringify(v)); } catch { /* ignore */ } },
  };

  // ---------- state ----------
  let engine, world;
  let groups = [];
  let queue = [];
  let current = null;
  let aimX = W / 2;
  let canDropAt = 0;
  let score = 0;
  let parts = null;          // スコアの内訳
  const best = { normal: store.get("prefpack.best.normal", store.get("prefpack.best", 0)), easy: store.get("prefpack.best.easy", 0) };
  let shuffleReadyAt = 0;
  let shufflesUsed = 0;
  let regionsDone = new Set();
  let running = false;
  let paused = false;
  let ended = false;
  let overTimer = 0;
  let combo = 0;
  let comboTimer = 0;
  let particles = [];
  let fx = [];
  let now = 0;
  let completeAt = 0;
  let finalStart = 0;        // 最後のピースを落とした時刻（ここから制限時間スタート）
  let timeUp = false;
  const finalLeft = () => (finalStart ? ST.finalTime * 1000 - (now - finalStart) : Infinity);
  let stageStart = 0;
  let lap = 1;
  let cleared = [];          // 完成させたステージ ["日本列島", "アジア大陸", ...]
  let rand = Math.random;    // seeded in multiplayer so everyone gets the same order
  let hooks = null;          // multiplayer callbacks (null = solo)
  let lineDownUntil = 0;
  let shake = 0;
  let gameId = 0;           // 古いタイマー（前のゲームの結果表示など）を無効にするため
  const later = (fn, ms) => { const id = gameId; setTimeout(() => { if (id === gameId) fn(); }, ms); };
  const curLine = () => LINE_Y + (now < lineDownUntil ? LINE_DROP : 0);

  function seeded(str) {
    let h = 1779033703 ^ str.length;
    for (let i = 0; i < str.length; i++) { h = Math.imul(h ^ str.charCodeAt(i), 3432918353); h = (h << 13) | (h >>> 19); }
    let a = h >>> 0;
    return () => { a |= 0; a = (a + 0x6d2b79f5) | 0; let t = Math.imul(a ^ (a >>> 15), 1 | a); t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t; return ((t ^ (t >>> 14)) >>> 0) / 4294967296; };
  }

  showBest();
  function showBest() { ui.bestNormal.textContent = best.normal; ui.bestEasy.textContent = best.easy; }

  // ---------- groups ----------
  function makeGroupGeom(members, st = ST, exp = EXP) {
    let area = 0, ox = 0, oy = 0;
    for (const id of members) {
      const p = st.pieces[id];
      area += p.area; ox += p.cx * p.area; oy += p.cy * p.area;
    }
    ox /= area; oy /= area;
    return { area, ox, oy, s: scaleFor(area, st, exp) };
  }

  function createGroupBody(members, x, y) {
    const geom = makeGroupGeom(members);
    const bodyParts = [];
    for (const id of members) {
      for (const hull of ST.pieces[id].hullPts) {
        const verts = hull.map((v) => ({ x: x + (v.x - geom.ox) * geom.s, y: y + (v.y - geom.oy) * geom.s }));
        const c = Vertices.centre(verts);
        bodyParts.push(Bodies.fromVertices(c.x, c.y, [verts], {}, false));
      }
    }
    const body = Body.create({
      parts: bodyParts, friction: 0.35, frictionStatic: 0.6, restitution: 0.08, frictionAir: 0.012, density: 0.0012,
    });
    const g = {
      body, members: new Set(members), geom,
      local: { x: body.position.x - x, y: body.position.y - y },
      born: now, droppedAt: now, flash: 0, glowUntil: 0, glowColor: null,
      gold: members.length === ST.ids.length,
    };
    body.plugin.group = g;
    return g;
  }

  function groupBoundsAt(members) {
    const geom = makeGroupGeom(members);
    let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
    for (const id of members) {
      for (const hull of ST.pieces[id].hullPts) {
        for (const v of hull) {
          const px = (v.x - geom.ox) * geom.s, py = (v.y - geom.oy) * geom.s;
          minX = Math.min(minX, px); maxX = Math.max(maxX, px);
          minY = Math.min(minY, py); maxY = Math.max(maxY, py);
        }
      }
    }
    return { minX, minY, maxX, maxY, geom };
  }

  function keepInside(body) {
    const b = body.bounds;
    let dx = 0, dy = 0;
    if (b.min.x < BOX_L + 1) dx = BOX_L + 1 - b.min.x;
    if (b.max.x > BOX_R - 1) dx = BOX_R - 1 - b.max.x;
    if (b.max.y > FLOOR - 1) dy = FLOOR - 1 - b.max.y;
    if (dx || dy) Body.translate(body, { x: dx, y: dy });
  }

  // ---------- game flow ----------
  function shuffleArray(a) {
    for (let i = a.length - 1; i > 0; i--) {
      const j = (rand() * (i + 1)) | 0;
      [a[i], a[j]] = [a[j], a[i]];
    }
    return a;
  }

  // opts: { seed, hooks, stage, lap, keep (スコアを引きつぐ) }
  function newGame(m, opts = {}) {
    if (m) mode = m;
    gameId++;
    const M = MODES[mode];
    ST = STAGES[opts.stage || "japan"];
    lap = opts.lap || 1;
    EXP = M.exp + (ST.expAdd || 0);
    LINE_Y = M.lineY + LAP_LINE * Math.min(lap - 1, 3);
    OVER_LIMIT = M.overLimit;
    rand = opts.seed ? seeded(String(opts.seed)) : Math.random;
    hooks = opts.hooks || null;
    lineDownUntil = 0;

    engine = Engine.create({ positionIterations: 10, velocityIterations: 8 });
    engine.gravity.y = 1;
    world = engine.world;
    const wallOpts = { isStatic: true, friction: 0.5, restitution: 0.05 };
    Composite.add(world, [
      Bodies.rectangle(W / 2, FLOOR + 50, W + 200, 100, wallOpts),
      Bodies.rectangle(BOX_L - 50, H / 2 - 200, 100, H + 400, wallOpts),
      Bodies.rectangle(BOX_R + 50, H / 2 - 200, 100, H + 400, wallOpts),
    ]);
    Events.on(engine, "collisionStart", onCollide);
    Events.on(engine, "collisionActive", onCollide);

    groups = [];
    queue = shuffleArray(ST.ids.slice());
    if (!opts.keep) {
      score = 0;
      parts = { merge: 0, region: 0, clear: 0, time: 0 };
      cleared = [];
      shufflesUsed = 0;
    }
    shuffleReadyAt = 0;
    regionsDone = new Set();
    overTimer = 0;
    combo = 0;
    particles = [];
    fx = [];
    ended = false;
    paused = false;
    completeAt = 0;
    finalStart = 0;
    timeUp = false;
    stageStart = now;
    current = null;
    pending = [];
    [ui.start, ui.menu, ui.result].forEach((el) => el.classList.add("hidden"));
    ui.stageTag.textContent = stageLabel();
    nextPiece();
    updateHud();
    running = true;
    if (opts.keep || ST.key !== "japan") {
      fx.push({ type: "banner", t0: now, dur: 2000, text: opts.keep ? "つぎは アジア大陸！" : "エクストラステージ", sub: "となりの国どうしをつなげよう", color: "#3b6fd8" });
    }
  }
  const stageLabel = () => (ST.key === "asia" ? "アジア" : lap > 1 ? `日本 ${lap}周目` : "日本");

  function nextPiece() {
    if (!queue.length) { current = null; drawNext(); return; }
    const id = queue.shift();
    current = { id, bb: groupBoundsAt([id]) };
    const nb = MODES[mode].neighbor;
    if (nb) arrangeNeighborNext(nb);
    aimX = clampAim(aimX);
    drawNext();
  }

  // かんたんモード: 次のピースを、箱の中か今のピースのおとなりから選ぶことがある
  function arrangeNeighborNext(prob) {
    if (queue.length < 2 || rand() > prob) return;
    const placed = new Set(current ? [current.id] : []);
    for (const g of groups) for (const id of g.members) placed.add(id);
    const cands = [];
    queue.forEach((id, i) => { for (const p of placed) if (ST.pieces[id].adjSet.has(p)) { cands.push(i); break; } });
    if (!cands.length) return;
    const i = cands[(rand() * cands.length) | 0];
    const [id] = queue.splice(i, 1);
    queue.unshift(id);
  }

  function clampAim(x) {
    if (!current) return x;
    const { minX, maxX } = current.bb;
    return Math.max(BOX_L - minX + 2, Math.min(BOX_R - maxX - 2, x));
  }

  function drop() {
    if (!running || paused || ended || !current || now < canDropAt) return;
    const g = createGroupBody([current.id], aimX, HANG_Y);
    Body.setPosition(g.body, { x: aimX + g.local.x, y: HANG_Y + g.local.y });
    keepInside(g.body);
    Body.setVelocity(g.body, { x: 0, y: 2 });
    g.droppedAt = now;
    Composite.add(world, g.body);
    groups.push(g);
    canDropAt = now + DROP_COOLDOWN;
    if (!queue.length && !finalStart) {
      // 最後のピース → ここから制限時間
      finalStart = now;
      fx.push({ type: "banner", t0: now + 200, dur: 1700, text: "ラスト！", sub: `${ST.finalTime}秒以内に${ST.finalName}を完成させよう`, color: "#e85d4a" });
    }
    current = null;
    vibrate(8);
    updateHud();
    later(() => { if (running && !ended && !current) { nextPiece(); updateHud(); } }, DROP_COOLDOWN);
  }

  // ---------- merging ----------
  let pending = [];
  function onCollide(ev) {
    for (const pair of ev.pairs) {
      const a = pair.bodyA.parent.plugin.group;
      const b = pair.bodyB.parent.plugin.group;
      if (!a || !b || a === b) continue;
      pending.push([a, b]);
    }
  }

  function adjacent(a, b) {
    for (const id of a.members) {
      const adj = ST.pieces[id].adjSet;
      for (const j of b.members) if (adj.has(j)) return true;
    }
    return false;
  }

  function processMerges() {
    if (!pending.length) return;
    const used = new Set();
    for (const [a, b] of pending) {
      if (used.has(a) || used.has(b) || a.dead || b.dead) continue;
      if (!adjacent(a, b)) continue;
      used.add(a); used.add(b);
      merge(a, b);
    }
    pending = [];
  }

  function mainColor(members) {
    const cnt = {};
    for (const id of members) { const r = ST.pieces[id].region; cnt[r] = (cnt[r] || 0) + ST.pieces[id].area; }
    const r = Object.keys(cnt).sort((x, y) => cnt[y] - cnt[x])[0];
    return ST.colors[r];
  }

  function merge(a, b) {
    const members = [...a.members, ...b.members];
    const ma = a.body.mass, mb = b.body.mass;
    const tx = (a.body.position.x * ma + b.body.position.x * mb) / (ma + mb);
    const ty = (a.body.position.y * ma + b.body.position.y * mb) / (ma + mb);
    const vx = (a.body.velocity.x * ma + b.body.velocity.x * mb) / (ma + mb);
    const vy = (a.body.velocity.y * ma + b.body.velocity.y * mb) / (ma + mb);

    a.dead = b.dead = true;
    Composite.remove(world, a.body);
    Composite.remove(world, b.body);
    groups = groups.filter((g) => g !== a && g !== b);

    const g = createGroupBody(members, tx, ty);
    Body.setPosition(g.body, { x: tx, y: ty });
    keepInside(g.body);
    Body.setVelocity(g.body, { x: vx * 0.5, y: Math.min(vy, 2) * 0.5 });
    g.droppedAt = Math.min(a.droppedAt, b.droppedAt);
    g.flash = 1;
    g.shrinkFrom = Math.max(1, Math.max(a.geom.s, b.geom.s) / g.geom.s);  // くっつくと少し小さくなる
    Composite.add(world, g.body);
    groups.push(g);

    // score
    combo = now - comboTimer < 900 ? combo + 1 : 1;
    comboTimer = now;
    const gained = 10 * members.length * Math.min(combo, 5) * lap;
    score += gained;
    parts.merge += gained;

    // effects: ring + "+点" + particles
    const color = mainColor(members);
    const { x, y } = g.body.position;
    const size = Math.max(g.body.bounds.max.x - g.body.bounds.min.x, g.body.bounds.max.y - g.body.bounds.min.y);
    fx.push({ type: "ring", t0: now, dur: 520, x, y, r0: size * 0.25, r1: size * 0.75 + 30, color });
    fx.push({ type: "ring", t0: now + 90, dur: 520, x, y, r0: size * 0.2, r1: size * 0.6 + 20, color: "#ffffff" });
    // 文字は同時に出しすぎない（連鎖で画面が埋まらないように）
    const bigBanner = fx.some((f) => f.type === "banner" && f.big);
    fx = fx.filter((f, i, arr) => f.type !== "text" || arr.filter((x) => x.type === "text").indexOf(f) >= arr.filter((x) => x.type === "text").length - 3);
    if (!bigBanner) {
      fx.push({ type: "text", t0: now, dur: 900, x, y: y - 10, text: `+${gained}`, color: shade(color, -0.35), size: 18 + Math.min(8, members.length) });
      if (combo >= 2) fx.push({ type: "text", t0: now + 120, dur: 900, x, y: y - 36, text: `${combo} コンボ！`, color: "#e85d4a", size: Math.min(28, 16 + combo * 2) });
    }
    burst(x, y, members.length, false, color);
    if (members.length >= 6) shake = Math.max(shake, 4 + Math.min(6, members.length / 4));
    vibrate(members.length > 10 ? 30 : 15);

    checkRegions(g);
    if (g.gold) completeStage(g);
    updateHud();
  }

  function checkRegions(g) {
    ST.regionMembers.forEach((ids, ri) => {
      if (regionsDone.has(ri) || ST.skipRegions.includes(ri)) return;
      if (!ids.every((id) => g.members.has(id))) return;
      regionsDone.add(ri);
      const bonus = 300 * lap;
      score += bonus;
      parts.region += bonus;
      const color = ST.colors[ri];
      g.glowUntil = now + 1800;
      g.glowColor = color;
      if (!g.gold) {
        fx.push({ type: "banner", t0: now, dur: 1700, text: `${ST.regionName(ST.regions[ri])}`, sub: `コンプリート！ +${bonus}`, color });
        confetti(26, [color, shade(color, -0.25), "#ffffff", "#f7d35c"]);
        shake = Math.max(shake, 8);
        vibrate([20, 40, 30]);
      }
      if (hooks && hooks.onRegion) hooks.onRegion(ri);
    });
  }

  function completeStage(g) {
    const secs = (now - stageStart) / 1000;
    const bonus = ST.clearBonus * lap;
    const tbonus = Math.max(0, Math.round((ST.par - secs) * 10)) * lap;
    score += bonus + tbonus;
    parts.clear += bonus;
    parts.time += tbonus;
    cleared.push(ST.key === "japan" && lap > 1 ? `日本列島（${lap}周目）` : ST.finalName);
    completeAt = now;
    g.glowUntil = now + 4000;
    g.glowColor = "#f7d35c";
    fx.push({ type: "flash", t0: now, dur: 600, color: "#fff6d6" });
    fx.push({ type: "rays", t0: now, dur: 3200, group: g });
    fx.push({ type: "banner", t0: now + 250, dur: 2700, text: `${ST.finalName} 完成！`, sub: `+${bonus + tbonus}${tbonus ? `（タイムボーナス ${tbonus}）` : ""}`, color: "#e8a019", big: true });
    for (let i = 0; i < 5; i++) later(() => confetti(36, ["#f7d35c", "#e8b931", "#fff3c4", "#ef8a7c", "#7fb7e8", "#86cfb0"]), i * 350);
    if (ST.key === "japan" && !hooks) { store.set("prefpack.asiaUnlocked", true); showAsiaUnlock(); }
    shake = 14;
    vibrate([40, 60, 40, 60, 120]);
    updateHud();
    if (hooks) { later(() => endGame(true), 2800); return; }
    if (ST.key === "japan") later(() => newGame(mode, { stage: "asia", lap, keep: true }), 3400);  // そのままアジア大陸へ
    else later(() => endGame(true), 3200);                                                       // 全クリア
  }


  // ---------- shuffle ----------
  function doShuffle() {
    if (!running || paused || ended || now < shuffleReadyAt) return;
    shuffleReadyAt = now + SHUFFLE_COOLDOWN;
    shufflesUsed++;
    for (const g of groups) {
      Body.setVelocity(g.body, { x: (Math.random() - 0.5) * 9, y: -4 - Math.random() * 7 });
      Body.setAngularVelocity(g.body, (Math.random() - 0.5) * 0.25);
    }
    shake = 12;
    vibrate(25);
    updateHud();
  }

  // ---------- end ----------
  let lastResult = null;
  function endGame(clearedNow) {
    if (ended) return;
    ended = true;
    running = false;
    const isBest = score > best[mode];
    if (isBest) { best[mode] = score; store.set(`prefpack.best.${mode}`, score); }
    showBest();
    if (hooks) { if (hooks.onEnd) hooks.onEnd(clearedNow, score); return; }

    const reached = cleared.length ? cleared[cleared.length - 1] : "";
    lastResult = { mode, score, reached, laps: lap, stages: cleared.length };
    const allClear = cleared.includes("アジア大陸");
    ui.resultTitle.textContent = allClear ? (cleared.length > 1 ? "全クリア！" : "アジア大陸 完成！")
      : cleared.length ? (timeUp ? "タイムアップ" : "ゲームオーバー")
      : timeUp ? "タイムアップ" : "ゲームオーバー";
    const left = groups.length + (current ? 1 : 0) + queue.length;
    ui.resultSub.textContent = `【${MODES[mode].name}】` + (cleared.length
      ? `${cleared.join(" → ")} まで完成`
      : `${ST.name}・のこり ${left} かたまり`);
    ui.resultScore.textContent = score;
    ui.newBest.classList.toggle("hidden", !isBest || score === 0);

    const rows = [
      ["くっつけた", parts.merge],
      ["地方そろえ", parts.region],
      ["完成ボーナス", parts.clear],
      ["タイムボーナス", parts.time],
    ];
    ui.resultBreakdown.innerHTML = rows.map(([k, v]) => `<div class="${v ? "" : "zero"}"><span>${k}</span><b>${v}</b></div>`).join("");

    ui.resultRegions.innerHTML = "";
    ST.regions.forEach((name, ri) => {
      if (ST.skipRegions.includes(ri)) return;
      const s = document.createElement("span");
      s.textContent = name;
      if (regionsDone.has(ri) || completeAt) { s.classList.add("done"); s.style.background = ST.strokes[ri]; }
      ui.resultRegions.appendChild(s);
    });
    if (window.PrefRank) window.PrefRank.onResult(lastResult);
    later(() => ui.result.classList.remove("hidden"), clearedNow ? 0 : 600);
  }

  // ---------- update ----------
  function update(dt) {
    Engine.update(engine, dt);
    processMerges();

    // 念のため: 箱の外に出てしまったかたまりは上から戻す
    for (const g of groups) {
      const p = g.body.position;
      if (p.y > H + 120 || p.x < -150 || p.x > W + 150) {
        Body.setPosition(g.body, { x: W / 2, y: HANG_Y });
        Body.setVelocity(g.body, { x: 0, y: 0 });
        Body.setAngularVelocity(g.body, 0);
        keepInside(g.body);
        g.droppedAt = now;
      }
    }

    let danger = false;
    for (const g of groups) {
      if (now - g.droppedAt < 1500) continue;
      const sp = Math.hypot(g.body.velocity.x, g.body.velocity.y);
      if (g.body.bounds.min.y < curLine() && sp < 1.5) { danger = true; break; }
    }
    overTimer = danger ? overTimer + dt : Math.max(0, overTimer - dt * 2);
    if (overTimer > OVER_LIMIT && !completeAt) endGame(false);
    if (finalStart && !completeAt && !ended && finalLeft() <= 0) {
      timeUp = true;
      fx.push({ type: "banner", t0: now, dur: 1400, text: "タイムアップ", sub: "", color: "#3b3226" });
      endGame(false);
    }

    const shuffleReady = now >= shuffleReadyAt;
    if (ui.shuffleBtn.disabled === shuffleReady) ui.shuffleBtn.disabled = !shuffleReady;

    for (const p of particles) {
      p.x += p.vx; p.y += p.vy; p.vy += p.g; p.vx *= p.drag; p.rot += p.vr; p.life -= dt;
    }
    particles = particles.filter((p) => p.life > 0 && p.y < H + 40);
    fx = fx.filter((f) => now < f.t0 + f.dur);
    for (const g of groups) if (g.flash > 0) g.flash = Math.max(0, g.flash - dt / 380);
    if (shake > 0) shake *= 0.86;
    if (shake < 0.3) shake = 0;
  }

  // ---------- rendering ----------
  let dpr = 1, viewScale = 1;
  function resize() {
    const r = $("stage").getBoundingClientRect();
    viewScale = Math.min(r.width / W, r.height / H);
    dpr = Math.min(window.devicePixelRatio || 1, 3);
    canvas.style.width = `${W * viewScale}px`;
    canvas.style.height = `${H * viewScale}px`;
    canvas.width = Math.round(W * viewScale * dpr);
    canvas.height = Math.round(H * viewScale * dpr);
    const nd = Math.min(window.devicePixelRatio || 1, 3);
    nextCanvas.width = 48 * nd;
    nextCanvas.height = 48 * nd;
    drawNext();
  }

  function drawBox() {
    ctx.fillStyle = ST.key === "asia" ? "#f7fbff" : "#fffaf1";
    ctx.fillRect(BOX_L, 0, BOX_R - BOX_L, FLOOR);
    ctx.strokeStyle = ST.key === "asia" ? "rgba(59,111,216,.08)" : "rgba(201,164,107,.12)";
    ctx.lineWidth = 1;
    ctx.beginPath();
    for (let x = BOX_L + 40; x < BOX_R; x += 40) { ctx.moveTo(x, 0); ctx.lineTo(x, FLOOR); }
    for (let y = FLOOR - 40; y > 0; y -= 40) { ctx.moveTo(BOX_L, y); ctx.lineTo(BOX_R, y); }
    ctx.stroke();
    ctx.fillStyle = "#c9a46b";
    ctx.fillRect(0, 0, WALL, H);
    ctx.fillRect(W - WALL, 0, WALL, H);
    ctx.fillRect(0, FLOOR, W, WALL);
    ctx.fillStyle = "#9c7a45";
    ctx.fillRect(0, H - 4, W, 4);

    const d = Math.min(1, overTimer / OVER_LIMIT);
    const ly = curLine();
    ctx.save();
    ctx.setLineDash([8, 7]);
    ctx.lineWidth = 2 + d * 2;
    const pulse = d > 0 ? 0.5 + 0.5 * Math.sin(now / 90) : 0;
    ctx.strokeStyle = d > 0 ? `rgba(232,93,74,${0.55 + 0.45 * pulse})` : "rgba(156,122,69,.45)";
    ctx.beginPath();
    ctx.moveTo(BOX_L, ly);
    ctx.lineTo(BOX_R, ly);
    ctx.stroke();
    ctx.restore();
    if (now < lineDownUntil) {
      const sec = Math.ceil((lineDownUntil - now) / 1000);
      ctx.save();
      ctx.fillStyle = "rgba(232,93,74,.08)";
      ctx.fillRect(BOX_L, LINE_Y, BOX_R - BOX_L, LINE_DROP);
      ctx.font = `800 13px ${FONT}`;
      ctx.textAlign = "right";
      ctx.textBaseline = "bottom";
      ctx.fillStyle = "#c2402f";
      ctx.fillText(`おじゃま中 ${sec}`, BOX_R - 8, ly - 4);
      ctx.restore();
    }
  }

  function drawGroupShapes(c, members, geom, gold, alpha = 1, st = ST, flash = 0) {
    c.globalAlpha = alpha;
    for (const id of members) {
      const p = st.pieces[id];
      if (gold) {
        const gr = c.createLinearGradient(0, 0, st.ew, st.eh);
        gr.addColorStop(0, "#fbe38a");
        gr.addColorStop(0.5, "#e8b931");
        gr.addColorStop(1, "#f6d260");
        c.fillStyle = gr;
      } else {
        c.fillStyle = p.color;
      }
      c.fill(p.path);
    }
    if (flash > 0) {
      c.globalAlpha = alpha * flash * 0.85;
      c.fillStyle = "#ffffff";
      for (const id of members) c.fill(st.pieces[id].path);
      c.globalAlpha = alpha;
    }
    c.lineJoin = "round";
    c.lineWidth = 1.6 / geom.s;
    for (const id of members) {
      const p = st.pieces[id];
      c.strokeStyle = gold ? "#b0861a" : p.stroke;
      c.stroke(p.path);
    }
    c.globalAlpha = 1;
  }

  function groupTransform(g) {
    const b = g.body;
    const t = Math.min(1, (now - g.born) / 380);
    const from = g.shrinkFrom || 1;
    // くっついた直前の大きさ → 新しい（少し小さい）大きさへ、ぷにっと縮む
    const k = (from + (1 - from) * ease(t)) * (1 + 0.1 * Math.sin(Math.min(1, t * 1.4) * Math.PI));
    ctx.translate(b.position.x, b.position.y);
    ctx.rotate(b.angle);
    ctx.scale(k, k);
    ctx.translate(-g.local.x, -g.local.y);
    ctx.scale(g.geom.s, g.geom.s);
    ctx.translate(-g.geom.ox, -g.geom.oy);
  }

  function drawLabels(members, geom, toWorld, gold) {
    ctx.textAlign = "center";
    ctx.textBaseline = "middle";
    for (const id of members) {
      const p = ST.pieces[id];
      const size = geom.s * Math.sqrt(p.area);
      if (size < 22) continue;
      let fs = Math.max(8, Math.min(15, size * 0.24));
      ctx.font = `800 ${fs}px ${FONT}`;
      const maxW = Math.max(size * 1.2, 30);
      const tw = ctx.measureText(p.short).width;
      if (tw > maxW) { fs = Math.max(7, fs * maxW / tw); ctx.font = `800 ${fs}px ${FONT}`; }
      const w = toWorld(p.cx, p.cy);
      ctx.lineWidth = 3;
      ctx.strokeStyle = gold ? "rgba(255,240,180,.9)" : "rgba(255,255,255,.85)";
      ctx.strokeText(p.short, w.x, w.y);
      ctx.fillStyle = gold ? "#5a3f00" : "#3b3226";
      ctx.fillText(p.short, w.x, w.y);
    }
  }

  function ease(t) { return 1 - Math.pow(1 - t, 3); }

  function drawRays(f) {
    const g = f.group;
    if (!g || g.dead) return;
    const t = (now - f.t0) / f.dur;
    const a = t < 0.15 ? t / 0.15 : t > 0.75 ? (1 - t) / 0.25 : 1;
    const { x, y } = g.body.position;
    ctx.save();
    ctx.translate(x, y);
    ctx.rotate(now / 1400);
    ctx.globalAlpha = 0.5 * a;
    for (let i = 0; i < 14; i++) {
      ctx.rotate((Math.PI * 2) / 14);
      const gr = ctx.createLinearGradient(0, 0, 420, 0);
      gr.addColorStop(0, "rgba(247,211,92,.9)");
      gr.addColorStop(1, "rgba(247,211,92,0)");
      ctx.fillStyle = gr;
      ctx.beginPath();
      ctx.moveTo(0, 0);
      ctx.lineTo(420, -26);
      ctx.lineTo(420, 26);
      ctx.closePath();
      ctx.fill();
    }
    ctx.restore();
  }

  function drawFx(f) {
    const t = Math.min(1, Math.max(0, (now - f.t0) / f.dur));
    if (now < f.t0) return;
    if (f.type === "ring") {
      const r = f.r0 + (f.r1 - f.r0) * ease(t);
      ctx.save();
      ctx.globalAlpha = (1 - t) * 0.9;
      ctx.strokeStyle = f.color;
      ctx.lineWidth = 6 * (1 - t) + 1;
      ctx.beginPath();
      ctx.arc(f.x, f.y, r, 0, Math.PI * 2);
      ctx.stroke();
      ctx.restore();
    } else if (f.type === "text") {
      ctx.save();
      ctx.globalAlpha = t < 0.7 ? 1 : (1 - t) / 0.3;
      const pop = t < 0.15 ? 0.6 + (t / 0.15) * 0.5 : 1.1 - Math.min(0.1, (t - 0.15));
      ctx.translate(f.x, f.y - 36 * ease(t));
      ctx.scale(pop, pop);
      ctx.font = `800 ${f.size}px ${FONT}`;
      ctx.textAlign = "center";
      ctx.textBaseline = "middle";
      ctx.lineWidth = 5;
      ctx.strokeStyle = "#ffffff";
      ctx.strokeText(f.text, 0, 0);
      ctx.fillStyle = f.color;
      ctx.fillText(f.text, 0, 0);
      ctx.restore();
    } else if (f.type === "banner") {
      const inT = Math.min(1, t / 0.14), outT = t > 0.82 ? (t - 0.82) / 0.18 : 0;
      const y = H * 0.36;
      const hgt = f.big ? 120 : 86;
      ctx.save();
      ctx.globalAlpha = 1 - outT;
      // band
      ctx.fillStyle = f.color;
      const bw = W * ease(inT);
      ctx.fillRect(W / 2 - bw / 2, y - hgt / 2, bw, hgt);
      ctx.fillStyle = "rgba(255,255,255,.18)";
      ctx.fillRect(W / 2 - bw / 2, y - hgt / 2, bw, 6);
      ctx.fillRect(W / 2 - bw / 2, y + hgt / 2 - 6, bw, 6);
      // text
      const sc = inT < 1 ? 1.6 - 0.6 * ease(inT) : 1 + 0.03 * Math.sin(now / 120);
      ctx.translate(W / 2 + outT * 60, y);
      ctx.scale(sc, sc);
      ctx.textAlign = "center";
      ctx.textBaseline = "middle";
      ctx.font = `800 ${f.big ? 38 : 30}px ${FONT}`;
      ctx.lineWidth = 7;
      ctx.strokeStyle = "rgba(59,50,38,.35)";
      ctx.strokeText(f.text, 0, f.sub ? -12 : 0);
      ctx.fillStyle = "#ffffff";
      ctx.fillText(f.text, 0, f.sub ? -12 : 0);
      if (f.sub) {
        ctx.font = `800 ${f.big ? 16 : 15}px ${FONT}`;
        ctx.fillStyle = "rgba(255,255,255,.95)";
        ctx.fillText(f.sub, 0, f.big ? 30 : 24);
      }
      ctx.restore();
    } else if (f.type === "flash") {
      ctx.save();
      ctx.globalAlpha = (1 - t) * 0.85;
      ctx.fillStyle = f.color;
      ctx.fillRect(0, 0, W, H);
      ctx.restore();
    }
  }

  function render() {
    const s = viewScale * dpr;
    ctx.setTransform(s, 0, 0, s, 0, 0);
    ctx.clearRect(0, 0, W, H);
    if (shake) ctx.translate((Math.random() - 0.5) * shake, (Math.random() - 0.5) * shake * 0.5);
    drawBox();
    for (const f of fx) if (f.type === "rays") drawRays(f);

    const hintId = MODES[mode].hint && current && !ended ? current.id : null;
    for (const g of groups) {
      ctx.save();
      const hinted = hintId != null && [...g.members].some((id) => ST.pieces[hintId].adjSet.has(id));
      if (now < g.glowUntil) {
        ctx.shadowColor = g.glowColor;
        ctx.shadowBlur = 26 + 12 * Math.sin(now / 110);
        ctx.shadowOffsetY = 0;
      } else if (hinted) {
        ctx.shadowColor = "rgba(255,190,40,.95)";
        ctx.shadowBlur = 14 + 8 * Math.sin(now / 180);
        ctx.shadowOffsetY = 0;
      } else {
        ctx.shadowColor = g.gold ? "rgba(232,185,49,.8)" : "rgba(59,50,38,.18)";
        ctx.shadowBlur = g.gold ? 24 + 8 * Math.sin(now / 200) : 6;
        ctx.shadowOffsetY = g.gold ? 0 : 2;
      }
      groupTransform(g);
      drawGroupShapes(ctx, g.members, g.geom, g.gold, 1, ST, g.flash);
      ctx.restore();
    }
    for (const g of groups) {
      const b = g.body, cos = Math.cos(b.angle), sin = Math.sin(b.angle);
      drawLabels(g.members, g.geom, (mx, my) => {
        const lx = (mx - g.geom.ox) * g.geom.s - g.local.x;
        const ly = (my - g.geom.oy) * g.geom.s - g.local.y;
        return { x: b.position.x + lx * cos - ly * sin, y: b.position.y + lx * sin + ly * cos };
      }, g.gold);
    }

    if (current && running && !ended) {
      const { geom } = current.bb;
      const ready = now >= canDropAt;
      ctx.save();
      ctx.strokeStyle = "rgba(59,50,38,.18)";
      ctx.setLineDash([3, 6]);
      ctx.lineWidth = 2;
      ctx.beginPath();
      ctx.moveTo(aimX, HANG_Y + current.bb.maxY);
      ctx.lineTo(aimX, FLOOR);
      ctx.stroke();
      ctx.restore();
      ctx.save();
      ctx.translate(aimX, HANG_Y + Math.sin(now / 300) * 2);
      ctx.scale(geom.s, geom.s);
      ctx.translate(-geom.ox, -geom.oy);
      drawGroupShapes(ctx, [current.id], geom, false, ready ? 1 : 0.5);
      ctx.restore();
      drawLabels([current.id], geom, (mx, my) => ({
        x: aimX + (mx - geom.ox) * geom.s,
        y: HANG_Y + (my - geom.oy) * geom.s,
      }), false);
    }

    for (const p of particles) {
      ctx.save();
      ctx.globalAlpha = Math.max(0, Math.min(1, p.life / p.max * 1.5));
      ctx.fillStyle = p.color;
      ctx.translate(p.x, p.y);
      if (p.conf) {
        ctx.rotate(p.rot);
        ctx.scale(1, Math.cos(p.rot * 1.7));
        ctx.fillRect(-p.r, -p.r * 0.5, p.r * 2, p.r);
      } else {
        ctx.beginPath();
        ctx.arc(0, 0, p.r, 0, Math.PI * 2);
        ctx.fill();
      }
      ctx.restore();
    }
    drawFinalTimer();
    for (const f of fx) if (f.type !== "rays") drawFx(f);
  }

  // 最後のピースのあとの残り時間（箱の上に大きく）
  function drawFinalTimer() {
    if (!finalStart || completeAt) return;
    const left = Math.max(0, finalLeft());
    const sec = Math.ceil(left / 1000);
    const hurry = sec <= 10;
    ctx.save();
    ctx.textAlign = "center";
    ctx.textBaseline = "middle";
    const pulse = hurry ? 1 + 0.08 * Math.max(0, Math.cos(((left % 1000) / 1000) * Math.PI * 2)) : 1;
    ctx.translate(W / 2, 62);
    ctx.scale(pulse, pulse);
    ctx.font = `800 13px ${FONT}`;
    ctx.fillStyle = hurry ? "#c2402f" : "#8a7b66";
    ctx.fillText(`${ST.finalName}まで あと`, 0, -30);
    ctx.font = `800 52px ${FONT}`;
    ctx.lineWidth = 6;
    ctx.strokeStyle = "#ffffff";
    ctx.strokeText(`${sec}`, 0, 8);
    ctx.fillStyle = hurry ? "#e85d4a" : "#3b3226";
    ctx.fillText(`${sec}`, 0, 8);
    ctx.restore();
  }

  function drawNext() {
    const c = nctx;
    c.setTransform(1, 0, 0, 1, 0, 0);
    c.clearRect(0, 0, nextCanvas.width, nextCanvas.height);
    const id = queue[0];
    ui.nextName.textContent = id ? ST.pieces[id].short : "—";
    if (!id) return;
    const { minX, minY, maxX, maxY } = ST.pieces[id].bbox;
    const size = nextCanvas.width;
    const k = (size * 0.84) / Math.max(maxX - minX, maxY - minY);
    c.translate(size / 2, size / 2);
    c.scale(k, k);
    c.translate(-(minX + maxX) / 2, -(minY + maxY) / 2);
    drawGroupShapes(c, [id], { s: k / 1.4 }, false);
  }

  // ---------- effects ----------
  function burst(x, y, n, gold, color) {
    const count = Math.min(46, 12 + n * 2);
    const cols = gold ? ["#f7d35c", "#e8b931", "#fff3c4"] : [color || "#f5ae62", shade(color || "#f5ae62", 0.25), "#ffffff", "#f7d35c"];
    for (let i = 0; i < count; i++) {
      const a = Math.random() * Math.PI * 2, sp = 2 + Math.random() * 6;
      const max = 500 + Math.random() * 500;
      particles.push({
        x, y, vx: Math.cos(a) * sp, vy: Math.sin(a) * sp - 2, g: 0.25, drag: 0.98, rot: 0, vr: 0,
        r: 2 + Math.random() * 3.5, life: max, max, color: cols[i % cols.length],
      });
    }
  }
  function confetti(n, cols) {
    for (let i = 0; i < n; i++) {
      const max = 2200 + Math.random() * 1200;
      particles.push({
        x: BOX_L + Math.random() * (BOX_R - BOX_L), y: -10 - Math.random() * 120,
        vx: (Math.random() - 0.5) * 2.4, vy: 1.5 + Math.random() * 2.5, g: 0.04, drag: 0.995,
        rot: Math.random() * 6, vr: (Math.random() - 0.5) * 0.3,
        r: 3.5 + Math.random() * 3.5, life: max, max, color: cols[i % cols.length], conf: true,
      });
    }
  }

  let toastTimer = 0;
  function toast(msg, gold) {
    ui.toast.textContent = msg;
    ui.toast.classList.toggle("gold", !!gold);
    ui.toast.classList.add("show");
    clearTimeout(toastTimer);
    toastTimer = setTimeout(() => ui.toast.classList.remove("show"), 1800);
  }

  function vibrate(p) {
    try { if (navigator.vibrate) navigator.vibrate(p); } catch { /* ignore */ }
  }

  function updateHud() {
    ui.score.textContent = score;
    ui.remain.textContent = queue.length + (current ? 1 : 0);
    ui.shuffleBtn.disabled = !running || now < shuffleReadyAt;
    drawNext();
  }

  // ---------- helpers ----------
  function shade(hex, amt) {
    const n = parseInt(hex.slice(1), 16);
    let r = n >> 16, g = (n >> 8) & 255, b = n & 255;
    const f = (v) => Math.round(amt >= 0 ? v + (255 - v) * amt : v * (1 + amt));
    r = f(r); g = f(g); b = f(b);
    const cl = (v) => Math.max(0, Math.min(255, v));
    return `#${[cl(r), cl(g), cl(b)].map((v) => v.toString(16).padStart(2, "0")).join("")}`;
  }

  // ---------- input ----------
  let pointerDown = false;
  function toLogicalX(e) {
    const r = canvas.getBoundingClientRect();
    return ((e.clientX - r.left) / r.width) * W;
  }
  canvas.addEventListener("pointerdown", (e) => {
    pointerDown = true;
    aimX = clampAim(toLogicalX(e));
    canvas.setPointerCapture(e.pointerId);
  });
  canvas.addEventListener("pointermove", (e) => {
    if (pointerDown || e.pointerType === "mouse") aimX = clampAim(toLogicalX(e));
  });
  canvas.addEventListener("pointerup", (e) => {
    if (!pointerDown) return;
    pointerDown = false;
    aimX = clampAim(toLogicalX(e));
    drop();
  });
  canvas.addEventListener("pointercancel", () => { pointerDown = false; });
  window.addEventListener("keydown", (e) => {
    if (!running || e.target.closest("input")) return;
    if (e.key === "ArrowLeft") aimX = clampAim(aimX - 12);
    if (e.key === "ArrowRight") aimX = clampAim(aimX + 12);
    if (e.key === " " || e.key === "ArrowDown") { e.preventDefault(); drop(); }
    if (e.key === "s") doShuffle();
  });

  ui.shuffleBtn.addEventListener("click", doShuffle);
  $("startBtn").addEventListener("click", () => newGame("normal"));
  $("startEasyBtn").addEventListener("click", () => newGame("easy"));
  // エクストラステージ: 日本列島を一度完成させると、タイトルから直接あそべる
  function showAsiaUnlock() {
    const on = !!store.get("prefpack.asiaUnlocked", false);
    $("asiaBox").classList.toggle("locked", !on);
    $("asiaNormalBtn").disabled = !on;
    $("asiaEasyBtn").disabled = !on;
  }
  showAsiaUnlock();
  $("asiaNormalBtn").addEventListener("click", () => newGame("normal", { stage: "asia" }));
  $("asiaEasyBtn").addEventListener("click", () => newGame("easy", { stage: "asia" }));
  const toTitle = () => {
    gameId++;
    running = false; ended = true; engine = null; groups = []; current = null; hooks = null;
    ST = STAGES.japan; fx = []; particles = [];
    [ui.menu, ui.result].forEach((el) => el.classList.add("hidden"));
    ui.start.classList.remove("hidden");
    score = 0; queue = ST.ids.slice(); ui.stageTag.textContent = "日本"; updateHud();
  };
  $("titleBtn").addEventListener("click", toTitle);
  $("resultTitleBtn").addEventListener("click", toTitle);
  $("menuBtn").addEventListener("click", () => {
    if (!running) return;
    if (!hooks) paused = true;   // 対戦中は止めない
    document.body.classList.toggle("multi", !!hooks);
    ui.menu.classList.remove("hidden");
  });
  $("resumeBtn").addEventListener("click", () => {
    paused = false;
    ui.menu.classList.add("hidden");
  });
  $("restartBtn").addEventListener("click", () => newGame());
  $("againBtn").addEventListener("click", () => newGame());
  document.addEventListener("visibilitychange", () => {
    if (document.hidden && running && !ended && !hooks) { paused = true; ui.menu.classList.remove("hidden"); }
  });

  // ---------- loop ----------
  const STEP = 1000 / 60;
  let last = performance.now(), acc = 0;
  function frame(t) {
    const dt = Math.min(100, t - last);
    last = t;
    if (engine && !paused && (running || completeAt) && !ended) {
      acc += dt;
      let n = 0;
      while (acc >= STEP && n < 4) { now += STEP; update(STEP); acc -= STEP; n++; }
      if (n === 4) acc = 0;
    } else if (engine && ended) {
      // 結果画面の裏でもエフェクトだけは動かす
      now += dt;
      for (const p of particles) { p.x += p.vx; p.y += p.vy; p.vy += p.g; p.rot += p.vr; p.life -= dt; }
      particles = particles.filter((p) => p.life > 0);
      fx = fx.filter((f) => now < f.t0 + f.dur);
    }
    if (engine) render();
    else renderIdle(t);
    requestAnimationFrame(frame);
  }

  // title background: the whole Japan, gently bobbing
  function renderIdle(t) {
    const s = viewScale * dpr;
    const J = STAGES.japan;
    ctx.setTransform(s, 0, 0, s, 0, 0);
    ctx.clearRect(0, 0, W, H);
    drawBox();
    ctx.save();
    ctx.translate(W / 2, (150 + FLOOR) / 2 + Math.sin(t / 700) * 4);
    ctx.scale(J.sTotal, J.sTotal);
    ctx.translate(-J.ew / 2, -J.eh / 2);
    ctx.shadowColor = "rgba(232,185,49,.6)";
    ctx.shadowBlur = 20;
    drawGroupShapes(ctx, J.ids, { s: J.sTotal }, false, 1, J);
    ctx.restore();
  }

  window.addEventListener("resize", resize);
  resize();
  requestAnimationFrame(frame);

  // ---------- public API (net.js: 対戦 / ランキング) ----------
  function snapshot() {
    const r = (v) => Math.round(v * 10) / 10;
    return groups.map((g) => [[...g.members], r(g.body.position.x), r(g.body.position.y), Math.round(g.body.angle * 100) / 100, r(g.local.x), r(g.local.y)]);
  }
  // 相手の箱（スナップショット）を小さなキャンバスに描く（対戦は日本ステージのみ）
  function drawBoard(cv, snap, opts = {}) {
    const J = STAGES.japan;
    const M = MODES[opts.mode || "normal"] || MODES.normal;
    const c = cv.getContext("2d");
    const k = cv.width / W;
    c.setTransform(1, 0, 0, 1, 0, 0);
    c.clearRect(0, 0, cv.width, cv.height);
    c.setTransform(k, 0, 0, k, 0, 0);
    c.fillStyle = "#fffaf1"; c.fillRect(BOX_L, 0, BOX_R - BOX_L, FLOOR);
    c.fillStyle = "#c9a46b"; c.fillRect(0, 0, WALL, H); c.fillRect(W - WALL, 0, WALL, H); c.fillRect(0, FLOOR, W, WALL);
    c.strokeStyle = opts.lineDown ? "#e85d4a" : "rgba(156,122,69,.6)";
    c.lineWidth = 4; c.setLineDash([14, 10]);
    const ly = M.lineY + (opts.lineDown ? LINE_DROP : 0);
    c.beginPath(); c.moveTo(BOX_L, ly); c.lineTo(BOX_R, ly); c.stroke(); c.setLineDash([]);
    for (const [members, x, y, a, lx, ly2] of snap || []) {
      const geom = makeGroupGeom(members, J, M.exp);
      c.save();
      c.translate(x, y); c.rotate(a); c.translate(-lx, -ly2);
      c.scale(geom.s, geom.s); c.translate(-geom.ox, -geom.oy);
      drawGroupShapes(c, members, geom, members.length === J.ids.length, 1, J);
      c.restore();
    }
  }
  window.PrefGame = {
    start(m, seed, h) { newGame(m, { seed, hooks: h, stage: "japan" }); },
    stop() { toTitle(); },
    leaveToTitle: () => toTitle(),
    snapshot,
    drawBoard,
    attack(ms) {
      if (!running || ended) return;
      lineDownUntil = Math.max(lineDownUntil, now) + ms;
      shake = 10;
      vibrate([30, 40, 30]);
    },
    get info() {
      return { running, ended, score, mode, left: groups.length + (current ? 1 : 0) + queue.length, lineDown: now < lineDownUntil, cleared: !!completeAt };
    },
    toast,
    MODES,
  };

  // debugging / tests
  window.__prefpack = {
    get state() { return { finalLeft: finalStart ? Math.round(finalLeft()) : null, timeUp, multi: !!hooks, mode, stage: ST.key, lap, score, parts: { ...parts }, groups: groups.length, queue: queue.length, current: current && current.id, ended, shufflesUsed, regionsDone: [...regionsDone], cleared: [...cleared], fx: fx.length, particles: particles.length }; },
    newGame, drop, doShuffle, setAim: (x) => { aimX = clampAim(x); },
    fastForward(ms) { if (!engine) return; const n = Math.round(ms / STEP); for (let i = 0; i < n && !ended; i++) { now += STEP; update(STEP); } },
    skipCooldown() { canDropAt = 0; shuffleReadyAt = 0; if (!current) nextPiece(); },
    forceEnd(c) { endGame(!!c); },
    // テスト用: いま箱にあるかたまりを全部まとめる（完成演出の確認）
    mergeAll() {
      while (queue.length || current) { if (!current) nextPiece(); const g = createGroupBody([current.id], W / 2, 400); Composite.add(world, g.body); groups.push(g); current = null; }
      while (groups.length > 1) {
        const a = groups[0];
        const b = groups.slice(1).find((x) => adjacent(a, x));
        if (!b) break;
        merge(a, b);
      }
    },
    mergeRegion(ri) {
      const ids = ST.regionMembers[ri];
      for (const id of ids) { queue = queue.filter((q) => q !== id); if (current && current.id === id) current = null; const g = createGroupBody([id], W / 2, 400); Composite.add(world, g.body); groups.push(g); }
      let mine = groups.filter((g) => [...g.members].every((m) => ids.includes(m)));
      while (mine.length > 1) {
        const a = mine[0], b = mine.slice(1).find((x) => adjacent(a, x));
        if (!b) break;
        merge(a, b);
        mine = groups.filter((g) => [...g.members].every((m) => ids.includes(m)));
      }
    },
    STAGES,
    groupsInfo: () => groups.map((g) => ({ m: [...g.members], x: g.body.position.x, y: g.body.position.y })),
    queueIds: () => queue.slice(),
  };
})();
