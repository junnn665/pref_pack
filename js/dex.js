/* 都道府県ゲーム — 図鑑（くっつけた県・国を集める）とバッジ（実績）
 * 保存はスマホの中（localStorage）。アップデートしても消えない。
 *   prefpack.dex    = { japan: [id, …], asia: [...], … }
 *   prefpack.badges = { badgeId: 取った日時 }
 */
(() => {
  "use strict";
  const $ = (id) => document.getElementById(id);
  const G = () => window.PrefGame;
  const store = {
    get(k, d) { try { const v = localStorage.getItem(k); return v == null ? d : JSON.parse(v); } catch { return d; } },
    set(k, v) { try { localStorage.setItem(k, JSON.stringify(v)); } catch { /* ignore */ } },
  };
  const esc = (s) => String(s == null ? "" : s).replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));

  const STAGE_TABS = [
    ["japan", "日本"], ["asia", "アジア"], ["europe", "ヨーロッパ"], ["africa", "アフリカ"], ["world", "世界"],
  ];
  const BADGES = [
    ["first", "🎉", "はじめての完成", "どれかのステージを完成させた"],
    ["clear_japan", "🗾", "日本列島", "日本列島を完成させた"],
    ["clear_asia", "🐼", "アジア大陸", "アジア大陸を完成させた"],
    ["clear_europe", "🏰", "ユーラシア大陸", "ユーラシア大陸を完成させた"],
    ["clear_africa", "🦁", "アフリカ大陸", "アフリカ大陸を完成させた"],
    ["clear_world", "🌏", "世界", "世界を完成させた"],
    ["allclear", "👑", "全クリア", "日本から世界まで続けて完成させた"],
    ["noshuffle", "🧘", "ノーシャッフル", "シャッフルを使わずにステージを完成させた"],
    ["nohold", "✋", "ホールドなし", "ホールドを使わずにステージを完成させた"],
    ["speed30", "⚡", "スピード完成", "最後のピースを落としてから30秒以内に完成させた"],
    ["hard", "🎓", "上級者", "上級モードでステージを完成させた"],
    ["combo5", "🔥", "5コンボ", "続けて5回くっつけた"],
    ["island", "🏝️", "島をつなげた", "おじゃまピースの島を親にくっつけた"],
    ["vs_win", "🥇", "優勝", "対戦で1位になった"],
    ["coop_clear", "🤝", "みんなで完成", "協力モードで完成させた"],
    ["team_win", "🚩", "チームの勝利", "チーム戦で勝った"],
    ["dex_japan", "📗", "日本図鑑コンプ", "47都道府県をぜんぶ図鑑に集めた"],
    ["dex_asia", "📘", "アジア図鑑コンプ", "アジアの国をぜんぶ図鑑に集めた"],
    ["dex_europe", "📙", "ヨーロッパ図鑑コンプ", "ヨーロッパの国をぜんぶ図鑑に集めた"],
    ["dex_africa", "📕", "アフリカ図鑑コンプ", "アフリカの国をぜんぶ図鑑に集めた"],
    ["dex_world", "📓", "世界図鑑コンプ", "南北アメリカ・オセアニアの国をぜんぶ図鑑に集めた"],
    ["dex_all", "🏆", "図鑑マスター", "図鑑をぜんぶ集めた"],
  ];
  const BADGE_MAP = Object.fromEntries(BADGES.map((b) => [b[0], b]));

  let dexData = store.get("prefpack.dex", {});
  let badges = store.get("prefpack.badges", {});

  // 図鑑にのる県・国（金色のかたまり＝前のステージ と 島 はのせない）
  function entries(stKey) {
    const S = G().STAGES[stKey];
    return S.ids.map((id) => S.pieces[id]).filter((p) => p && !p.home && !p.island);
  }
  const have = (stKey) => new Set(dexData[stKey] || []);

  // ---------- バッジのお知らせ ----------
  const toastQ = [];
  let toastBusy = false;
  function nextToast() {
    if (toastBusy || !toastQ.length) return;
    toastBusy = true;
    const b = toastQ.shift();
    const el = $("badgeToast");
    el.innerHTML = `<span class="bt-ic">${b[1]}</span><span><small>バッジ獲得！</small><b>${esc(b[2])}</b></span>`;
    el.classList.add("show");
    setTimeout(() => { el.classList.remove("show"); setTimeout(() => { toastBusy = false; nextToast(); }, 350); }, 2400);
  }

  function badge(id) {
    if (badges[id] || !BADGE_MAP[id]) return false;
    badges[id] = Date.now();
    store.set("prefpack.badges", badges);
    toastQ.push(BADGE_MAP[id]);
    nextToast();
    return true;
  }

  function collect(stKey, ids) {
    const set = have(stKey);
    const before = set.size;
    for (const id of ids) set.add(id);
    if (set.size === before) return;
    dexData[stKey] = [...set];
    store.set("prefpack.dex", dexData);
    const all = entries(stKey);
    if (all.every((p) => set.has(p.id))) badge(`dex_${stKey}`);
    if (STAGE_TABS.every(([k]) => entries(k).every((p) => have(k).has(p.id)))) badge("dex_all");
  }

  // ---------- 画面 ----------
  let tab = "japan";
  function renderTabs() {
    $("dexTabs").innerHTML = [...STAGE_TABS, ["badges", "🏅"]].map(([k, n]) => `<button data-tab="${k}" class="${k === tab ? "on" : ""}">${n}</button>`).join("");
  }

  function drawShape(cv, p, color) {
    const dpr = Math.min(window.devicePixelRatio || 1, 2);
    const w = cv.clientWidth || 56, h = cv.clientHeight || 56;
    cv.width = Math.round(w * dpr); cv.height = Math.round(h * dpr);
    const c = cv.getContext("2d");
    const b = p.bbox;
    const bw = b.maxX - b.minX || 1, bh = b.maxY - b.minY || 1;
    const k = Math.min((w - 8) / bw, (h - 8) / bh);
    c.setTransform(dpr * k, 0, 0, dpr * k, dpr * (w / 2 - (b.minX + bw / 2) * k), dpr * (h / 2 - (b.minY + bh / 2) * k));
    c.fillStyle = color;
    c.fill(p.path);
    c.lineJoin = "round";
    c.lineWidth = 1.2 / k;
    c.strokeStyle = color === "#d8cfbf" ? "#bfb3a0" : p.stroke;
    c.stroke(p.path);
  }

  function render() {
    renderTabs();
    $("dexDetail").classList.add("hidden");
    const grid = $("dexGrid");
    grid.innerHTML = "";
    if (tab === "badges") {
      const got = BADGES.filter((b) => badges[b[0]]).length;
      $("dexProgress").textContent = `バッジ ${got} / ${BADGES.length}`;
      grid.className = "dex-grid badges";
      grid.innerHTML = BADGES.map((b) => {
        const on = !!badges[b[0]];
        return `<div class="dex-badge ${on ? "on" : ""}"><span class="ic">${on ? b[1] : "🔒"}</span><b>${esc(b[2])}</b><small>${esc(b[3])}</small></div>`;
      }).join("");
      return;
    }
    grid.className = "dex-grid";
    const list = entries(tab);
    const got = have(tab);
    const n = list.filter((p) => got.has(p.id)).length;
    $("dexProgress").textContent = `${n} / ${list.length}` + (n === list.length ? "　コンプリート！" : "");
    for (const p of list) {
      const on = got.has(p.id);
      const cell = document.createElement("button");
      cell.className = `dex-cell ${on ? "on" : ""}`;
      cell.dataset.id = p.id;
      const cv = document.createElement("canvas");
      cell.appendChild(cv);
      const nm = document.createElement("span");
      nm.textContent = on ? `${G().flagOf(p) ? G().flagOf(p) + " " : ""}${p.short}` : "？？？";
      cell.appendChild(nm);
      grid.appendChild(cell);
      drawShape(cv, p, on ? p.color : "#d8cfbf");
    }
  }

  function showDetail(id) {
    const S = G().STAGES[tab];
    const p = S.pieces[id];
    if (!p) return;
    const on = have(tab).has(p.id);
    const el = $("dexDetail");
    const region = (S.regions || [])[p.region] || "";
    const fact = on ? G().factText(p, S) : "";
    el.innerHTML = `<canvas></canvas><div class="dd-text">${on
      ? `<b>${esc(G().flagOf(p))} ${esc(p.name)}</b><small>${esc(S.regionName ? S.regionName(region) : region)}</small><p>${esc(fact)}</p>`
      : `<b>？？？</b><small>${esc(S.regionName ? S.regionName(region) : region)}</small><p>まだくっつけていません。ゲームでくっつけると登録されます</p>`}</div>`;
    el.classList.remove("hidden");
    drawShape(el.querySelector("canvas"), p, on ? p.color : "#d8cfbf");
  }

  $("dexOpenBtn").addEventListener("click", () => {
    document.querySelectorAll(".overlay").forEach((o) => o.classList.add("hidden"));
    $("dexScreen").classList.remove("hidden");
    render();
  });
  $("dexCloseBtn").addEventListener("click", () => {
    $("dexScreen").classList.add("hidden");
    $("startScreen").classList.remove("hidden");
  });
  $("dexTabs").addEventListener("click", (e) => {
    const b = e.target.closest("button[data-tab]");
    if (!b) return;
    tab = b.dataset.tab;
    render();
  });
  $("dexGrid").addEventListener("click", (e) => {
    const c = e.target.closest(".dex-cell");
    if (c) showDetail(Number(c.dataset.id));
  });
  $("dexDetail").addEventListener("click", () => $("dexDetail").classList.add("hidden"));

  window.PrefDex = {
    collect, badge,
    get badges() { return { ...badges }; },
    get data() { return JSON.parse(JSON.stringify(dexData)); },
    BADGES,
  };
})();
