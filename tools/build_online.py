#!/usr/bin/env python3
"""みらい建設工業 3D現場ポータル オンライン版（データをすべて起動時にオンライン取得する版）を作る。

使い方：python3 build_online.py <オンライン版HTML（build_app.py の出力）> <sites.json> <kinds.js> <online_loader.js> <出力フォルダ> [online_business.js]
出力：
  index.html        画面の骨組み（CSS・HTML）＋ CesiumJS ＋ loader.js
  loader.js         起動時にデータを取得して GEO を組み立て、app.js を読み込む
  app.js            アプリ本体（オンライン版と同じ共通部分＋CesiumJS の3D描画）。埋め込みデータは持たない
  data/sites.json   現場台帳（工事名・発注者・支店・工種・位置・範囲。すべて架空）
  data/master.json  地域係数（サンプル値）
  data/japan.json   都道府県・高速道路の形（国土数値情報を加工。ライブの API がないためファイルで配る）
地形（国土地理院 標高タイル）・所在地（逆ジオコーダ）・住所検索・背景地図は、ブラウザが国土地理院から直接取得する。
"""
import json, os, re, subprocess, sys

src, sitesf, kindsf, loaderf, outd = sys.argv[1:6]
HERE = os.path.dirname(os.path.abspath(__file__))
bizf = sys.argv[6] if len(sys.argv) > 6 else os.path.join(HERE, '..', 'src', 'online_business.js')
featf = os.path.join(HERE, '..', 'src', 'online_features.js')
srvf = os.path.join(HERE, '..', 'src', 'online_server.js')
planf = os.path.join(HERE, '..', 'src', 'online_planning.js')
opsf = os.path.join(HERE, '..', 'src', 'online_ops.js')
trendf = os.path.join(HERE, '..', 'src', 'online_trend.js')
ledgerf = os.path.join(HERE, '..', 'src', 'online_sites.js')
t = open(src, encoding='utf-8').read()
sites = json.load(open(sitesf, encoding='utf-8'))
kinds = open(kindsf, encoding='utf-8').read()

def node_eval(js, expr):
    r = subprocess.run(['node', '-e', js + f'\nprocess.stdout.write(JSON.stringify({expr}));'], capture_output=True, text=True, check=True)
    return json.loads(r.stdout)

def rep(s, old, new, n=1):
    c = s.count(old)
    if c != n:
        raise SystemExit(f'置換対象の出現回数が {c}（期待 {n}）: {old[:120]!r}')
    return s.replace(old, new)

# ---- 1. 本体スクリプトと HTML を分ける ----
i = t.index("<script>\n'use strict';"); j = t.index('</script>\n</body>', i)
app = t[i + len('<script>\n'):j]; html = t[:i] + '@@LOADER@@' + t[j + len('</script>\n'):]

# ---- 2. データファイル ----
m = re.search(r'^const GEO = (\{.*\});$', app, re.M)
geo = json.loads(m.group(1))
japan = {'note': '都道府県（行政区域）・高速道路：国土数値情報（国土交通省）を加工。座標は経緯度×1000 の差分符号化', 'prefs': geo['prefs'], 'roads': geo['roads']}
rm = re.search(r'^const REGION_RAW = \{.*?^\};\n', app, re.M | re.S)
region = node_eval(rm.group(0).replace('const REGION_RAW', 'var REGION_RAW'), 'REGION_RAW')
defs = node_eval(kinds.replace('const ', 'var '), 'SITE_DEFS')
if len(defs) != len(sites):
    raise SystemExit('kinds.js の SITE_DEFS と sites.json の件数が合いません')
reg = []
for d, s in zip(defs, sites):
    sel = s['sel']
    e = {'key': sel.get('key'), **d, 'kind': sel['kind'], 'lon': sel['lon'], 'lat': sel['lat'], 'w': sel['w'], 'd': sel['d'], 'sea': sel.get('sea')}
    if sel['kind'] in ('dredge', 'landfill'):   # 海上工事：海底は深浅測量（架空）。国土地理院の標高データは海に無いため台帳に持つ
        tr = s['terr']; e['survey'] = {k: tr[k] for k in ('nx', 'nz', 'src', 'E', 'emin', 'emax', 'emed')}
    reg.append(e)
