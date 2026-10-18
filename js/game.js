/* 都道府県ゲーム
 * 都道府県を箱に落として詰める。地図で隣り合う県がふれるとくっつく。
 */
(() => {
  "use strict";

  const { Engine, Bodies, Body, Composite, Events, Vertices } = Matter;
  const DATA = window.PREF_DATA;

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

  // ゲームモード
  //  exp:       合体時の縮み具合（大きいほど 1 県のピースが小さく、詰めやすい）
  //  lineY:     あふれラインの高さ（小さいほど上＝余裕が増える）
  //  overLimit: ラインを超えてからゲームオーバーまでの猶予(ms)
  //  neighbor:  次の県を「すでに箱にある県のおとなり」から出やすくする
  //  hint:      今落とす県とくっつけるかたまりを光らせる
  const MODES = {
    normal: { name: "ふつう", exp: 0.25, lineY: 150, overLimit: 2200, neighbor: false, hint: false },
    easy:   { name: "かんたん", exp: 0.32, lineY: 130, overLimit: 4000, neighbor: true, hint: true },
  };
  let mode = "normal";
  let LINE_Y = MODES.normal.lineY;   // overflow line
  let EXP = MODES.normal.exp;        // group linear size ∝ area^EXP (shrinks big groups)
  let OVER_LIMIT = MODES.normal.overLimit;

  const REGION_COLORS = [
    "#7fb7e8", // 北海道
    "#86cfb0", // 東北
    "#f5ae62", // 関東
    "#a3d06a", // 中部
    "#f29abf", // 近畿
    "#b6a3e6", // 中国
    "#f3cd52", // 四国
    "#ef8a7c", // 九州・沖縄
  ];
  const REGION_STROKE = REGION_COLORS.map((c) => shade(c, -0.28));

  // ---------- prefecture data ----------
  const PREFS = {};
  let TOTAL_AREA = 0;
  for (const p of DATA.prefs) {
    const path = new Path2D();
    for (let i = 0; i < p.poly.length; i += 2) {
      if (i === 0) path.moveTo(p.poly[i], p.poly[i + 1]);
      else path.lineTo(p.poly[i], p.poly[i + 1]);
    }
    path.closePath();
    const hull = [];
    for (let i = 0; i < p.hull.length; i += 2) hull.push({ x: p.hull[i], y: p.hull[i + 1] });
    PREFS[p.id] = { ...p, path, hullPts: hull, adjSet: new Set(p.adj) };
    TOTAL_AREA += p.area;
  }
  const ALL_IDS = Object.keys(PREFS).map(Number);
  const [EXT_W, EXT_H] = DATA.extent;
  // whole Japan must fit in the box with margin
  const S_TOTAL = Math.min((BOX_R - BOX_L - 30) / EXT_W, (FLOOR - 150 - 40) / EXT_H);

  function scaleFor(area) {
    return S_TOTAL * Math.pow(area / TOTAL_AREA, EXP - 0.5);
  }

  // ---------- DOM ----------
  const $ = (id) => document.getElementById(id);
  const canvas = $("game");
  const ctx = canvas.getContext("2d");
  const nextCanvas = $("nextCanvas");
  const nctx = nextCanvas.getContext("2d");
  const ui = {
    score: $("score"), remain: $("remain"), nextName: $("nextName"),
    shuffleBtn: $("shuffleBtn"), toast: $("toast"),
    start: $("startScreen"), menu: $("menuScreen"), result: $("resultScreen"),
    bestNormal: $("bestNormal"), bestEasy: $("bestEasy"), resultTitle: $("resultTitle"), resultSub: $("resultSub"),
    resultScore: $("resultScore"), resultRegions: $("resultRegions"),
  };

  // ---------- storage ----------
  const store = {
    get(k, d) { try { const v = localStorage.getItem(k); return v == null ? d : JSON.parse(v); } catch { return d; } },
    set(k, v) { try { localStorage.setItem(k, JSON.stringify(v)); } catch { /* ignore */ } },
  };

  // ---------- state ----------
  let engine, world;
  let groups = [];          // live bodies (group records)
  let queue = [];
  let current = null;       // hanging piece (not in world yet)
  let aimX = W / 2;
  let canDropAt = 0;
  let score = 0;
  const best = { normal: store.get("prefpack.best.normal", store.get("prefpack.best", 0)), easy: store.get("prefpack.best.easy", 0) };
  let shuffleReadyAt = 0;
  let shufflesUsed = 0;
  let regionsDone = new Set();
  let running = false;
  let paused = false;
  let ended = false;
  let overTimer = 0;
  let idleTimer = 0;
  let combo = 0;
  let comboTimer = 0;
  let particles = [];
  let now = 0;
  let completeAt = 0;

  showBest();
  function showBest() { ui.bestNormal.textContent = best.normal; ui.bestEasy.textContent = best.easy; }

  // ---------- group creation ----------
  // A "group" is a set of prefectures rendered in true map arrangement,
  // scaled by the group's total area.
  function makeGroupGeom(members) {
    let area = 0, ox = 0, oy = 0;
    for (const id of members) {
      const p = PREFS[id];
      area += p.area; ox += p.cx * p.area; oy += p.cy * p.area;
    }
    ox /= area; oy /= area;
    const s = scaleFor(area);
    return { area, ox, oy, s };
  }

  function createGroupBody(members, x, y) {
    const geom = makeGroupGeom(members);
    const parts = [];
    for (const id of members) {
      const verts = PREFS[id].hullPts.map((v) => ({ x: x + (v.x - geom.ox) * geom.s, y: y + (v.y - geom.oy) * geom.s }));
      const c = Vertices.centre(verts);
      const part = Bodies.fromVertices(c.x, c.y, [verts], {}, false);
      parts.push(part);
    }
    const body = Body.create({
      parts,
      friction: 0.35,
      frictionStatic: 0.6,
      restitution: 0.08,
      frictionAir: 0.012,
      density: 0.0012,
    });
    const g = {
      body,
      members: new Set(members),
      geom,
      local: { x: body.position.x - x, y: body.position.y - y },
      born: now,
      droppedAt: now,
      gold: members.length === ALL_IDS.length,
    };
    body.plugin.group = g;
    return g;
  }

  function groupBoundsAt(members) {
    // bounds of a group's outline at angle 0, relative to its body position
    const geom = makeGroupGeom(members);
    let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
    for (const id of members) {
      for (const v of PREFS[id].hullPts) {
        const px = (v.x - geom.ox) * geom.s, py = (v.y - geom.oy) * geom.s;
        minX = Math.min(minX, px); maxX = Math.max(maxX, px);
        minY = Math.min(minY, py); maxY = Math.max(maxY, py);
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
      const j = (Math.random() * (i + 1)) | 0;
      [a[i], a[j]] = [a[j], a[i]];
    }
    return a;
  }

  function newGame(m) {
    if (m) mode = m;
    const M = MODES[mode];
    EXP = M.exp; LINE_Y = M.lineY; OVER_LIMIT = M.overLimit;
    engine = Engine.create({ positionIterations: 10, velocityIterations: 8 });
    engine.gravity.y = 1;
    world = engine.world;
    const opts = { isStatic: true, friction: 0.5, restitution: 0.05 };
    Composite.add(world, [
      Bodies.rectangle(W / 2, FLOOR + 50, W + 200, 100, opts),
      Bodies.rectangle(BOX_L - 50, H / 2 - 200, 100, H + 400, opts),
      Bodies.rectangle(BOX_R + 50, H / 2 - 200, 100, H + 400, opts),
    ]);
    Events.on(engine, "collisionStart", onCollide);
    Events.on(engine, "collisionActive", onCollide);

    groups = [];
    queue = shuffleArray(ALL_IDS.slice());
    score = 0;
    shuffleReadyAt = 0;
    shufflesUsed = 0;
    regionsDone = new Set();
    overTimer = 0;
    idleTimer = 0;
    combo = 0;
    particles = [];
    ended = false;
    paused = false;
    completeAt = 0;
    current = null;
    nextPiece();
    updateHud();
    running = true;
  }

  function nextPiece() {
    if (!queue.length) { current = null; drawNext(); return; }
    const id = queue.shift();
    const bb = groupBoundsAt([id]);
    current = { id, bb };
    if (MODES[mode].neighbor) arrangeNeighborNext();
    aimX = clampAim(aimX);
    drawNext();
  }

  // かんたんモード: 次の県を、箱の中か今の県のおとなりから選びやすくする
  function arrangeNeighborNext() {
    if (queue.length < 2 || Math.random() > 0.8) return;
    const placed = new Set(current ? [current.id] : []);
    for (const g of groups) for (const id of g.members) placed.add(id);
    const cands = [];
    queue.forEach((id, i) => { for (const p of placed) if (PREFS[id].adjSet.has(p)) { cands.push(i); break; } });
    if (!cands.length) return;
    const i = cands[(Math.random() * cands.length) | 0];
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
    // match hang position: body center vs map origin
    Body.setPosition(g.body, { x: aimX + g.local.x, y: HANG_Y + g.local.y });
    keepInside(g.body);
    Body.setVelocity(g.body, { x: 0, y: 2 });
    g.droppedAt = now;
    Composite.add(world, g.body);
    groups.push(g);
    canDropAt = now + DROP_COOLDOWN;
    current = null;
    vibrate(8);
    updateHud();
    setTimeout(() => { if (running && !ended) { nextPiece(); updateHud(); } }, DROP_COOLDOWN);
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
      const adj = PREFS[id].adjSet;
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
    Composite.add(world, g.body);
    groups.push(g);

    // score & effects
    combo = now - comboTimer < 900 ? combo + 1 : 1;
    comboTimer = now;
    const gained = 10 * members.length * combo;
    score += gained;
    burst(g.body.position.x, g.body.position.y, members.length);
    vibrate(members.length > 10 ? 30 : 15);
    if (combo >= 2) toast(`${combo} コンボ！`);
    checkRegions(g);
    if (g.gold) completeJapan(g);
    updateHud();
  }

  function checkRegions(g) {
    DATA.regionMembers.forEach((ids, ri) => {
      if (regionsDone.has(ri)) return;
      if (ri === 0) return; // 北海道は1県なので地方ボーナスなし
      if (ids.every((id) => g.members.has(id))) {
        regionsDone.add(ri);
        score += 300;
        toast(`${DATA.regions[ri]}地方 そろった！ +300`, true);
      }
    });
  }

  function completeJapan(g) {
    const bonus = 3000 + Math.max(0, 10 - shufflesUsed) * 100;
    score += bonus;
    completeAt = now;
    toast("日本列島 完成！！", true);
    vibrate([40, 60, 40, 60, 120]);
    for (let i = 0; i < 6; i++) setTimeout(() => burst(W / 2 + (Math.random() - 0.5) * 300, 200 + Math.random() * 300, 20, true), i * 180);
    setTimeout(() => endGame(true), 2600);
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
    idleTimer = 0;
    vibrate(25);
    updateHud();
  }

  // ---------- end ----------
  function endGame(cleared) {
    if (ended) return;
    ended = true;
    running = false;
    if (score > best[mode]) { best[mode] = score; store.set(`prefpack.best.${mode}`, score); }
    showBest();
    ui.resultTitle.textContent = cleared ? "日本列島 完成！" : "ゲームオーバー";
    const left = groups.length + (current ? 1 : 0) + queue.length;
    ui.resultSub.textContent = `【${MODES[mode].name}】` + (cleared
      ? "47 都道府県がひとつにつながった！"
      : `のこり ${left} かたまり`);
    ui.resultScore.textContent = score;
    ui.resultRegions.innerHTML = "";
    DATA.regions.forEach((name, ri) => {
      if (ri === 0) return;
      const s = document.createElement("span");
      s.textContent = name;
      if (regionsDone.has(ri) || cleared) { s.classList.add("done"); s.style.background = REGION_STROKE[ri]; }
      ui.resultRegions.appendChild(s);
    });
    setTimeout(() => ui.result.classList.remove("hidden"), cleared ? 0 : 600);
  }

  // ---------- update ----------
  let shake = 0;
  function update(dt) {
    Engine.update(engine, dt);
    processMerges();

    // overflow check
    let danger = false;
    for (const g of groups) {
      if (now - g.droppedAt < 1500) continue;
      const sp = Math.hypot(g.body.velocity.x, g.body.velocity.y);
      if (g.body.bounds.min.y < LINE_Y && sp < 1.5) { danger = true; break; }
    }
    overTimer = danger ? overTimer + dt : Math.max(0, overTimer - dt * 2);
    if (overTimer > OVER_LIMIT && !completeAt) endGame(false);

    // shuffle button cooldown
    const shuffleReady = now >= shuffleReadyAt;
    if (ui.shuffleBtn.disabled === shuffleReady) ui.shuffleBtn.disabled = !shuffleReady;

    for (const p of particles) {
      p.x += p.vx; p.y += p.vy; p.vy += 0.25; p.life -= dt;
    }
    particles = particles.filter((p) => p.life > 0);
    if (shake > 0) shake *= 0.85;
    if (shake < 0.3) shake = 0;
  }

  // ---------- rendering ----------
  let dpr = 1, viewScale = 1;
  function resize() {
    const stage = $("stage");
    const r = stage.getBoundingClientRect();
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
    // inside
    ctx.fillStyle = "#fffaf1";
    roundRect(ctx, BOX_L, 0, BOX_R - BOX_L, FLOOR, 0);
    ctx.fill();
    // subtle grid
    ctx.strokeStyle = "rgba(201,164,107,.12)";
    ctx.lineWidth = 1;
    ctx.beginPath();
    for (let x = BOX_L + 40; x < BOX_R; x += 40) { ctx.moveTo(x, 0); ctx.lineTo(x, FLOOR); }
    for (let y = FLOOR - 40; y > 0; y -= 40) { ctx.moveTo(BOX_L, y); ctx.lineTo(BOX_R, y); }
    ctx.stroke();
    // walls
    ctx.fillStyle = "#c9a46b";
    ctx.fillRect(0, 0, WALL, H);
    ctx.fillRect(W - WALL, 0, WALL, H);
    ctx.fillRect(0, FLOOR, W, WALL);
    ctx.fillStyle = "#9c7a45";
    ctx.fillRect(0, H - 4, W, 4);
    // overflow line
    const d = Math.min(1, overTimer / OVER_LIMIT);
    ctx.save();
    ctx.setLineDash([8, 7]);
    ctx.lineWidth = 2 + d * 2;
    const pulse = d > 0 ? 0.5 + 0.5 * Math.sin(now / 90) : 0;
    ctx.strokeStyle = d > 0 ? `rgba(232,93,74,${0.55 + 0.45 * pulse})` : "rgba(156,122,69,.45)";
    ctx.beginPath();
    ctx.moveTo(BOX_L, LINE_Y);
    ctx.lineTo(BOX_R, LINE_Y);
    ctx.stroke();
    ctx.restore();
  }

  function drawGroupShapes(c, members, geom, gold, alpha = 1) {
    // assumes transform: map km -> world already applied
    c.globalAlpha = alpha;
    const lw = 1.6 / geom.s;
    for (const id of members) {
      const p = PREFS[id];
      if (gold) {
        const gr = c.createLinearGradient(0, 0, EXT_W, EXT_H);
        gr.addColorStop(0, "#fbe38a");
        gr.addColorStop(0.5, "#e8b931");
        gr.addColorStop(1, "#f6d260");
        c.fillStyle = gr;
      } else {
        c.fillStyle = REGION_COLORS[p.region];
      }
      c.fill(p.path);
    }
    c.lineJoin = "round";
    c.lineWidth = lw;
    for (const id of members) {
      const p = PREFS[id];
      c.strokeStyle = gold ? "#b0861a" : REGION_STROKE[p.region];
      c.stroke(p.path);
    }
    c.globalAlpha = 1;
  }

  function groupTransform(g) {
    const b = g.body;
    const pop = Math.max(0, 1 - (now - g.born) / 260);
    const k = 1 + 0.14 * Math.sin(pop * Math.PI) ;
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
      const p = PREFS[id];
      const size = geom.s * Math.sqrt(p.area);
      if (size < 22) continue;
      const fs = Math.max(8, Math.min(15, size * 0.24));
      const w = toWorld(p.cx, p.cy);
      ctx.font = `800 ${fs}px "M PLUS Rounded 1c", sans-serif`;
      ctx.lineWidth = 3;
      ctx.strokeStyle = gold ? "rgba(255,240,180,.9)" : "rgba(255,255,255,.85)";
      ctx.strokeText(p.short, w.x, w.y);
      ctx.fillStyle = gold ? "#5a3f00" : "#3b3226";
      ctx.fillText(p.short, w.x, w.y);
    }
  }

  function render() {
    const s = viewScale * dpr;
    ctx.setTransform(s, 0, 0, s, 0, 0);
    ctx.clearRect(0, 0, W, H);
    if (shake) ctx.translate((Math.random() - 0.5) * shake, (Math.random() - 0.5) * shake * 0.5);
    drawBox();

    // groups
    const hintId = MODES[mode].hint && current && !ended ? current.id : null;
    for (const g of groups) {
      ctx.save();
      const hinted = hintId != null && [...g.members].some((id) => PREFS[hintId].adjSet.has(id));
      // soft shadow (かんたんモード: くっつけるかたまりを光らせる)
      if (hinted) {
        ctx.shadowColor = "rgba(255,190,40,.95)";
        ctx.shadowBlur = 14 + 8 * Math.sin(now / 180);
        ctx.shadowOffsetY = 0;
      } else {
        ctx.shadowColor = g.gold ? "rgba(232,185,49,.8)" : "rgba(59,50,38,.18)";
        ctx.shadowBlur = g.gold ? 24 + 8 * Math.sin(now / 200) : 6;
        ctx.shadowOffsetY = g.gold ? 0 : 2;
      }
      groupTransform(g);
      drawGroupShapes(ctx, g.members, g.geom, g.gold);
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

    // hanging piece + guide
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

    // particles
    for (const p of particles) {
      ctx.globalAlpha = Math.max(0, p.life / p.max);
      ctx.fillStyle = p.color;
      ctx.beginPath();
      ctx.arc(p.x, p.y, p.r, 0, Math.PI * 2);
      ctx.fill();
    }
    ctx.globalAlpha = 1;
  }

  function drawNext() {
    const c = nctx;
    c.setTransform(1, 0, 0, 1, 0, 0);
    c.clearRect(0, 0, nextCanvas.width, nextCanvas.height);
    const id = queue[0];
    ui.nextName.textContent = id ? PREFS[id].short : "—";
    if (!id) return;
    const p = PREFS[id];
    let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
    for (let i = 0; i < p.poly.length; i += 2) {
      minX = Math.min(minX, p.poly[i]); maxX = Math.max(maxX, p.poly[i]);
      minY = Math.min(minY, p.poly[i + 1]); maxY = Math.max(maxY, p.poly[i + 1]);
    }
    const size = nextCanvas.width;
    const k = (size * 0.84) / Math.max(maxX - minX, maxY - minY);
    c.translate(size / 2, size / 2);
    c.scale(k, k);
    c.translate(-(minX + maxX) / 2, -(minY + maxY) / 2);
    drawGroupShapes(c, [id], { s: k / 1.4 }, false);
  }

  // ---------- effects ----------
  function burst(x, y, n, gold) {
    const count = Math.min(40, 8 + n * 2);
    for (let i = 0; i < count; i++) {
      const a = Math.random() * Math.PI * 2, sp = 2 + Math.random() * 5;
      const max = 500 + Math.random() * 500;
      particles.push({
        x, y, vx: Math.cos(a) * sp, vy: Math.sin(a) * sp - 2,
        r: 2 + Math.random() * 3, life: max, max,
        color: gold ? ["#f7d35c", "#e8b931", "#fff3c4"][i % 3] : ["#f5ae62", "#f29abf", "#86cfb0", "#7fb7e8"][i % 4],
      });
    }
  }

  let toastTimer = 0;
  function toast(msg, gold) {
    ui.toast.textContent = msg;
    ui.toast.classList.toggle("gold", !!gold);
    ui.toast.classList.add("show");
    clearTimeout(toastTimer);
    toastTimer = setTimeout(() => ui.toast.classList.remove("show"), 1500);
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
    r = Math.round(r * (1 + amt)); g = Math.round(g * (1 + amt)); b = Math.round(b * (1 + amt));
    const cl = (v) => Math.max(0, Math.min(255, v));
    return `rgb(${cl(r)},${cl(g)},${cl(b)})`;
  }
  function roundRect(c, x, y, w, h, r) {
    c.beginPath();
    c.moveTo(x + r, y);
    c.arcTo(x + w, y, x + w, y + h, r);
    c.arcTo(x + w, y + h, x, y + h, r);
    c.arcTo(x, y + h, x, y, r);
    c.arcTo(x, y, x + w, y, r);
    c.closePath();
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
    if (!running) return;
    if (e.key === "ArrowLeft") aimX = clampAim(aimX - 12);
    if (e.key === "ArrowRight") aimX = clampAim(aimX + 12);
    if (e.key === " " || e.key === "ArrowDown") { e.preventDefault(); drop(); }
    if (e.key === "s") doShuffle();
  });

  ui.shuffleBtn.addEventListener("click", doShuffle);
  $("startBtn").addEventListener("click", () => {
    ui.start.classList.add("hidden");
    newGame("normal");
  });
  $("startEasyBtn").addEventListener("click", () => {
    ui.start.classList.add("hidden");
    newGame("easy");
  });
  const toTitle = () => {
    running = false; ended = true; engine = null; groups = []; current = null;
    ui.menu.classList.add("hidden");
    ui.result.classList.add("hidden");
    ui.start.classList.remove("hidden");
    score = 0; queue = ALL_IDS.slice(); updateHud();
  };
  $("titleBtn").addEventListener("click", toTitle);
  $("resultTitleBtn").addEventListener("click", toTitle);
  $("menuBtn").addEventListener("click", () => {
    if (!running) return;
    paused = true;
    ui.menu.classList.remove("hidden");
  });
  $("resumeBtn").addEventListener("click", () => {
    paused = false;
    ui.menu.classList.add("hidden");
  });
  $("restartBtn").addEventListener("click", () => {
    ui.menu.classList.add("hidden");
    newGame();
  });
  $("againBtn").addEventListener("click", () => {
    ui.result.classList.add("hidden");
    newGame();
  });
  document.addEventListener("visibilitychange", () => {
    if (document.hidden && running && !ended) { paused = true; ui.menu.classList.remove("hidden"); }
  });

  // ---------- loop ----------
  const STEP = 1000 / 60;
  let last = performance.now(), acc = 0;
  function frame(t) {
    const dt = Math.min(100, t - last);
    last = t;
    if (engine && !paused && (running || completeAt)) {
      acc += dt;
      let n = 0;
      while (acc >= STEP && n < 4) { now += STEP; update(STEP); acc -= STEP; n++; }
      if (n === 4) acc = 0;
    }
    if (engine) render();
    else renderIdle(t);
    requestAnimationFrame(frame);
  }

  // title background: the whole Japan in gold, gently bobbing
  function renderIdle(t) {
    const s = viewScale * dpr;
    ctx.setTransform(s, 0, 0, s, 0, 0);
    ctx.clearRect(0, 0, W, H);
    drawBox();
    ctx.save();
    ctx.translate(W / 2, (LINE_Y + FLOOR) / 2 + Math.sin(t / 700) * 4);
    ctx.scale(S_TOTAL, S_TOTAL);
    ctx.translate(-EXT_W / 2, -EXT_H / 2);
    ctx.shadowColor = "rgba(232,185,49,.6)";
    ctx.shadowBlur = 20;
    drawGroupShapes(ctx, ALL_IDS, { s: S_TOTAL }, false);
    ctx.restore();
  }

  window.addEventListener("resize", resize);
  resize();
  requestAnimationFrame(frame);

  // expose for debugging / tests
  window.__prefpack = {
    get state() { return { mode, score, groups: groups.length, queue: queue.length, current: current && current.id, ended, shufflesUsed, regionsDone: [...regionsDone] }; },
    newGame, drop, doShuffle, setAim: (x) => { aimX = clampAim(x); },
    fastForward(ms) { const n = Math.round(ms / STEP); for (let i = 0; i < n && !ended; i++) { now += STEP; update(STEP); } },
    skipCooldown() { canDropAt = 0; shuffleReadyAt = 0; if (!current) nextPiece(); },
    S_TOTAL, scaleFor, TOTAL_AREA,
  };
})();
