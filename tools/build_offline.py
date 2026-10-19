#!/usr/bin/env python3
"""みらい建設工業 3D現場ポータル オフライン版（単一HTML・通信なし）を作る。

使い方：python3 build_offline.py <オンライン版HTML> <three-bundle.min.js> <offline_renderer.js> <出力HTML>
- オンライン版（build_app.py の出力）の 0〜9章（データ・ワールドモデル・台帳・タイムライン・管理パネル）をそのまま使い、
  10〜12章（3D描画・起動）だけを offline_renderer.js に差し替える。
- CesiumJS・Google の読み込み、APIキー画面を取り除き、three.js をファイルの中に埋め込む。
- 外部への参照（script src・link href・fetch）が残っていたら止まる。
"""
import re, sys

online, bundlef, rendf, outf = sys.argv[1:5]
# 配るファイルの版。配り直すたびに上げる（画面のヘッダーと <title> に出る）
VERSION = 'v1.0（2026-10-20）'
t = open(online, encoding='utf-8').read()
bundle = open(bundlef, encoding='utf-8').read()
rend = open(rendf, encoding='utf-8').read()
if '</script' in bundle or '</script' in rend:
    raise SystemExit('埋め込むスクリプトに </script が含まれています')

def rep(old, new, n=1):
    global t
    c = t.count(old)
    if c != n:
        raise SystemExit(f'置換対象の出現回数が {c}（期待 {n}）: {old[:120]!r}')
    t = t.replace(old, new)

def cut(start, end, new, keep_end=True):
    global t
    i = t.index(start); j = t.index(end, i)
    t = t[:i] + new + (t[j:] if keep_end else t[j + len(end):])

# ---- 見出し・説明コメント ----
rep('<title>みらい建設工業 3D現場ポータル</title>', f'<title>みらい建設工業 3D現場ポータル（オフライン版 {VERSION}）</title>')
cut('<!--\n', '-->\n', '''<!--
  みらい建設工業 3D現場ポータル オフライン版 ''' + VERSION + '''（港湾・海洋土木版／World Model サンプル）
  - 完全オフラインの単一HTML。外部と通信しない（地形・住所・行政区域・3D描画部品 three.js をすべてこのファイルに埋め込み）。
  - ダブルクリック（file://）で開ける。Webサーバ・APIキー・インターネット接続は不要。
  - 0〜9章（データ・ワールドモデル・台帳・タイムライン・管理パネル）はオンライン版と共通。10〜12章（3D描画）だけがオフライン版用。
    オンライン版（CesiumJS＋Google 実写3D）は、同じ共通部分から tools/build_app.py で作る。
  - 工事名・発注者・工程・実績・計画はすべて架空（サンプル）で、みらい建設工業の実際の工事ではない。工事番号は仮採番。地域係数・機械能力はサンプル値。
  出典：
   ・国土数値情報（行政区域：スマートニュース メディア研究所による簡素化版を再簡素化／高速道路時系列 N06-24）国土交通省
   ・アドレス・ベース・レジストリ（デジタル庁）を加工した Geolonia 住所データ v2（CC BY 4.0）
   ・現場の所在地：国土地理院 逆ジオコーダ（地方公共団体コード表 muni.js）
   ・国土地理院 標高タイル（DEM5A／DEM5B／DEM10B）を加工して作成
   ・3D描画：three.js r160（MIT License）
-->
''', keep_end=False)
rep("<script>window.CESIUM_BASE_URL='https://cdn.jsdelivr.net/npm/cesium@1.145.0/Build/Cesium/';</script>\n", '')
rep('<link rel="stylesheet" href="https://cdn.jsdelivr.net/npm/cesium@1.145.0/Build/Cesium/Widgets/widgets.css">\n', '')

# ---- ヘッダー・画面の文言 ----
rep('<span class="tag jp">Google 3D版</span>', '<span class="tag jp">オフライン版</span>')
rep('    <button class="btn ghost" id="keyBtn" title="Google Map Tiles API のキーを設定">🔑 APIキー</button>\n', '')
rep('<span class="net init" id="netStatus">3D 準備中</span>', f'<span class="net init" id="netStatus">3D 準備中</span>\n    <span class="basedate" title="配られたファイルの版">{VERSION}・情報区分：社内</span>')
rep('／3D都市・地形：Google（帰属表示は3Dビュー左下）／描画：CesiumJS</div>', '／3D描画：three.js（MIT License）</div>')
rep('／周辺は Google の実写3D（実在）</div>', '／周辺は国土地理院の標高データ</div>')
rep('その現場の3D（周辺は Google 実写3D）へ移動します。', 'その現場の3Dへ移動します。')
rep('周辺の街並みは Google の実写3D（オンライン）です。', '周辺は国土地理院の標高データによる1km四方の地形です（オフライン版）。')
rep("'簡易地形モード（国土地理院 標高）'", "'オフライン版（国土地理院 標高）'")
cut('<div class="dlg" id="keyDlg" hidden>', '<script src="https://cdn.jsdelivr.net/npm/cesium@1.145.0/Build/Cesium/Cesium.js"></script>', '', keep_end=False)

# ---- 3D描画部品（three.js）を埋め込み、10〜12章を差し替える ----
lic = ('/*! three.js r160 (https://threejs.org) | MIT License | Copyright © 2010-2023 three.js authors\n'
       '   以下は three.js と OrbitControls をこのファイル用に1つにまとめたもの（window.THREE に登録）。 */\n')
i = t.index('<script>\n\'use strict\';')
t = t[:i] + '<script>\n' + lic + bundle.strip() + '\n</script>\n' + t[i:]
cut('/* =====================================================================\n   10. 3Dビュー（CesiumJS', '\n</script>\n</body>', rend.rstrip() + '\n')
rep('#nogl{position:absolute;inset:0;', '#cz canvas{display:block}\n#nogl{position:absolute;inset:0;')

# ---- 検査：外部への参照が残っていないこと ----
ext = re.findall(r'<(?:script|link|img|iframe)[^>]+(?:src|href)=["\']https?://[^"\']+', t) + re.findall(r'fetch\(\s*[\'"`]https?://', t)
bad = [w for w in ('cdn.jsdelivr.net', 'tile.googleapis.com', 'CESIUM_BASE_URL', 'Cesium.js', 'keyDlg', 'C3.') if w in t]
if ext or bad:
    raise SystemExit(f'外部参照・旧部品が残っています: {ext[:3]} {bad}')
open(outf, 'w', encoding='utf-8').write(t)
print('ok', outf, len(t.encode('utf-8')), 'bytes')