master = {'note': '地域係数（都道府県別・サンプル値）：[雨天・休止率%, 冬期開始月, 冬期終了月, 冬期の土工稼働率, 残土処分場までの標準距離km]', 'region': region,
          'marine': {'note': '気象・海象タブの作業判断の目安（サンプル値）。水際の工種だけ波の高さ（気象庁の予報の最大値 m）を見る。tideWork：干潮時作業の目安（平均海面より何 cm 低いか）', 'waveCaution': 1.5, 'waveStop': 2.5, 'exposedKinds': ['seawall', 'reclaim', 'yard', 'dredge', 'landfill'], 'tideWork': {'belowMslCm': 20},
                     'workCriteria': {'caisson': {'label': 'ケーソン据付', 'waveMax': 0.8, 'windowHours': 4, 'dayStart': 7, 'dayEnd': 17, 'slackRateMax': 15, 'roles': ['wall'], 'note': '波が小さく、潮の変化がゆるやかな時間（転流前後）が日中に続くこと'},
                                      'lowtide': {'label': '干潮時の作業', 'waveMax': None, 'windowHours': 2, 'dayStart': 6, 'dayEnd': 18, 'belowMslCm': 20, 'roles': ['wall', 'earth'], 'note': '平均海面より 20cm 以上低い時間が日中に続くこと'},
                                      'marine': {'label': '海上作業（一般）', 'waveMax': 1.2, 'windowHours': 6, 'dayStart': 7, 'dayEnd': 17, 'roles': ['earth', 'wall'], 'note': '波が基準以下で、日中に作業時間がとれること'}},
                     'surveyTolerance': {'note': '深浅測量の出来形の色分け（サンプル値）：浚渫は計画より dredgeTol m 以上浅いと取り残し、dredgeOver m を超えて深いと余掘り超過。埋立は ±fillTol m', 'dredgeTol': 0.1, 'dredgeOver': 0.5, 'fillTol': 0.3}},
          'tide': json.load(open(os.path.join(HERE, 'tide_stations.json'), encoding='utf-8')),
          'vessels': json.load(open(os.path.join(HERE, 'vessels_demo.json'), encoding='utf-8'))['vessels']}
# 台帳の選択肢（サーバ版の現場の登録・編集で、サーバが入力を確かめる）。画面の KINDS・BRANCHES・SOILS から作る（1か所が正）
CCATS = ['国', '自治体', '港湾管理者', '民間']
if any(d['ccat'] not in CCATS for d in defs):
    raise SystemExit('SITE_DEFS に CCATS に無い発注者の区分があります')
lk = node_eval(kinds.replace('const ', 'var '), "Object.fromEntries(Object.entries(KINDS).map(([k,v])=>[k,{label:v.label,cat:v.cat,type:v.type,marine:!!v.marine,fh:v.fh}]))")
for d, s in zip(defs, sites):
    k = s['sel']['kind']
    if lk[k]['marine']:
        lk[k].setdefault('design', d.get('design'))
        lk[k].setdefault('seabed', round(s['terr']['emed'], 1))
sm = re.search(r'^const SOILS = .*;$', app, re.M)
master['ledger'] = {'note': '現場の登録・編集の選択肢（画面の KINDS・BRANCHES・SOILS から生成）。design・seabed は海上工事の初期値（サンプル）',
                    'kinds': lk, 'branches': node_eval(kinds.replace('const ', 'var '), 'BRANCHES'),
                    'soils': node_eval(sm.group(0).replace('const ', 'var '), 'Object.fromEntries(Object.entries(SOILS).map(([k,v])=>[k,v.name]))'),
                    'ccats': CCATS, 'seas': ['N', 'E', 'S', 'W'], 'size': {'min': 30, 'max': 600}}

