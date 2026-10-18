# つなげて！都道府県パック

都道府県を箱に落として詰めるパズルゲーム。
地図で隣り合う県同士がふれるとくっついて地方になり、47 都道府県ぜんぶつなぐと日本列島が完成します。

## 遊び方

- 箱の上をタップ／ドラッグして位置を決め、指をはなすと県が落ちる（PC は ←→ とスペースキーでも OK）
- 地図で隣り合う県がふれると合体（海をはさむ 北海道–青森、本州–四国、本州–九州、鹿児島–沖縄 もつながる）
- 地方がひとつにそろうと +300 点
- シャッフル（箱をゆらす）は何回でも使える（1.2 秒のクールダウンあり）
- 点線より上にあふれたままだとゲームオーバー
- 日本列島が完成するとクリア

## モード

| | ふつう | かんたん |
| --- | --- | --- |
| ピースの大きさ | 大きめ | 小さめ |
| あふれライン | 低め | 高め（余裕あり） |
| ラインを超えてからの猶予 | 2.2 秒 | 4 秒 |
| 次の県 | ランダム | 箱にある県のおとなりが出やすい |
| ヒント | なし | くっつける相手が光る |

ベストスコアはモードごとに記録されます。

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

- `MODES` … モードごとの設定（ピースの大きさ `exp`、あふれライン `lineY`、猶予 `overLimit`、おとなり優先 `neighbor`、ヒント `hint`）
- `SHUFFLE_COOLDOWN` … シャッフルの連打防止時間

### 地図データの作り直し

```sh
curl -LO https://raw.githubusercontent.com/dataofjapan/land/master/japan.geojson
python3 tools/build_prefs.py japan.geojson js/prefs.js
```

## クレジット

- 地図データ: 「国土数値情報（行政区域データ）」（国土交通省）を加工して作成（[dataofjapan/land](https://github.com/dataofjapan/land) 経由）
- 物理エンジン: Matter.js © Liam Brummitt（MIT License）
