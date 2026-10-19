/* 都道府県ゲーム — みんなで対戦（Firebase Realtime Database）
 *
 * データの置き場所: rooms/pref-<4ケタ>   （おでこでお題当て と同じデータベースを共用。キーに pref- を付けて区別）
 *   game: "pref", created, host, mode, seed, state: "lobby" | "playing", round, startAt
 *   players/<pid>: name, joined, online, round, status, score, left, board, lineDown, finishAt
 *   ev/<id>: from, name, type: "line", region, round, t     ← おじゃま（相手のあふれ線を下げる）
 */
(() => {
  "use strict";

  const FIREBASE_CONFIG = {
    apiKey: "AIzaSyARjb_t0hEpQKM_6Wmbzl_H7z-e7rMcKjY",
    authDomain: "odeko-ddb38.firebaseapp.com",
    databaseURL: "https://odeko-ddb38-default-rtdb.asia-southeast1.firebasedatabase.app",
    projectId: "odeko-ddb38",
    storageBucket: "odeko-ddb38.firebasestorage.app",
    messagingSenderId: "310865503380",
    appId: "1:310865503380:web:fb1c2b173cb6fbee70c081",
  };
  const FIREBASE_VER = "10.12.2";
  const KEY = (code) => `rooms/pref-${code}`;
  const CKEY = (code) => `rooms/pref-${code}-coop`;   // 協力モードの箱の状態・操作（部屋本体とは別にして通信を軽く）
  const COOP_EVERY = 120;
  const ATTACK_MS = 10000;
  const LIVE_EVERY = 1000;
  const ROOM_TTL = 24 * 60 * 60 * 1000;
  const REGIONS = window.PREF_DATA.regions;
  const STAGE_NAMES = { japan: "日本", asia: "アジア", europe: "ヨーロッパ", africa: "アフリカ", world: "世界", both: "日本→アジア", all: "ぜんぶ（日本→世界）" };
  const STAGE_ORDER = ["japan", "asia", "europe", "africa", "world", "both", "all"];
  const firstStage = (st) => (st === "both" || st === "all" ? "japan" : st || "japan");
  const isChain = (st) => st === "both" || st === "all";

  const $ = (id) => document.getElementById(id);
  const G = () => window.PrefGame;

  // ---------- identity ----------
  const ls = {
    get(k) { try { return localStorage.getItem(k); } catch { return null; } },
    set(k, v) { try { localStorage.setItem(k, v); } catch { /* ignore */ } },
  };
  const ss = {
    get(k) { try { return sessionStorage.getItem(k); } catch { return null; } },
    set(k, v) { try { v == null ? sessionStorage.removeItem(k) : sessionStorage.setItem(k, v); } catch { /* ignore */ } },
  };
  const PID = window.PID_OVERRIDE || (() => {
    let p = ls.get("pref_pid");
    if (!p) { p = Math.random().toString(36).slice(2, 10) + Date.now().toString(36); ls.set("pref_pid", p); }
    return p;
  })();
  // おでこでお題当て と同じサイトなので、そちらで入れた名前があれば使う
  const myName = () => ls.get("pref_name") || ls.get("odeko_name") || "";
  const saveName = (v) => ls.set("pref_name", v);

  // ---------- network ----------
  let NET = null;
  let netPromise = null;

  function loadScript(src) {
    return new Promise((ok, ng) => {
      const s = document.createElement("script");
      s.src = src; s.onload = ok; s.onerror = ng;
      document.head.appendChild(s);
    });
  }

  function firebaseNet() {
    firebase.initializeApp(FIREBASE_CONFIG);
    const db = firebase.database();
    let offset = 0;
    db.ref(".info/serverTimeOffset").on("value", (s) => { offset = s.val() || 0; });
    return {
      on(path, cb) { const r = db.ref(path), h = (s) => cb(s.val()); r.on("value", h); return () => r.off("value", h); },
      get(path) { return db.ref(path).once("value").then((s) => s.val()); },
      set(path, v) { return db.ref(path).set(v); },
      update(path, v) { return db.ref(path).update(v); },
      remove(path) { return db.ref(path).remove(); },
      tx(path, fn) { return db.ref(path).transaction(fn).then((r) => ({ committed: r.committed, val: r.snapshot.val() })); },
      now() { return Date.now() + offset; },
      onConnected(cb) { db.ref(".info/connected").on("value", (s) => cb(!!s.val())); },
      onDisconnectSet(path, v) { return db.ref(path).onDisconnect().set(v); },
      cancelDisconnect(path) { return db.ref(path).onDisconnect().cancel(); },
      // 子要素 child の大きい順に n 件
      top(path, child, n) {
        return db.ref(path).orderByChild(child).limitToLast(n).once("value").then((snap) => {
          const out = [];
          snap.forEach((c) => { out.push({ id: c.key, ...c.val() }); });
          return out.sort((a, b) => (b[child] || 0) - (a[child] || 0));
        });
      },
      // 古くなった対戦部屋（pref- で始まるもの）だけを消す
      cleanOld(cutoff) {
        return db.ref("rooms").orderByChild("created").endAt(cutoff).limitToFirst(30).once("value").then((snap) => {
          const jobs = [];
          snap.forEach((c) => { const v = c.val(); if (String(c.key).startsWith("pref-") && v && v.created <= cutoff) jobs.push(c.ref.remove()); });
          return Promise.all(jobs);
        });
      },
    };
  }

  function ensureNet() {
    if (NET) return Promise.resolve(true);
    if (window.NET_OVERRIDE) { NET = window.NET_OVERRIDE; return Promise.resolve(true); } // テスト用
    if (!netPromise) {
      const base = `https://www.gstatic.com/firebasejs/${FIREBASE_VER}/`;
      const timeout = new Promise((_, ng) => setTimeout(() => ng(new Error("timeout")), 10000));
      netPromise = Promise.race([loadScript(base + "firebase-app-compat.js").then(() => loadScript(base + "firebase-database-compat.js")), timeout])
        .then(() => {
          NET = firebaseNet();
          NET.onConnected((ok) => { connected = ok; renderConnection(); });
          return true;
        })
        .catch(() => { netPromise = null; return false; });
    }
    return netPromise;
  }
  let connected = true;

  function netError(e) {
    console.warn(e);
    const msg = String((e && (e.code || e.message)) || e);
    if (/permission/i.test(msg)) return "データベースに書きこめませんでした（Firebase のルール設定を確認してね）";
    return "通信できませんでした。電波のよい所でもう一度ためしてね";
  }

  // ---------- screens ----------
  const OVERLAYS = ["startScreen", "menuScreen", "resultScreen", "rankScreen", "mpCreate", "mpJoin", "mpLobby", "mpResult"];
  function show(id) {
    OVERLAYS.forEach((o) => $(o).classList.toggle("hidden", o !== id));
  }
  function hideAll() { show(null); }
  function msg(id, text, info) {
    const el = $(id);
    el.textContent = text || "";
    el.classList.toggle("info", !!info);
  }
  function esc(s) { return String(s == null ? "" : s).replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c])); }

  // ---------- state ----------
  let code = null;       // 4ケタ
  let R = null;          // 最新の部屋データ
  let unsub = null;
  let myRound = -1;      // 自分が遊んでいる回
  let finished = false;
  let seenEv = new Set();
  let liveTimer = null;
  let countdownTimer = null;
  let createMode = "normal";
  let createStage = "japan";
  let createPlay = "vs";
  const isCoop = () => !!R && R.play === "coop";

  const me = () => (R && R.players && R.players[PID]) || null;
  const isHost = () => !!R && R.host === PID;
  const participants = () => {
    if (!R || !R.players) return [];
    return Object.entries(R.players)
      .filter(([, p]) => p && p.round === R.round)
      .map(([id, p]) => ({ id, ...p }));
  };
  const inviteUrl = () => `${location.origin}${location.pathname}?room=${code}`;

  // ---------- create / join ----------
  $("mpCreateBtn").addEventListener("click", () => {
    $("mpNameC").value = myName();
    msg("mpCreateMsg", "");
    show("mpCreate");
    ensureNet();
  });
  $("mpJoinBtn").addEventListener("click", () => openJoin(""));
  function openJoin(c) {
    $("mpCode").value = c || "";
    $("mpNameJ").value = myName();
    msg("mpJoinMsg", "");
    show("mpJoin");
    ensureNet();
  }
  document.querySelectorAll("[data-back]").forEach((b) => b.addEventListener("click", () => show("startScreen")));
  $("mpModeSeg").addEventListener("click", (e) => {
    const b = e.target.closest("button[data-mode]");
    if (!b) return;
    createMode = b.dataset.mode;
    $("mpModeSeg").querySelectorAll("button").forEach((x) => x.classList.toggle("on", x === b));
  });
  $("mpCode").addEventListener("input", (e) => { e.target.value = e.target.value.replace(/\D/g, "").slice(0, 4); });

  async function busy(btn, fn) {
    if (btn.disabled) return;
    btn.disabled = true;
    try { await fn(); } finally { btn.disabled = false; }
  }

  $("mpCreateGo").addEventListener("click", (e) => busy(e.currentTarget, async () => {
    const name = $("mpNameC").value.trim().slice(0, 10);
    if (!name) { msg("mpCreateMsg", "なまえを入れてね"); return; }
    saveName(name);
    msg("mpCreateMsg", "つないでいます…", true);
    if (!(await ensureNet())) { msg("mpCreateMsg", netError("timeout")); return; }
    try {
      NET.cleanOld && NET.cleanOld(NET.now() - ROOM_TTL).catch(() => {});
      for (let i = 0; i < 12; i++) {
        const c = String(Math.floor(Math.random() * 10000)).padStart(4, "0");
        const t = NET.now();
        const room = {
          game: "pref", created: t, host: PID, mode: createMode, stage: createStage, play: createPlay, seed: Math.random().toString(36).slice(2, 10),
          state: "lobby", round: 0,
          players: { [PID]: { name, joined: t, online: true } },
        };
        const r = await NET.tx(KEY(c), (cur) => (cur ? undefined : room));
        if (r.committed) { await enterRoom(c); return; }
      }
      msg("mpCreateMsg", "部屋を作れませんでした。もう一度ためしてね");
    } catch (err) { msg("mpCreateMsg", netError(err)); }
  }));

  $("mpJoinGo").addEventListener("click", (e) => busy(e.currentTarget, async () => {
    const c = $("mpCode").value.trim();
    const name = $("mpNameJ").value.trim().slice(0, 10);
    if (!/^\d{4}$/.test(c)) { msg("mpJoinMsg", "4ケタの部屋番号を入れてね"); return; }
    if (!name) { msg("mpJoinMsg", "なまえを入れてね"); return; }
    saveName(name);
    msg("mpJoinMsg", "さがしています…", true);
    if (!(await ensureNet())) { msg("mpJoinMsg", netError("timeout")); return; }
    try {
      const room = await NET.get(KEY(c));
      if (!room || room.game !== "pref") { msg("mpJoinMsg", "その番号の部屋は見つかりませんでした"); return; }
      const prev = room.players && room.players[PID];
      await NET.update(`${KEY(c)}/players/${PID}`, { name, joined: prev && prev.joined ? prev.joined : NET.now(), online: true });
      await enterRoom(c);
    } catch (err) { msg("mpJoinMsg", netError(err)); }
  }));

  async function enterRoom(c) {
    code = c;
    msg("mpJoinMsg", ""); msg("mpCreateMsg", "");
    ss.set("pref_room", c);
    myRound = -1;
    R = null;
    const onlinePath = `${KEY(c)}/players/${PID}/online`;
    try { NET.onDisconnectSet && NET.onDisconnectSet(onlinePath, false); } catch { /* ignore */ }
    if (unsub) unsub();
    unsub = NET.on(KEY(c), onRoom);
  }

  // ---------- room updates ----------
  function onRoom(v) {
    if (code == null) return;
    if (!v || v.game !== "pref") { leaveLocal("部屋がなくなりました"); return; }
    R = v;
    const mine = me();
    if (!mine) {
      // 消えていたら入り直す
      NET.update(`${KEY(code)}/players/${PID}`, { name: myName() || "ゲスト", joined: NET.now(), online: true }).catch(() => {});
      return;
    }
    if (mine.online === false && connected) NET.set(`${KEY(code)}/players/${PID}/online`, true).catch(() => {});
    maybeTakeHost();

    if (v.state === "playing" && mine.round === v.round) {
      if (myRound !== v.round) startRound();
      handleEvents();
      if (isCoop()) {
        coopOnRoom();
        if (finished) renderResult();
      } else {
        checkLastPlace();
        checkWinner();
        renderRivals();
        if (finished) renderResult();
      }
    } else {
      // 待合室（開始前、または途中参加で次の回待ち）
      if (myRound !== -1 && v.state === "lobby") stopPlaying();
      renderLobby();
      if (!isOpen("mpLobby") && !isOpen("menuScreen")) show("mpLobby");
    }
  }
  const isOpen = (id) => !$(id).classList.contains("hidden");

  // ホストがいなくなったら、いちばん早く入った人がホストになる
  function maybeTakeHost() {
    const ps = R.players || {};
    const h = ps[R.host];
    if (h && h.online !== false) return;
    const cands = Object.entries(ps).filter(([, p]) => p && p.online !== false).sort((a, b) => (a[1].joined || 0) - (b[1].joined || 0));
    if (cands.length && cands[0][0] === PID) {
      const old = R.host;
      NET.tx(`${KEY(code)}/host`, (cur) => (cur === old || cur == null ? PID : undefined)).catch(() => {});
    }
  }

  // ---------- lobby ----------
  let qrFor = null;
  function renderLobby() {
    $("mpTiles").innerHTML = code.split("").map((d) => `<div class="tile">${d}</div>`).join("");
    if (qrFor !== code) {
      qrFor = code;
      try {
        const q = qrcode(0, "M");
        q.addData(inviteUrl());
        q.make();
        $("mpQr").innerHTML = q.createSvgTag({ cellSize: 4, margin: 1, scalable: true });
      } catch { $("mpQr").innerHTML = ""; }
    }
    const modeName = (G().MODES[R.mode] || G().MODES.normal).name;
    const canEdit = isHost() && R.state === "lobby";
    $("mpLobbyMode").textContent = `モード：${modeName}` + (canEdit ? "（タップで切りかえ）" : "");
    $("mpLobbyMode").style.cursor = canEdit ? "pointer" : "";
    $("mpLobbyStage").textContent = `ステージ：${STAGE_NAMES[R.stage || "japan"]}`;
    $("mpLobbyStageGrid").style.display = canEdit ? "" : "none";
    $("mpLobbyStageGrid").querySelectorAll("button").forEach((b) => b.classList.toggle("on", b.dataset.stage === (R.stage || "japan")));
    $("mpLobbyPlay").textContent = `あそびかた：${isCoop() ? "協力（みんなで1つの箱）" : "対戦"}` + (canEdit ? "（タップで切りかえ）" : "");
    $("mpLobbyPlay").style.cursor = canEdit ? "pointer" : "";


    const ps = Object.entries(R.players || {}).sort((a, b) => (a[1].joined || 0) - (b[1].joined || 0));
    $("mpPlayers").innerHTML = ps.map(([id, p]) => {
      const tags = [];
      if (id === R.host) tags.push("ホスト");
      if (R.state === "playing" && p.round === R.round) tags.push(statusText(p));
      if (p.online === false) tags.push("通信切れ");
      return `<li class="${p.online === false ? "off" : ""}"><span class="dot"></span>${esc(p.name)}${id === PID ? "（あなた）" : ""}<span class="tag">${esc(tags.join("・"))}</span></li>`;
    }).join("");

    const online = ps.filter(([, p]) => p.online !== false).length;
    const startBtn = $("mpStart");
    if (R.state === "playing") {
      startBtn.style.display = "none";
      msg("mpLobbyMsg", isCoop() ? "いま協力プレイ中です。次の回から参加できます" : "いま対戦中です。次の回から参加できます", true);
    } else if (isHost()) {
      startBtn.style.display = "";
      msg("mpLobbyMsg", online < 2 ? "相手が入ってくるのを待とう（ひとりでも始められます）" : `${online}人そろったらスタート！`, true);
    } else {
      startBtn.style.display = "none";
      msg("mpLobbyMsg", "ホストがスタートするのを待っています…", true);
    }
  }

  $("mpLobbyMode").addEventListener("click", () => {
    if (!isHost() || !R || R.state !== "lobby") return;
    NET.set(`${KEY(code)}/mode`, R.mode === "easy" ? "normal" : "easy").catch(() => {});
  });
  $("mpLobbyStageGrid").addEventListener("click", (e) => {
    const b = e.target.closest("button[data-stage]");
    if (!b || !isHost() || !R || R.state !== "lobby") return;
    NET.set(`${KEY(code)}/stage`, b.dataset.stage).catch(() => {});
  });
  $("mpPlaySeg").addEventListener("click", (e) => {
    const b = e.target.closest("button[data-play]");
    if (!b) return;
    createPlay = b.dataset.play;
    $("mpPlaySeg").querySelectorAll("button").forEach((x) => x.classList.toggle("on", x === b));
  });
  $("mpLobbyPlay").addEventListener("click", () => {
    if (!isHost() || !R || R.state !== "lobby") return;
    NET.set(`${KEY(code)}/play`, isCoop() ? "vs" : "coop").catch(() => {});
  });
  $("mpStageSeg").addEventListener("click", (e) => {
    const b = e.target.closest("button[data-stage]");
    if (!b) return;
    createStage = b.dataset.stage;
    $("mpStageSeg").querySelectorAll("button").forEach((x) => x.classList.toggle("on", x === b));
  });

  $("mpShare").addEventListener("click", async () => {
    const url = inviteUrl();
    const text = `都道府県ゲームで対戦しよう！ 部屋番号 ${code}`;
    try {
      if (navigator.share) { await navigator.share({ title: "都道府県ゲーム", text, url }); return; }
    } catch { return; }
    try { await navigator.clipboard.writeText(`${text}\n${url}`); G().toast("招待リンクをコピーしました"); }
    catch { prompt("このリンクを送ってね", url); }
  });

  // ---------- start a round (host) ----------
  async function startRoundAsHost(btn) {
    if (!isHost() || !R) return;
    await busy(btn, async () => {
      const round = (R.round || 0) + 1;
      const up = {
        state: "playing", round, seed: Math.random().toString(36).slice(2, 10),
        startAt: NET.now() + 3600, ev: null,
      };
      for (const [id, p] of Object.entries(R.players || {})) {
        if (!p || p.online === false) continue;
        up[`players/${id}/round`] = round;
        up[`players/${id}/status`] = "playing";
        up[`players/${id}/score`] = 0;
        up[`players/${id}/left`] = null;
        up[`players/${id}/stage`] = firstStage(R.stage);
        up[`players/${id}/board`] = null;
        up[`players/${id}/lineDown`] = false;
        up[`players/${id}/finishAt`] = null;
      }
      up.coopResult = null;
      try {
        if (R.play === "coop") await NET.set(CKEY(code), { created: NET.now() });
        await NET.update(KEY(code), up);
      } catch (err) { G().toast(netError(err)); }
    });
  }
  $("mpStart").addEventListener("click", (e) => startRoundAsHost(e.currentTarget));
  $("mpAgain").addEventListener("click", (e) => startRoundAsHost(e.currentTarget));

  // ---------- playing ----------
  function startRound() {
    myRound = R.round;
    finished = false;
    seenEv = new Set(Object.keys(R.ev || {}));
    hideAll();
    document.body.classList.add("in-match");
    $("stampBar").classList.add("hidden");
    $("rivals").innerHTML = "";
    $("rivals").dataset.sig = "";
    $("rivals").classList.remove("hidden");
    if (isCoop()) renderCoopBar(); else renderRivals();
    window.dispatchEvent(new Event("resize"));
    const mode = R.mode, stage = R.stage || "japan", seed = `${R.seed}:${R.round}`, startAt = R.startAt || 0;
    const cd = $("countdown");
    clearInterval(countdownTimer);
    let lastShown = null;
    const tick = () => {
      const left = startAt - NET.now();
      if (left <= 0) {
        clearInterval(countdownTimer);
        cd.textContent = "スタート！";
        cd.style.fontSize = "56px";
        setTimeout(() => cd.classList.add("hidden"), 600);
        if (isCoop()) { startCoopRound(mode, seed, stage); return; }
        G().start(mode, seed, hooks, stage);
        clearInterval(liveTimer);
        liveTimer = setInterval(pushLive, LIVE_EVERY);
        pushLive();
        return;
      }
      const n = Math.ceil(left / 1000);
      if (n !== lastShown) {
        lastShown = n;
        cd.style.fontSize = "";
        cd.textContent = n;
        cd.classList.remove("hidden", "pop");
        void cd.offsetWidth;
        cd.classList.add("pop");
      }
    };
    countdownTimer = setInterval(tick, 100);
    tick();
  }

  const hooks = {
    onRegion(ri, rname) {
      if (!code) return;
      const id = NET.now().toString(36) + Math.random().toString(36).slice(2, 6);
      NET.set(`${KEY(code)}/ev/${id}`, { from: PID, name: myName() || "だれか", type: "line", region: ri, rname: rname || "", round: myRound, t: NET.now() }).catch(() => {});
    },
    onStage() { pushLive(); },
    // 自分が完成させた時点で、ほかにまだ完成した人がいなければ1位
    amFirst() { return !participants().some((p) => p.id !== PID && p.status === "clear"); },
    onEnd(cleared, _score, extra) {
      finished = true;
      clearInterval(liveTimer);
      pushLive(cleared ? "clear" : extra && extra.winner ? "win" : "over");
      setTimeout(() => { if (finished && code) { renderResult(); show("mpResult"); } }, cleared ? 0 : 700);
    },
  };

  function pushLive(finalStatus) {
    if (!code || myRound < 0) return;
    const info = G().info;
    const up = {
      score: info.score,
      left: info.left,
      board: JSON.stringify(G().snapshot()),
      stage: info.stage,
      lineDown: !!info.lineDown,
    };
    if (finalStatus) { up.status = finalStatus; up.finishAt = NET.now(); }
    NET.update(`${KEY(code)}/players/${PID}`, up).catch(() => {});
  }

  function handleEvents() {
    const ev = R.ev || {};
    for (const [id, e] of Object.entries(ev)) {
      if (seenEv.has(id)) continue;
      seenEv.add(id);
      if (!e || e.from === PID || e.round !== myRound) continue;
      if (e.type === "stamp") { showStamp(e); continue; }
      if (finished) continue;
      // おじゃまピース（島）が「つぎ」に割り込む
      const isl = G().addIsland();
      G().toast(isl ? `${e.name}さんが${e.rname || REGIONS[e.region] || ""}をそろえた！ ${isl}が飛んできた！` : `${e.name}さんが${e.rname || ""}をそろえた！`, false);
      const card = $("rivals").querySelector(`[data-id="${CSS.escape(e.from)}"]`);
      if (card) { card.classList.add("hit"); setTimeout(() => card.classList.remove("hit"), 1500); }
    }
  }

  // ---------- 協力モード ----------
  // ホストのスマホが物理を計算し、箱の状態を COOP_EVERY ごとに配る。ほかの人は描くだけで、
  // 自分の番のときは狙い（aim）と落とす・ホールドの操作をホストに送る。シャッフルはだれでもできる。
  let coopUnsubs = [];
  let coopTimer = null;
  let turnPid = null;
  let coopDrops = {};
  let coopRoundHost = null;
  let coopDone = new Set();
  const coopOrder = () => participants().filter((p) => p.online !== false).sort((a, b) => (a.joined || 0) - (b.joined || 0));
  const nameOf = (pid) => ((R && R.players && R.players[pid]) || {}).name || "だれか";

  function startCoopRound(mode, seed, stage) {
    stopCoop();
    coopRoundHost = R.host;
    coopDrops = {};
    coopDone = new Set();
    if (isHost()) {
      G().startCoop("host", mode, seed, stage, coopHostHooks);
      turnPid = (coopOrder()[0] || { id: PID }).id;
      applyTurn();
      coopUnsubs.push(NET.on(`${CKEY(code)}/cmd`, onCoopCmd));
      coopUnsubs.push(NET.on(`${CKEY(code)}/aim`, (v) => { const a = v && v[turnPid]; if (a && turnPid !== PID) G().coopRemote("aim", a.x); }));
      coopTimer = setInterval(pushCoop, COOP_EVERY);
      pushCoop();
    } else {
      G().startCoop("client", mode, null, stage, coopClientHooks);
      coopUnsubs.push(NET.on(`${CKEY(code)}/st`, (st) => {
        if (!st || st.r !== myRound) return;
        turnPid = st.turn;
        coopDrops = st.dr || {};
        G().coopSetTurn(st.tn, st.turn === PID);
        G().coopApply(st);
        renderCoopBar();
      }));
    }
    renderCoopBar();
  }
  function stopCoop() {
    coopUnsubs.forEach((u) => { try { u(); } catch { /* ignore */ } });
    coopUnsubs = [];
    clearInterval(coopTimer);
    coopTimer = null;
  }
  function applyTurn() {
    G().coopSetTurn(nameOf(turnPid), turnPid === PID);
    renderCoopBar();
  }
  function advanceTurn() {
    const order = coopOrder();
    if (!order.length) return;
    const i = order.findIndex((p) => p.id === turnPid);
    turnPid = order[(i + 1) % order.length].id;
    applyTurn();
  }
  function pushCoop(extra) {
    if (!code || myRound < 0 || !isHost()) return;
    const st = G().coopState();
    if (!st) return;
    st.r = myRound;
    st.turn = turnPid;
    st.tn = nameOf(turnPid);
    st.dr = coopDrops;
    NET.set(`${CKEY(code)}/st`, Object.assign(st, extra || {})).catch(() => {});
  }
  function onCoopCmd(v) {
    for (const [id, c] of Object.entries(v || {})) {
      if (coopDone.has(id)) continue;
      coopDone.add(id);
      NET.remove(`${CKEY(code)}/cmd/${id}`).catch(() => {});
      if (!c || c.r !== myRound) continue;
      if ((c.type === "drop" || c.type === "hold") && c.from !== turnPid) continue;
      G().coopRemote(c.type, c.x);
    }
  }
  function coopOnRoom() {
    // ホストが抜けたら、この回はおしまい（箱の計算はホストのスマホでしているため）
    if (coopRoundHost && R.host !== coopRoundHost && !finished) {
      G().toast("ホストが抜けたので、協力プレイを終わります");
      if (isHost()) NET.update(KEY(code), { state: "lobby" }).catch(() => {});
      finished = true;
      return;
    }
    if (isHost() && turnPid && R.players && (!R.players[turnPid] || R.players[turnPid].online === false)) advanceTurn();
    renderCoopBar();
  }
  const coopHostHooks = {
    coop: true,
    onDrop() { coopDrops[turnPid] = (coopDrops[turnPid] || 0) + 1; advanceTurn(); pushCoop(); },
    onStage() { pushCoop(); },
    onEnd(cleared) {
      finished = true;
      pushCoop();
      stopCoop();
      const info = G().info;
      NET.set(`${KEY(code)}/coopResult`, { r: myRound, cleared: !!cleared, score: info.score, drops: coopDrops }).catch(() => {});
      setTimeout(() => { if (finished && code) { renderResult(); show("mpResult"); } }, cleared ? 0 : 700);
    },
  };
  let lastAim = 0;
  const coopClientHooks = {
    coop: true,
    cmd(type, x) {
      if (!code) return;
      if (type === "aim") {
        const t = Date.now();
        if (t - lastAim < 90) return;
        lastAim = t;
        NET.set(`${CKEY(code)}/aim/${PID}`, { x: Math.round(x * 10) / 10, t }).catch(() => {});
        return;
      }
      const id = NET.now().toString(36) + Math.random().toString(36).slice(2, 6);
      NET.set(`${CKEY(code)}/cmd/${id}`, { from: PID, type, x: x != null ? Math.round(x * 10) / 10 : null, r: myRound }).catch(() => {});
    },
    onEnd(cleared) {
      finished = true;
      stopCoop();
      setTimeout(() => { if (finished && code) { renderResult(); show("mpResult"); } }, cleared ? 2600 : 900);
    },
  };
  // 上の段: みんなの名前と、いまだれの番か
  function renderCoopBar() {
    const wrap = $("rivals");
    if (!isCoop() || wrap.classList.contains("hidden")) return;
    const order = coopOrder();
    const sig = order.map((p) => p.id).join(",");
    if (wrap.dataset.sig === sig) {
      // 同じメンバーなら作り直さない（スタンプの吹き出しが消えないように）
      for (const p of order) {
        const el = wrap.querySelector(`[data-id="${CSS.escape(p.id)}"]`);
        if (!el) continue;
        el.classList.toggle("turn", p.id === turnPid);
        el.querySelector(".cc-st").textContent = p.id === turnPid ? "▶ 番" : `${coopDrops[p.id] || 0}回`;
      }
      return;
    }
    wrap.dataset.sig = sig;
    wrap.innerHTML = order.map((p) => `<div class="coop-chip${p.id === turnPid ? " turn" : ""}${p.id === PID ? " me" : ""}" data-id="${esc(p.id)}"><span class="cc-name">${esc(p.name)}${p.id === PID ? "（あなた）" : ""}</span><span class="cc-st">${p.id === turnPid ? "▶ 番" : `${coopDrops[p.id] || 0}回`}</span></div>`).join("");
  }

  // ---------- スタンプ ----------
  let lastStampAt = 0;
  function sendStamp(stamp) {
    if (!code || myRound < 0) return;
    const t = Date.now();
    if (t - lastStampAt < 1200) return;   // 連打しすぎない
    lastStampAt = t;
    const id = NET.now().toString(36) + Math.random().toString(36).slice(2, 6);
    NET.set(`${KEY(code)}/ev/${id}`, { type: "stamp", from: PID, name: myName() || "だれか", stamp: String(stamp).slice(0, 8), round: myRound, t: NET.now() }).catch(() => {});
    const me = $("myStamp");
    me.textContent = stamp;
    me.classList.add("show");
    clearTimeout(me._t);
    me._t = setTimeout(() => me.classList.remove("show"), 1400);
    $("stampBar").classList.add("hidden");
  }
  function showStamp(e) {
    const card = $("rivals").querySelector(`[data-id="${CSS.escape(e.from)}"]`);
    if (card && !$("rivals").classList.contains("hidden") && !isOpen("mpResult")) {
      card.querySelectorAll(".bubble").forEach((b) => b.remove());
      const b = document.createElement("div");
      b.className = "bubble";
      b.textContent = e.stamp;
      card.appendChild(b);
      setTimeout(() => b.remove(), 2300);
    } else {
      G().toast(`${e.name}：${e.stamp}`);
    }
  }
  $("stampBtn").addEventListener("click", () => $("stampBar").classList.toggle("hidden"));
  document.addEventListener("click", (e) => {
    const b = e.target.closest("[data-stamp]");
    if (b) sendStamp(b.dataset.stamp);
  });

  // 最下位が確定したら GAME OVER（完成した人は完成していない人より必ず上なので、
  // 自分以外がみんな完成したら、もう順位は上がらない）
  function checkLastPlace() {
    if (finished || myRound < 0 || !G().info.running) return;
    const others = participants().filter((p) => p.id !== PID && p.online !== false);
    if (!others.length) return;
    if (others.every((p) => p.status === "clear")) {
      G().gameOver(others.length === 1 ? `${others[0].name}さんが先に完成させた` : "みんなが先に完成させた");
    }
  }

  // 1位が確定したら WINNER（ほかの全員がゲームオーバー／通信切れで、自分の点数が全員より上。
  // 点数は減らないので、もう抜かれない）
  function checkWinner() {
    if (finished || myRound < 0 || !G().info.running) return;
    const others = participants().filter((p) => p.id !== PID);
    if (!others.length) return;
    if (!others.every((p) => p.status === "over" || (p.online === false && p.status !== "clear"))) return;
    const best = Math.max(...others.map((p) => p.score || 0));
    if (G().info.score > best) G().winner(others.length === 1 ? `${others[0].name}さんがゲームオーバー` : "ほかのみんながゲームオーバー");
  }

  function statusText(p) {
    if (p.online === false && p.status === "playing") return "通信切れ";
    if (p.status === "clear") return "完成！";
    if (p.status === "win") return "1位確定";
    if (p.status === "over") return "ゲームオーバー";
    const sn = isChain(R.stage) && p.stage ? `${STAGE_NAMES[p.stage] || ""}・` : "";
    return p.left == null ? `${sn}スタート` : `${sn}のこり${p.left}`;
  }

  const DPR = Math.min(window.devicePixelRatio || 1, 2);
  function boardCanvas(cls) {
    const cv = document.createElement("canvas");
    cv.width = Math.round(34 * DPR * 2);
    cv.height = Math.round(cv.width * 680 / 400);
    if (cls) cv.className = cls;
    return cv;
  }
  function drawBoardFor(cv, p) {
    let snap = [];
    try { snap = p.board ? JSON.parse(p.board) : []; } catch { /* ignore */ }
    G().drawBoard(cv, snap, { mode: R.mode, lineDown: !!p.lineDown, stage: p.stage || firstStage(R.stage) });
  }

  function renderRivals() {
    const wrap = $("rivals");
    const others = participants().filter((p) => p.id !== PID).sort((a, b) => (a.joined || 0) - (b.joined || 0));
    if (!others.length) {
      wrap.innerHTML = '<div class="rival"><span class="r-st" style="padding:6px 8px">ひとりで対戦中（相手が入ると、ここに箱が表示されます）</span></div>';
      return;
    }
    if (wrap.querySelector(".rival:not([data-id])")) wrap.innerHTML = "";
    const keep = new Set();
    for (const p of others) {
      keep.add(p.id);
      let card = wrap.querySelector(`[data-id="${CSS.escape(p.id)}"]`);
      if (!card) {
        card = document.createElement("div");
        card.className = "rival";
        card.dataset.id = p.id;
        card.appendChild(boardCanvas());
        card.insertAdjacentHTML("beforeend", '<div><div class="r-name"></div><div class="r-score"></div><div class="r-st"></div></div>');
        wrap.appendChild(card);
      }
      card.querySelector(".r-name").textContent = p.name;
      card.querySelector(".r-score").textContent = p.score || 0;
      card.querySelector(".r-st").textContent = statusText(p);
      card.classList.toggle("over", p.status === "over" || p.online === false);
      card.classList.toggle("clear", p.status === "clear");
      drawBoardFor(card.querySelector("canvas"), p);
    }
    wrap.querySelectorAll("[data-id]").forEach((c) => { if (!keep.has(c.dataset.id)) c.remove(); });
  }

  // ---------- result ----------
  function ranked() {
    return participants().sort((a, b) => {
      const ac = a.status === "clear", bc = b.status === "clear";
      if (ac !== bc) return ac ? -1 : 1;
      if (ac && bc) return (a.finishAt || 0) - (b.finishAt || 0);
      return (b.score || 0) - (a.score || 0);
    });
  }
  function renderCoopResult() {
    const res = R.coopResult && R.coopResult.r === R.round ? R.coopResult : null;
    const order = participants().sort((a, b) => (a.joined || 0) - (b.joined || 0));
    $("mpResultTitle").textContent = !res ? "けっか集計中…" : res.cleared ? "みんなで完成！" : "ざんねん…";
    $("mpResultSub").textContent = `${order.length}人で協力・${(G().MODES[R.mode] || {}).name || ""}・${STAGE_NAMES[R.stage || "japan"]}` + (res ? `・${res.score}点` : "");
    const ol = $("mpRanking");
    ol.innerHTML = "";
    const drops = (res && res.drops) || {};
    order.forEach((p) => {
      const li = document.createElement("li");
      if (p.id === PID) li.classList.add("me");
      li.innerHTML = `<span class="rk">🤝</span><div class="who"><b>${esc(p.name)}${p.id === PID ? "（あなた）" : ""}</b><span>${drops[p.id] || 0}回 落とした</span></div>`;
      ol.appendChild(li);
    });
    $("mpAgain").style.display = isHost() ? "" : "none";
    msg("mpResultMsg", isHost() ? "" : "ホストが「もう一回」を押すと次が始まります", true);
  }
  function renderResult() {
    if (!R) return;
    if (isCoop()) { renderCoopResult(); return; }
    const list = ranked();
    const done = (p) => p.status === "clear" || p.status === "over" || p.status === "win" || p.online === false;
    const allDone = list.every(done);
    const myRank = list.findIndex((p) => p.id === PID) + 1;
    const mine = list.find((p) => p.id === PID) || {};

    if (allDone) {
      $("mpResultTitle").textContent = list.length > 1 ? (myRank === 1 ? "優勝！" : `${myRank}位`) : (mine.status === "clear" ? "日本列島 完成！" : "結果");
      $("mpResultSub").textContent = `${list.length}人で対戦・${(G().MODES[R.mode] || {}).name || ""}・${STAGE_NAMES[R.stage || "japan"]}`;
    } else {
      $("mpResultTitle").textContent = mine.status === "clear" ? "日本列島 完成！" : "ゲームオーバー";
      $("mpResultSub").textContent = `まだ遊んでいる人がいます…（いまのところ ${myRank}位）`;
    }

    const ol = $("mpRanking");
    ol.innerHTML = "";
    list.forEach((p, i) => {
      const li = document.createElement("li");
      if (p.id === PID) li.classList.add("me");
      li.innerHTML = `<span class="rk">${done(p) ? i + 1 : "…"}</span>`;
      const cv = boardCanvas();
      li.appendChild(cv);
      li.insertAdjacentHTML("beforeend", `<div class="who"><b>${esc(p.name)}${p.id === PID ? "（あなた）" : ""}</b><span>${esc(statusText(p))}</span></div><span class="pts">${p.score || 0}</span>`);
      ol.appendChild(li);
      drawBoardFor(cv, p);
    });

    $("mpAgain").style.display = isHost() ? "" : "none";
    msg("mpResultMsg", isHost()
      ? (allDone ? "" : "みんなが終わる前でも、もう一回を始められます")
      : "ホストが「もう一回」を押すと次が始まります", true);
  }

  // ---------- leave ----------
  function stopPlaying() {
    stopCoop();
    clearInterval(liveTimer);
    clearInterval(countdownTimer);
    $("countdown").classList.add("hidden");
    $("rivals").classList.add("hidden");
    document.body.classList.remove("in-match");
    $("stampBar").classList.add("hidden");
    myRound = -1;
    finished = false;
    if (G().info.running || G().info.ended) G().stop();
    window.dispatchEvent(new Event("resize"));
  }

  function leaveLocal(reason) {
    const c = code;
    code = null;
    R = null;
    ss.set("pref_room", null);
    if (unsub) { unsub(); unsub = null; }
    stopPlaying();
    document.body.classList.remove("multi");
    show("startScreen");
    if (reason) G().toast(reason);
    return c;
  }

  async function leaveRoom() {
    if (!code) { leaveLocal(); return; }
    const room = R, c = code;
    leaveLocal();
    try {
      NET.cancelDisconnect && NET.cancelDisconnect(`${KEY(c)}/players/${PID}/online`);
      const others = Object.entries((room && room.players) || {}).filter(([id, p]) => id !== PID && p && p.online !== false);
      if (!others.length) { await NET.remove(KEY(c)); NET.remove(CKEY(c)).catch(() => {}); return; }
      const up = { [`players/${PID}`]: null };
      if (room.host === PID) up.host = others.sort((a, b) => (a[1].joined || 0) - (b[1].joined || 0))[0][0];
      await NET.update(KEY(c), up);
    } catch (err) { console.warn(err); }
  }
  ["mpLeave", "mpLeave2", "mpLeave3"].forEach((id) => $(id).addEventListener("click", () => {
    if (id === "mpLeave3" && !confirmLeave()) return;
    leaveRoom();
  }));
  function confirmLeave() { return true; } // メニューから選んだ時点で確認済みとみなす

  function renderConnection() {
    if (!code) return;
    if (!connected) G().toast("通信が切れています…");
  }

  // ---------- entry points ----------
  // 招待リンク（?room=1234）から開いたとき
  const params = new URLSearchParams(location.search);
  const inviteCode = (params.get("room") || "").replace(/\D/g, "").slice(0, 4);
  if (/^\d{4}$/.test(inviteCode)) {
    history.replaceState(null, "", location.pathname);
    openJoin(inviteCode);
  } else if (ss.get("pref_room")) {
    // 再読みこみしたときは、同じ部屋にそっと戻る
    const c = ss.get("pref_room");
    ensureNet().then(async (ok) => {
      if (!ok) return;
      try {
        const room = await NET.get(KEY(c));
        if (room && room.game === "pref" && room.players && room.players[PID]) {
          await NET.update(`${KEY(c)}/players/${PID}`, { online: true });
          await enterRoom(c);
        } else ss.set("pref_room", null);
      } catch { /* ignore */ }
    });
  }

  // ---------- ランキング（ひとりで遊んだスコア） ----------
  // rooms/pref-ranking/<mode>/<id>: name, score, reached, laps, pid, t
  const RANK = "rooms/pref-ranking";
  const RANK_SHOW = 30;
  let myLastEntry = null;

  async function topScores(m, n) {
    if (!(await ensureNet())) throw new Error("timeout");
    return NET.top(`${RANK}/${m}`, "score", n);
  }
  function rankRows(list, highlightId) {
    return list.map((r, i) => {
      const sub = [r.reached || "", r.laps > 1 ? `${r.laps}周` : ""].filter(Boolean).join("・");
      return `<li class="${r.id === highlightId ? "me" : ""}"><span class="n">${i + 1}</span><span class="nm">${esc(r.name)}${sub ? `<small>${esc(sub)}</small>` : ""}</span><span class="sc">${r.score}</span></li>`;
    }).join("");
  }

  async function loadResultRanking(m, highlightId, myScore) {
    msg("rankMsg", "ランキングを読みこみ中…", true);
    try {
      const list = await topScores(m, 100);
      $("rankList").innerHTML = rankRows(list.slice(0, 10), highlightId);
      if (highlightId) {
        const pos = list.findIndex((r) => r.id === highlightId);
        msg("rankMsg", pos >= 0 ? `あなたは ${pos + 1}位！（${G().MODES[m].name}）` : "登録しました（100位圏外）", true);
      } else {
        const better = list.filter((r) => r.score > myScore).length;
        msg("rankMsg", list.length && myScore > 0 ? (better < 100 ? `登録すると ${better + 1}位 に入ります` : "") : "", true);
      }
    } catch (e) { msg("rankMsg", netError(e)); }
  }

  window.PrefRank = {
    onResult(r) {
      myLastEntry = r;
      $("rankName").value = myName();
      $("rankSubmit").classList.toggle("done", !(r.score > 0));
      $("rankSubmitBtn").disabled = false;
      $("rankList").innerHTML = "";
      loadResultRanking(r.mode, null, r.score);
    },
  };

  $("rankSubmitBtn").addEventListener("click", (e) => busy(e.currentTarget, async () => {
    const r = myLastEntry;
    if (!r) return;
    const name = $("rankName").value.trim().slice(0, 10);
    if (!name) { msg("rankMsg", "なまえを入れてね"); return; }
    saveName(name);
    msg("rankMsg", "登録しています…", true);
    if (!(await ensureNet())) { msg("rankMsg", netError("timeout")); return; }
    try {
      const id = NET.now().toString(36) + Math.random().toString(36).slice(2, 6);
      await NET.set(`${RANK}/${r.mode}/${id}`, { name, score: r.score, reached: r.reached || "", laps: r.laps || 1, pid: PID, t: NET.now() });
      // 部屋の自動おそうじの対象にならないように、遠い未来の作成日時を入れておく
      NET.set(`${RANK}/created`, 9e15).catch(() => {});
      $("rankSubmit").classList.add("done");
      myLastEntry = null;
      await loadResultRanking(r.mode, id, r.score);
    } catch (err) { msg("rankMsg", netError(err)); }
  }));

  let rankMode = "normal";
  async function loadRankScreen() {
    $("rankScreenList").innerHTML = "";
    msg("rankScreenMsg", "読みこみ中…", true);
    try {
      const list = await topScores(rankMode, RANK_SHOW);
      $("rankScreenList").innerHTML = rankRows(list);
      msg("rankScreenMsg", list.length ? "" : "まだだれも登録していません。一番乗りしよう！", true);
    } catch (e) { msg("rankScreenMsg", netError(e)); }
  }
  $("rankOpenBtn").addEventListener("click", () => { show("rankScreen"); loadRankScreen(); });
  $("rankCloseBtn").addEventListener("click", () => show("startScreen"));
  $("rankSeg").addEventListener("click", (e) => {
    const b = e.target.closest("button[data-mode]");
    if (!b) return;
    rankMode = b.dataset.mode;
    $("rankSeg").querySelectorAll("button").forEach((x) => x.classList.toggle("on", x === b));
    loadRankScreen();
  });

  window.__prefnet = { get room() { return R; }, get code() { return code; }, PID, leaveRoom };
})();