# ---- 3. アプリ本体（埋め込みデータを外し、取得したデータを使う） ----
app = app[:m.start()] + 'const GEO = window.GEO;  // 起動時に loader.js が取得して組み立てる（data/*.json と国土地理院）' + app[m.end():]
app = app[:app.index(rm.group(0))] + 'const REGION_RAW = GEO.region;  // data/master.json（サンプル値）\n' + app[app.index(rm.group(0)) + len(rm.group(0)):]
sd = re.search(r'^const SITE_DEFS = \[.*?^\];\n', app, re.M | re.S)
app = app[:sd.start()] + 'const SITE_DEFS = GEO.defs;  // data/sites.json（現場台帳。すべて架空）\n' + app[sd.end():]
a0 = app.index('// 住所文字列 → 市区町村代表点（ABR 派生・オフライン）\nfunction lookupAddress(q){'); a1 = app.index('/* =====', a0)
app = app[:a0] + r"""// 住所文字列 → 位置（国土地理院 住所検索・オンライン）。結果が届いたら台帳を描き直す
const ADDR={q:'',res:[],timer:null,enter:''};
const normQ=q=>(q||'').normalize('NFKC').trim();
function lookupAddress(q){
  const t=normQ(q); if(t.length<2) return [];
  if(ADDR.q===t) return ADDR.res;
  clearTimeout(ADDR.timer);
  ADDR.timer=setTimeout(async()=>{ try{
      const r=await fetch('https://msearch.gsi.go.jp/address-search/AddressSearch?q='+encodeURIComponent(t)); if(!r.ok) return;
      const j=await r.json(); ADDR.q=t;
      ADDR.res=(Array.isArray(j)?j:[]).filter(f=>f&&f.geometry&&f.properties).slice(0,3).map(f=>({label:f.properties.title,lon:+f.geometry.coordinates[0],lat:+f.geometry.coordinates[1],level:'国土地理院 住所検索'}));
      if(normQ(state.q)===t){ renderLedger(); if(ADDR.enter===t&&ADDR.res[0]&&!useG()){ const c=ADDR.res[0]; showMark(c.lon,c.lat,c.label); } }
      if(ADDR.enter===t) ADDR.enter='';
    }catch(e){ console.warn('address search',e); } },350);
  return [];
}

""" + app[a1:]
app = rep(app, '<small>ABR代表点（${c.level}）・オフライン照合</small>', '<small>${esc(c.level)}（オンライン）</small>')
app = rep(app, "const c=lookupAddress(state.q)[0]; if(c) showMark(c.lon,c.lat,c.label); } }", "const c=lookupAddress(state.q)[0]; if(c) showMark(c.lon,c.lat,c.label); else ADDR.enter=normQ(state.q); } }")
app = rep(app, '地図への住所表示（ABR 照合）を止めています', '地図への住所表示（国土地理院の住所検索）を止めています')
app = rep(app, '検索欄に住所を入れると、ABRの代表点で位置をオフライン照合します。', '検索欄に住所を入れると、国土地理院の住所検索（オンライン）で位置を探します。')
app = rep(app, "const EMBED_GOOGLE_KEY = '';", "const EMBED_GOOGLE_KEY = (window.PORTAL_CONFIG&&String(window.PORTAL_CONFIG.googleMapTilesKey||'').trim())||'';  // data/config.json（サーバにだけ置く）")
app = rep(app, 'labels:true,roads:true}', 'labels:true,roads:false,photo:false}')
app = rep(app, "['route','搬出ルート'],['labels','ラベル']]", "['route','搬出ルート'],['labels','ラベル'],['photo','航空写真']]")
app = rep(app, "[['roads','県境・高速道路'],['labels','ラベル']]", "[['photo','航空写真'],['roads','県境・高速道路'],['labels','ラベル']]")
app = rep(app, "if(k==='roads'||k==='g3d') mapDirty=true;", "if(k==='roads'||k==='g3d') mapDirty=true; if(k==='photo') setBaseMap();")
app = rep(app, '/* ---- 初期化・毎フレーム処理 ---- */', r"""/* ---- 背景地図：国土地理院 地理院タイル（淡色地図／航空写真）。Google 実写3D の表示中は地球ごと隠れる ---- */
function setBaseMap(){ if(!G.viewer) return; const L=G.viewer.imageryLayers; if(G.base) L.remove(G.base,true);
  const photo=state.layers.photo, url=photo?'https://cyberjapandata.gsi.go.jp/xyz/seamlessphoto/{z}/{x}/{y}.jpg':'https://cyberjapandata.gsi.go.jp/xyz/pale/{z}/{x}/{y}.png';
  G.base=L.addImageryProvider(new C3.UrlTemplateImageryProvider({url, minimumLevel:2, maximumLevel:18, rectangle:C3.Rectangle.fromDegrees(122,20,154,46.5),
    credit:new C3.Credit('<a href="https://maps.gsi.go.jp/development/ichiran.html" target="_blank" rel="noopener">地理院タイル</a>'+(photo?'（全国最新写真）':'（淡色地図）'),true)})); }

/* ---- 初期化・毎フレーム処理 ---- */""")
app = rep(app, 'if(G.tileset) G.tileset.show=useG(); v.scene.globe.show=!useG();', 'if(G.tileset) G.tileset.show=useG(); v.scene.globe.show=!useG(); if(G.base) G.base.show=!useG();  // Google 表示中は地理院タイル（とその帰属表示）を出さない')
app = rep(app, 'v.scene.highDynamicRange=false; v.scene.postProcessStages.fxaa.enabled=true; v.scene.fog.enabled=true;',
          'v.scene.highDynamicRange=false; v.scene.postProcessStages.fxaa.enabled=true; v.scene.fog.enabled=true; setBaseMap();')
