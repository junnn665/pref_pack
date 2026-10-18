# つなげて！都道府県パック

都道府県を箱に落として詰めるパズルゲーム。
地図で隣り合う県同士がふれるとくっついて地方になり、47 都道府県ぜんぶつなぐと日本列島が完成します。

## 遊び方

- 箱の上をタップ／ドラッグして位置を決め、指をはなすと県が落ちる（PC は ←→ とスペースキーでも OK）
- 地図で隣り合う県がふれると合体（海をはさむ 北海道–青森、本州–四国、本州–九州、鹿児島–沖縄 もつながる）
- 地方がひとつにそろうと +300 点とシャッフル +1
- 点線より上にあふれたままだとゲームオーバー
- 日本列島が完成するとクリア

## 公開のしかた（GitHub Pages）

1. リポジトリの **Settings → Pages** を開く
2. Source を **Deploy from a branch**、Branch を **main / (root)** にして Save
3. 数分後に `https://junnn665.github.io/prefpack/` で遊べる

ビルド不要の静的ファイルだけで動きます。ローカルで試すなら:

```sh
python3 -m http.server 8000
# → http://localhost:8000
```

## ファイル構成

| パス | 内容 |
| --- | --- |
| `index.html` / `style.css` | 画面とデザイン |
| `js/game.js` | ゲーム本体（物理・合体判定・描画） |
| `js/prefs.js` | 都道府県の形・隣接データ（自動生成） |
| `vendor/matter.min.js` | 物理エンジン [Matter.js](https://brm.io/matter-js/)（MIT） |
| `tools/build_prefs.py` | 地図データから `js/prefs.js` を作るスクリプト |

### 調整ポイント（`js/game.js` 冒頭）

- `EXP` … 合体したときの縮み具合（小さいほど 1 県のピースが大きくなり難しくなる）
- `LINE_Y` … あふれラインの高さ
- `START_SHUFFLES` … 最初のシャッフル回数

### 地図データの作り直し

```sh
curl -LO https://raw.githubusercontent.com/dataofjapan/land/master/japan.geojson
python3 tools/build_prefs.py japan.geojson js/prefs.js
```

## クレジット

- 地図データ: 「国土数値情報（行政区域データ）」（国土交通省）を加工して作成（[dataofjapan/land](https://github.com/dataofjapan/land) 経由）
- 物理エンジン: Matter.js © Liam Brummitt（MIT License）