app = rep(app, "$('#basedate').textContent=`基準日（実績の最終観測）${ds(B)}`;",
          "$('#basedate').textContent=`基準日（実績の最終観測）${ds(B)}`;\nif(GEO.fetched) $('#basedate').title=`データ取得 ${new Date(GEO.fetched.at).toLocaleString('ja-JP')}（国土地理院・自社サーバ）`;")
app = rep(app, 'if(initViewer()){', "if(GEO.fetched&&GEO.fetched.failed.length) setTimeout(()=>toast(`データを取得できなかった現場があります（${GEO.fetched.failed.length}件）。その現場を除いて表示しています。<br>${GEO.fetched.failed.map(esc).join('<br>')}`,15000),2500);\nif(initViewer()){")

# ---- 3b. 業務機能（気象・海象／実績入力デモ／CSV／印刷）を組み込む ----
biz = open(bizf, encoding='utf-8').read().rstrip() + '\n\n' + open(featf, encoding='utf-8').read().rstrip() + '\n\n' + open(planf, encoding='utf-8').read().rstrip() + '\n\n' + open(srvf, encoding='utf-8').read().rstrip() + '\n\n' + open(opsf, encoding='utf-8').read().rstrip() + '\n\n' + open(trendf, encoding='utf-8').read().rstrip() + '\n\n' + open(ledgerf, encoding='utf-8').read()
app = rep(app, '/* =====================================================================\n   10. 3Dビュー（CesiumJS', biz.rstrip() + '\n\n/* =====================================================================\n   10. 3Dビュー（CesiumJS')
app = rep(app, "pref:g.pref, city:g.city, town:g.town, addr:", "pref:g.pref, city:g.city, town:g.town, lgcode:g.lgcode, addr:")
app = rep(app, "if(key) connectGoogle(key); else { setStatus('simple'); openKeyDialog(); }", "if(key) connectGoogle(key); else { setStatus('simple'); if(!window.PORTAL_SERVER) openKeyDialog(); }   // サーバ版のキーは管理者が server/.env に置く")
app = rep(app, "name:def.name, kind:g.kind,", "key:def.key, name:def.name, kind:g.kind,")
# 工事番号：台帳（DB）に固定した番号（data.no）があればそれを使う（無い静的な配信では、これまでどおり並び順から数える）
# 地図のクリック：現場の登録で位置を指定している間は、全国表示の「ピン・都道府県の選択」より先に、その指定に使う
app = rep(app, "hd.setInputAction(e=>{ if(state.mode!=='nation') return;", "hd.setInputAction(e=>{ if(window.PICK_HOOK){ window.PICK_HOOK(e.position); return; } if(state.mode!=='nation') return;")
app = rep(app, "const s={ id:`${def.br}-${fy}-${String(sq).padStart(4,'0')}`,", "const s={ id:def.no||`${def.br}-${fy}-${String(sq).padStart(4,'0')}`,")
# 画面で登録した現場（sample:false）は、架空の実績を作らない（実績は入力した分だけ）
app = rep(app, "  s.tasks.forEach(t=>{ const pp=planP(t,B); let a = pp>=1", "  if(def.sample===false) s.tasks.forEach(t=>{ t.a=0; }); else s.tasks.forEach(t=>{ const pp=planP(t,B); let a = pp>=1")
# 支店ごとの閲覧範囲（サーバ版）：絞り込みが無いときの呼び名は「全社」ではなく、見られる支店にする
app = rep(app, ".filter(Boolean).join('・') || '全社';", ".filter(Boolean).join('・') || (window.PORTAL_SERVER&&Array.isArray(PORTAL_SERVER.user.branches)?(PORTAL_SERVER.user.branches.map(b=>BRANCHES[b]||b).join('・')||'閲覧範囲なし')+'（閲覧範囲）':'全社');")   # 台帳（DB）のキー：実績の保存に使う
app = rep(app, "['sched','工程管理'],['wm','ワールドモデル']];", "['sched','工程管理'],['wm','ワールドモデル'],['wx','気象・海象'],['tide','潮位'],['work','作業可能日'],['fleet','配船'],['survey','測量の比較'],['consult','協議・区域'],['ai','遅れの分析'],['cmp','類似工事'],['prog','実績入力']];")
app = rep(app, "sched:renderSchedTab,wm:renderWMTab})[state.tab](s);", "sched:renderSchedTab,wm:renderWMTab,wx:renderWxTab,tide:renderTideTab,work:renderWorkTab,fleet:renderFleetTab,survey:renderSurveyTab,consult:renderConsultTab,ai:renderAiTab,cmp:renderCmpTab,prog:renderProgTab})[state.tab](s);")
app = rep(app, "<span>${esc(s.cat)}・${esc(s.k.label)}</span>${delayBadge(s)}</div>", "<span>${esc(s.cat)}・${esc(s.k.label)}</span>${delayBadge(s)}${wxBadge(s)}</div>")
app = rep(app, "  if(state.chip==='delay' && delayOf(s)<=14) return false;", "  if(state.chip==='delay' && delayOf(s)<=14) return false;\n  if(state.chip==='wx' && !(wxLevel(s)>0)) return false;")
app = rep(app, "      ${branchTable()}", "      ${wxSummaryHTML()}${branchTable()}")
app = rep(app, '<button class="btn ghost" id="goNation">◀ 全国へ</button></div>`;', '<button class="btn ghost" id="goNation">◀ 全国へ</button><button class="btn ghost" id="printSite">🖨 現場概要を印刷</button></div>`;')
app = rep(app, "$('#goNation').onclick=()=>select(null);", "$('#goNation').onclick=()=>select(null); $('#printSite').onclick=()=>printSite(s);")
app = rep(app, '<h3>現場別サマリ <small>${ds(state.T)} 時点・行クリックで現場へ</small></h3>', '<h3>現場別サマリ <small>${ds(state.T)} 時点・行クリックで現場へ</small><button class="btn ghost" id="csvOut" style="margin-left:auto">CSV 出力</button></h3>')
app = rep(app, "function bindPortfolio(){ $('#dockBody').onclick=e=>{ const r=e.target.closest('tr.click'); if(r) select(r.dataset.id); }; }",
          "function bindPortfolio(){ $('#dockBody').onclick=e=>{ if(e.target.closest('#csvOut')){ exportCSV(); return; } const r=e.target.closest('tr.click'); if(r) select(r.dataset.id); }; }")

# ---- 4. HTML（骨組み・起動画面） ----
html = rep(html, '<title>みらい建設工業 3D現場ポータル</title>', '<title>みらい建設工業 3D現場ポータル（オンライン版）</title>')
c0 = html.index('<!--\n'); c1 = html.index('-->\n', c0) + 4
html = html[:c0] + '''<!--
  みらい建設工業 3D現場ポータル オンライン版（港湾・海洋土木版／Google 3D／World Model サンプル）
  - データはすべて起動時にオンラインで取得する（このファイルには埋め込まない）。Webサーバ（http/https）に置いて開く。
    ・自社サーバ：data/sites.json（現場台帳）、data/master.json（地域係数）、data/japan.json（都道府県・高速道路の形）
    ・国土地理院：標高タイル（現場の地形・周辺1km）、逆ジオコーダ（所在地）、住所検索、地理院タイル（背景地図）
    ・Google Map Tiles API（Photorealistic 3D Tiles）：周辺の街並み（APIキーがあるとき）
    ・CesiumJS（cdn.jsdelivr.net）：3D描画
  - 工事名・発注者・工程・実績・計画はすべて架空（サンプル）で、みらい建設工業の実際の工事ではない。工事番号は仮採番。地域係数・機械能力はサンプル値。
  - 計算（台帳・土量・工程・ワールドモデル）はオフライン版と共通。生成：tools/build_online.py
-->
''' + html[c1:]
html = rep(html, '<span class="tag jp">Google 3D版</span>', '<span class="tag jp">オンライン版</span>')
html = rep(html, '    <button class="btn ghost" id="keyBtn"', '    <button class="btn ghost" id="tourBtn" title="遅れの大きい順に現場を自動で巡回（支店会議用）">📋 会議巡回</button>\n    <button class="btn ghost" id="presentBtn" title="発注者・漁協などへの説明用：完成後の姿と工程（計画）だけを表示">🗣 説明モード</button>\n    <button class="btn ghost" id="keyBtn"')
html = rep(html, '      <div class="toast" id="toast" hidden></div>', '      <div class="toast" id="toast" hidden></div>\n      <div class="tourbar" id="tourBar" hidden></div>\n      <div class="presentbanner" id="presentBanner" hidden>説明モード：完成後の姿と工程（計画）を表示しています（架空の工事）<button class="btn ghost" id="presentEnd">終了</button></div>')
html = rep(html, '[hidden]{display:none!important}', """[hidden]{display:none!important}
.dlg{z-index:300000!important}   /* 3D のラベル（z-index 最大 100000）より手前に出す */
.siteForm{position:fixed;top:56px;right:8px;bottom:8px;width:min(420px,calc(100vw - 16px));z-index:250000;background:#0b1424;border:1px solid var(--line);border-radius:10px;box-shadow:0 10px 30px rgba(0,0,0,.5);display:flex;flex-direction:column}
.siteForm[hidden]{display:none}body.picking #labels,body.picking #labels *{pointer-events:none!important}body.picking #view canvas{cursor:crosshair}.siteForm .sfHead{display:flex;align-items:center;gap:8px;padding:10px 12px;border-bottom:1px solid var(--line)}.siteForm .sfHead .btn{margin-left:auto}
.siteForm .sfBody{overflow:auto;padding:10px 12px}.siteForm .sfSec{font-size:12px;color:var(--muted);margin:12px 0 6px;border-bottom:1px solid var(--line)}
.siteForm .sfGrid{grid-template-columns:auto 1fr;gap:6px 8px}.siteForm input,.siteForm select{width:100%;text-align:left;background:#0a1323;color:var(--text);border:1px solid var(--line);border-radius:6px;padding:4px 6px}
.siteForm .sfCheck{margin:6px 0;line-height:1.6}.siteForm .sfDet{margin-top:12px;border:1px solid var(--line);border-radius:8px;padding:6px 8px}.siteForm .sfDet summary{cursor:pointer;font-size:12.5px}.siteForm .sfV{display:flex;align-items:center;gap:4px;font-size:11.5px;color:var(--muted);margin-top:2px}.siteForm .sfV input{width:auto}.siteForm .sfPair{display:flex;gap:4px;align-items:center}.siteForm .sfRow{display:grid;grid-template-columns:repeat(auto-fit,minmax(90px,1fr)) auto;gap:4px;margin-bottom:4px}.siteForm textarea{width:100%;background:#0a1323;color:var(--text);border:1px solid var(--line);border-radius:6px;padding:4px 6px;margin-top:4px}.sumContract dl{margin:0}.siteForm .sfCheck .btn{margin-left:6px}
.workcal{display:grid;grid-template-columns:repeat(auto-fill,minmax(64px,1fr));gap:4px;margin-bottom:8px}
.wc{border-radius:6px;padding:4px 5px;font-size:10.5px;line-height:1.35;background:#1f2b45;border:2px solid transparent;display:flex;flex-direction:column}
.wc b{font-size:12px}.wc span{color:var(--muted)}.wc i{font-style:normal}.wc.ok{background:#0f3a24}.wc.tide{background:#3a2c10}.wc.ng{background:#3a1820;opacity:.8}.wc.nodata{opacity:.45}.wc.inwin{border-color:#60a5fa}
.wc-sw{display:inline-block;width:12px;height:10px;border-radius:2px;margin-right:4px;vertical-align:middle;background:#1f2b45}.wc-sw.ok{background:#0f3a24}.wc-sw.tide{background:#3a2c10}.wc-sw.ng{background:#3a1820}.wc-sw.inwin{border:2px solid #60a5fa}
#printSheet .ps-site{page-break-inside:avoid;margin-top:10px}
.userchip{font-size:12px;color:var(--muted);white-space:nowrap;border:1px solid var(--line);border-radius:999px;padding:3px 10px}
.loginForm label{display:block;font-size:12px;color:var(--muted);margin:8px 0}.loginForm input{display:block;width:100%;margin-top:4px;padding:9px 11px;border-radius:9px;border:1px solid var(--line);background:#0a1323;color:var(--text);font-size:14px}
.loginErr{color:#fca5a5!important;font-size:12.5px}
.tourbar{position:absolute;left:50%;top:52px;transform:translateX(-50%);z-index:6;display:flex;align-items:center;gap:8px;flex-wrap:wrap;max-width:calc(100% - 24px);background:rgba(13,22,40,.94);border:1px solid #f59e0b;border-radius:10px;padding:6px 10px;font-size:12.5px;overflow:hidden}
.tourbar button,.tourbar select{background:#1d2b4a;border:1px solid #33497a;color:#fff;border-radius:6px;padding:3px 8px;font-size:12px;cursor:pointer}
.tourbar .tn{font-weight:600}.tourbar .tprog{position:absolute;left:0;bottom:0;height:3px;background:var(--accent)}
#tourBtn.on,#presentBtn.on{border-color:var(--accent);color:#fde68a}
.presentbanner{position:absolute;left:50%;top:10px;transform:translateX(-50%);z-index:6;background:rgba(255,255,255,.95);color:#0f172a;border:2px solid #1d4ed8;border-radius:10px;padding:6px 12px;font-size:13px;font-weight:600;display:flex;gap:10px;align-items:center}
.presentbanner .btn{color:#1d4ed8;border-color:#1d4ed8;background:#fff}
body.present .row .badge,body.present .row .sid,body.present .row .r3,body.present #timeline,body.present .modeflag,body.present #labels,body.present .fiction,
body.present #chips [data-chip="delay"],body.present #chips [data-chip="wx"],body.present #chips [data-chip="官公庁"],body.present #chips [data-chip="民間"],body.present #tourBtn,body.present #brSel,body.present .tools [data-view="spin"]{display:none!important}""")
html = rep(html, '      <button class="chip" data-chip="delay">遅延予測</button>', '      <button class="chip" data-chip="delay">遅延予測</button>\n      <button class="chip" data-chip="wx" title="気象庁の警報・注意報や波の高さで、作業に注意がいる現場">気象注意</button>')
html = rep(html, '[hidden]{display:none!important}', '''[hidden]{display:none!important}
.wxsum{background:var(--panel2);border-radius:10px;padding:8px 10px;margin:0 0 10px;font-size:12px;line-height:1.7}.wxrow{display:flex;gap:6px;align-items:center;font-size:11.5px;color:#cbd5e1}
#printSheet{display:none}
@media print{ body.printing #app,body.printing #boot,body.printing .dlg{display:none!important} body.printing{background:#fff;color:#111;overflow:visible;height:auto}
  body.printing #printSheet{display:block;font-size:11pt;color:#111;padding:0 4mm} #printSheet h1{font-size:16pt;margin:4px 0} #printSheet h2{font-size:12pt;margin:12px 0 4px;border-bottom:1px solid #999}
  .ps-head{display:flex;justify-content:space-between;font-size:9pt;color:#444;border-bottom:2px solid #1f4fa3;padding-bottom:3px} .ps-warn{color:#9a3412;font-size:9.5pt;margin:2px 0 8px}
  .ps-t{width:100%;border-collapse:collapse;font-size:9.5pt;margin:4px 0} .ps-t th,.ps-t td{border:1px solid #bbb;padding:3px 5px;text-align:left;vertical-align:top} .ps-t th{background:#f1f5f9;white-space:nowrap}
  .ps-g svg{width:100%;height:auto;background:#0f172a} .ps-note{font-size:8.5pt;color:#555} @page{size:A4;margin:12mm} }''')
html = rep(html, '（<code>tile.googleapis.com</code>・<code>cdn.jsdelivr.net</code>）が必要です。',
           '（<code>tile.googleapis.com</code>・<code>cdn.jsdelivr.net</code>・国土地理院の <code>cyberjapandata.gsi.go.jp</code>・<code>mreversegeocoder.gsi.go.jp</code>・<code>msearch.gsi.go.jp</code>・<code>maps.gsi.go.jp</code>・気象庁の <code>www.jma.go.jp</code>）が必要です。')
html = rep(html, '／3D都市・地形：Google（帰属表示は3Dビュー左下）／描画：CesiumJS</div>',
           '／背景地図・標高・所在地・住所検索：国土地理院（起動時にオンラインで取得）／3D都市・地形：Google（帰属表示は3Dビュー左下）／描画：CesiumJS</div>')
html = rep(html, '</style>', '''#boot{position:fixed;inset:0;z-index:2000;background:rgba(3,7,18,.86);display:grid;place-items:center;padding:16px}
.bootBox{width:min(560px,100%);background:var(--panel);border:1px solid #33497a;border-radius:14px;padding:18px 20px;box-shadow:0 20px 60px rgba(0,0,0,.5)}
.bootBox h2{font-size:16px;margin:0 0 8px}.bootBox p{font-size:12.5px;line-height:1.7;color:#cbd5e1;margin:0 0 10px}
.bootTrack{height:6px;background:#0a1323;border-radius:3px;overflow:hidden;margin:4px 0 10px}.bootTrack i{display:block;height:100%;width:0;background:var(--accent);transition:width .2s}
#boot.err .bootTrack{display:none}#bootErr{font-size:12px;color:#fecaca;line-height:1.6}#bootErr ul{margin:4px 0 10px;padding-left:18px;max-height:40vh;overflow:auto}
.bootNote{font-size:11px!important;color:var(--muted)!important}
</style>''')
html = rep(html, '<div id="app">', '''<div id="boot"><div class="bootBox" role="status" aria-live="polite"><h2>みらい建設工業 3D現場ポータル（オンライン版）</h2>
  <p id="bootMsg">データを取得しています…</p><div class="bootTrack"><i id="bootBar"></i></div><div id="bootErr"></div>
  <p class="bootNote">取得先：自社サーバ（現場台帳・地域係数・都道府県の形）／国土地理院（標高タイル・所在地・住所検索・地図）。工事・発注者・計画はすべて架空のサンプルです。</p></div></div>
<div id="app">''')
html = html.replace('@@LOADER@@', '<script src="loader.js"></script>\n')

# ---- 5. 検査と書き出し ----
for w in ('ABR代表点', 'const GEO = {', 'const SITE_DEFS = [', 'const REGION_RAW = {'):
    if w in app or w in html:
        raise SystemExit('旧仕様が残っています: ' + w)
os.makedirs(os.path.join(outd, 'data'), exist_ok=True)
dump = lambda p, o: open(os.path.join(outd, p), 'w', encoding='utf-8').write(json.dumps(o, ensure_ascii=False, separators=(',', ':')))
open(os.path.join(outd, 'index.html'), 'w', encoding='utf-8').write(html)
open(os.path.join(outd, 'app.js'), 'w', encoding='utf-8').write(app)
open(os.path.join(outd, 'loader.js'), 'w', encoding='utf-8').write(open(loaderf, encoding='utf-8').read())
dump('data/config.example.json', {'googleMapTilesKey': '', 'note': 'config.json にコピーしてキーを入れ、Webサーバにだけ置く。キーは HTTPリファラ制限（このサイトのURL）と API制限（Map Tiles API のみ）を付けたものに限る。配布物・リポジトリには入れない'})
if os.path.exists(os.path.join(outd, 'data', 'config.json')): print('注意：data/config.json があります（キー入り。配布しないこと）')
dump('data/sites.json', reg); dump('data/master.json', master); dump('data/japan.json', japan)
for p in ('index.html', 'app.js', 'loader.js', 'data/sites.json', 'data/master.json', 'data/japan.json'):
    print(f'{p:18s} {os.path.getsize(os.path.join(outd, p)):>9,} bytes')
