#!/usr/bin/env python3
"""みらい建設工業版 3D現場ポータル（単一HTML）を、原本 3D-Portal-Google3D.html から生成する。

使い方：python3 build_app.py <原本HTML> <sites.json> <kinds.js> <出力HTML>
- 原本は読むだけで変更しない。置換はすべて「出現回数の一致」を確認してから行う。
"""
import json, re, sys

src, sitesf, kindsf, outf = sys.argv[1:5]
t = open(src, encoding='utf-8').read()
sites = json.load(open(sitesf, encoding='utf-8'))
kinds = open(kindsf, encoding='utf-8').read().rstrip() + '\n'

def rep(old, new, n=1):
    global t
    c = t.count(old)
    if c != n:
        raise SystemExit(f'置換対象の出現回数が {c}（期待 {n}）: {old[:120]!r}')
    t = t.replace(old, new)

# ---- 0. 埋め込みデータ：GEO.sel / GEO.terr を港湾の現場に入れ替える ----
m = re.search(r'^const GEO = (\{.*\});$', t, re.M)
geo = json.loads(m.group(1))
geo['sel'] = [{k: s['sel'][k] for k in ('pref', 'city', 'town', 'lgcode', 'kind', 'w', 'd', 'lon', 'lat', 'sea')} for s in sites]
geo['terr'] = [{k: v for k, v in s['terr'].items() if k != 'seaFrac'} for s in sites]
t = t[:m.start()] + 'const GEO = ' + json.dumps(geo, ensure_ascii=False, separators=(',', ':')) + ';' + t[m.end():]

# ---- 1. 見出し・説明コメント ----
rep('<title>3D現場ポータル Google 3D版</title>', '<title>みらい建設工業 3D現場ポータル</title>')
rep('  3D現場ポータル 全国版（Google 3D版／World Model サンプル）\n',
    '  みらい建設工業 3D現場ポータル（港湾・海洋土木版／Google 3D版／World Model サンプル）\n'
    '  - 原本「3D現場ポータル 全国版（Google 3D版）」を、みらい建設工業の業務（港湾・海岸・陸上土木、7支店・作業所の体制、\n'
    '    発注区分 国／自治体／港湾管理者／民間）に合わせて作り直した版。原本ファイルは変更していない。\n')
rep('  - 現場名・番地・発注者・工程・実績・建物計画はすべて架空（サンプル）。地域係数・機械能力はサンプル値。\n',
    '  - 工事名・発注者・工程・実績・計画はすべて架空（サンプル）で、みらい建設工業の実際の工事ではない。地域係数・機械能力はサンプル値。\n'
    '  - 施工範囲は実在の港湾地区内に自動配置した仮の範囲（標高データのある陸域）。工事番号は仮採番（正式な採番規則は未決）。\n'
    '  - 浚渫・海上工事（海底地形が必要）は対象外。今後の拡張（詳細仕様書 12章）。\n')
rep('   ・アドレス・ベース・レジストリ（デジタル庁）を加工した Geolonia 住所データ v2（CC BY 4.0）\n',
    '   ・アドレス・ベース・レジストリ（デジタル庁）を加工した Geolonia 住所データ v2（CC BY 4.0）\n'
    '   ・現場の所在地：国土地理院 逆ジオコーダ（地方公共団体コード表 muni.js）\n')

# ---- 2. ヘッダー・絞り込み ----
rep('    <h1>3D現場ポータル</h1>\n    <span class="tag jp">全国版</span>',
    '    <h1>みらい建設工業 3D現場ポータル</h1>\n    <span class="tag jp">港湾・海洋土木</span>')
rep('    <span class="tag">SAMPLE・架空の工事</span>',
    '    <span class="tag">SAMPLE・架空の工事</span>\n    <span class="tag">社内限定</span>')
rep('      <select id="prefSel" aria-label="都道府県で絞り込み"></select>\n'
    '      <button class="chip on" data-chip="all">すべて</button>\n'
    '      <button class="chip" data-chip="建築">建築</button>\n'
    '      <button class="chip" data-chip="土木">土木</button>\n',
    '      <select id="brSel" aria-label="支店で絞り込み"></select>\n'
    '      <select id="prefSel" aria-label="都道府県で絞り込み"></select>\n'
    '      <button class="chip on" data-chip="all">すべて</button>\n'
    '      <button class="chip" data-chip="港湾">港湾</button>\n'
    '      <button class="chip" data-chip="海岸">海岸</button>\n'
    '      <button class="chip" data-chip="陸上土木">陸上土木</button>\n'
    '      <button class="chip" data-chip="港湾建築">港湾建築</button>\n'
    '      <button class="chip" data-chip="官公庁">官公庁</button>\n'
    '      <button class="chip" data-chip="民間">民間</button>\n')
rep('#prefSel{background:#0a1323;', '#prefSel,#brSel{background:#0a1323;')
rep('placeholder="工事名・現場ID・住所で検索"', 'placeholder="工事名・工事番号・港・支店・住所で検索"')

# ---- 3. APIキー画面（社内の運用に合わせた注意） ----
rep('    <ul class="dlgNote">\n',
    '    <ul class="dlgNote">\n'
    '      <li>キーは <b>DX推進部</b> が発行・管理する会社のキーを使います。個人のキー・個人の請求先は使わないでください。</li>\n'
    '      <li>社内ネットワークでは <b>FortiGate</b> の通信許可（<code>tile.googleapis.com</code>・<code>cdn.jsdelivr.net</code>）が必要です。つながらないときは DX推進部へ連絡してください。</li>\n')
rep('      <li>工事・建物計画はすべて架空です。実在の建物・土地とは関係ありません。</li>',
    '      <li>工事・発注者・計画はすべて架空です。みらい建設工業の実際の工事、実在の発注者・建物・土地とは関係ありません。</li>')
rep("const KEY_STORE = 'site-portal-google3d-key';", "const KEY_STORE = 'mirai-kensetsu-site-portal-google3d-key';")

# ---- 4. 工種テンプレート・現場定義 ----
rep('   4. 現場（ダミー）定義：位置は ABR 町字代表点、地形は国土地理院 標高タイル',
    '   4. 現場（架空）定義：位置は港湾地区内の仮の施工範囲、地形は国土地理院 標高タイル')
i0 = t.index('// 工種テンプレート：'); i1 = t.index('const SITE_COLORS=')
t = t[:i0] + kinds + t[i1:]

# ---- 5. 現場の生成：工事番号（仮）・支店／作業所・地先表記・水域側の向き ----
rep("""  const def=SITE_DEFS[i], k=KINDS[def.kind], pref=PREFS.find(p=>p.name===g.pref), prefCode=Math.floor(g.lgcode/10000);
  const isChome=/丁目$/.test(g.town), banchi=isChome?`${(i*7)%20+1}-${(i*13)%30+1}`:`${100+i*37}番地`;
  const s={ id:`S-${String(prefCode).padStart(2,'0')}-${String(i+1).padStart(3,'0')}`, name:def.name, kind:def.kind, k, type:k.type,
    pref:g.pref, city:g.city, town:g.town, banchi, addr:`${g.pref}${g.city}${g.town}${banchi}`, machiaza:g.machiaza_id,
    lon:g.lon, lat:g.lat, client:def.client, scale:k.scale, dept:`${k.type==='建築'?'建築':'土木'}部 ${g.pref.replace(/(都|府|県)$/,'')}工事事務所`,
    color:SITE_COLORS[i%SITE_COLORS.length], area:{w:g.w,d:g.d}, rot:0, terr:GEO.terr[i], region:REGION[g.pref],
    gate:{x:Math.round(g.w*.3),z:g.d/2,ox:0,oz:1}, perf:def.perf, soil:def.soil };""",
"""  const def=SITE_DEFS[i], k=KINDS[g.kind], pref=PREFS.find(p=>p.name===g.pref);
  // 工事番号（仮採番）：支店コード-着工年度-連番。正式な採番規則は未決（MCDX-ADR-0008）
  const [sy,sm]=def.start.split('-').map(Number), fy=sm>=4?sy:sy-1, sq=(ID_SEQ[def.br+fy]=(ID_SEQ[def.br+fy]||0)+1);
  const s={ id:`${def.br}-${fy}-${String(sq).padStart(4,'0')}`, name:def.name, kind:g.kind, k, type:k.type, cat:k.cat,
    pref:g.pref, city:g.city, town:g.town, addr:`${g.pref}${g.city}${g.town}地先`, sea:g.sea||null,
    lon:g.lon, lat:g.lat, client:def.client, ccat:def.ccat, scale:k.scale, br:def.br, brName:BRANCHES[def.br], port:def.port,
    dept:`${BRANCHES[def.br]} 工事部 ${def.port}作業所`,
    color:SITE_COLORS[i%SITE_COLORS.length], area:{w:g.w,d:g.d}, rot:0, terr:GEO.terr[i], region:REGION[g.pref],
    gate:gateFor(g), perf:def.perf, soil:def.soil };""")
rep('const SITES = GEO.sel.map((g,i)=>{',
    """const ID_SEQ={};
// 工事用ゲート：水域に接する辺の反対側（陸側）に置く
function gateFor(g){ const sea=g.sea;
  if(sea==='S') return {x:Math.round(g.w*.3),z:-g.d/2,ox:0,oz:-1};
  if(sea==='E') return {x:-g.w/2,z:Math.round(g.d*.2),ox:-1,oz:0};
  if(sea==='W') return {x:g.w/2,z:Math.round(g.d*.2),ox:1,oz:0};
  return {x:Math.round(g.w*.3),z:g.d/2,ox:0,oz:1}; }
const SITES = GEO.sel.map((g,i)=>{""")
rep('  s.blocks=k.blocks(g.w,g.d); s.pit=k.pit;', "  s.blocks=k.blocks(g.w,g.d,g.sea||'S'); s.pit=k.pit;")
rep('  // 計画地盤高：建築＝現況中央値+0.3m、造成＝切盛バランス高（二分法）',
    '  // 計画地盤高：balance＝切盛バランス高（二分法）、raise＝現況中央値＋嵩上げ高、bldg＝現況中央値+0.3m')
rep("  if(k.type==='土木'){ let lo=s.yRef-15, hi=s.yRef+15;", "  if(k.fh==='balance'){ let lo=s.yRef-15, hi=s.yRef+15;")
rep("  else s.FH=Math.round((s.terr.emed+.3)*10)/10;",
    "  else if(k.fh==='raise') s.FH=Math.round((s.terr.emed+k.raise)*10)/10;\n  else s.FH=Math.round((s.terr.emed+.3)*10)/10;")

# ---- 6. 台帳・絞り込み（支店・工種区分・発注区分） ----
rep("const state={ mode:'nation', sel:null, q:'', chip:'all', pref:'',", "const state={ mode:'nation', sel:null, q:'', chip:'all', pref:'', br:'',")
rep("""  if(state.chip==='建築' && s.type!=='建築') return false;
  if(state.chip==='土木' && s.type!=='土木') return false;""",
"""  if(state.br && s.br!==state.br) return false;
  if(['港湾','海岸','陸上土木','港湾建築'].includes(state.chip) && s.cat!==state.chip) return false;
  if(state.chip==='官公庁' && s.ccat==='民間') return false;
  if(state.chip==='民間' && s.ccat!=='民間') return false;""")
rep("  return [s.id,s.name,s.addr,s.client,s.type,s.k.label,s.dept].some(v=>normText(v).includes(q));",
    "  return [s.id,s.name,s.addr,s.client,s.ccat,s.cat,s.k.label,s.dept,s.port,s.brName].some(v=>normText(v).includes(q));")
rep('const filtered = () => SITES.filter(matches);',
    """const filtered = () => SITES.filter(matches);
// 支店・都道府県の絞り込み（ポートフォリオ・サマリの集計範囲）
const inScope = s => (!state.br||s.br===state.br) && (!state.pref||s.pref===state.pref);
const scopeName = () => [state.br?BRANCHES[state.br]:'', state.pref].filter(Boolean).join('・') || '全社';""")
rep("""    PREFS.filter(p=>!cnt[p.name]).map(p=>`<option value="${p.name}">${p.name}（0）</option>`).join('')+`</optgroup>`; })();""",
"""    PREFS.filter(p=>!cnt[p.name]).map(p=>`<option value="${p.name}">${p.name}（0）</option>`).join('')+`</optgroup>`;
  const bc={}; for(const s of SITES) bc[s.br]=(bc[s.br]||0)+1;
  $('#brSel').innerHTML=`<option value="">全支店</option>`+Object.entries(BRANCHES).map(([k,n])=>`<option value="${k}">${n}（${bc[k]||0}）</option>`).join(''); })();
function setBranch(br){
  state.br=br; $('#brSel').value=br; mapDirty=true; sceneDirty=true; renderLedger(); renderSummary(); if(!state.sel) renderDock();
  if(state.mode!=='nation') return; const set=SITES.filter(s=>!br||s.br===br);
  if(!br||!set.length){ flyHome(1.6); return; }
  const b=[Math.min(...set.map(s=>s.lon))-.6,Math.min(...set.map(s=>s.lat))-.45,Math.max(...set.map(s=>s.lon))+.6,Math.max(...set.map(s=>s.lat))+.45];
  flyPref({main:b}); }""")
rep("$('#prefSel').addEventListener('change',e=>{ if(state.sel) select(null,false); setPref(e.target.value); });",
    "$('#prefSel').addEventListener('change',e=>{ if(state.sel) select(null,false); setPref(e.target.value); });\n"
    "$('#brSel').addEventListener('change',e=>{ if(state.sel) select(null,false); setBranch(e.target.value); });")
rep("<span>${esc(s.type)}・${esc(s.k.label)}</span>${delayBadge(s)}", "<span>${esc(s.cat)}・${esc(s.k.label)}</span>${delayBadge(s)}")
rep("set=SITES.filter(x=>!state.pref||x.pref===state.pref)", "set=SITES.filter(inScope)")
rep("${state.pref?esc(state.pref):'全国'}（基準日 ${ds(B)}）", "${esc(scopeName())}（基準日 ${ds(B)}）")
rep("""<p class="hint">日本地図の現場ピン、または台帳の行を選ぶと、その現場の3D（周辺は Google 実写3D）へ移動します。都道府県をクリックすると絞り込みます。""",
    """<p class="hint">日本地図の現場ピン、または台帳の行を選ぶと、その現場の3D（周辺は Google 実写3D）へ移動します。支店・都道府県・工種区分・発注区分で絞り込めます。""")
rep("""      <div class="foot">現場名・番地・発注者・工程・建物計画はすべて架空（サンプル）です。位置は実在の町字代表点、施工範囲の地形は国土地理院の標高データ、周辺の街並みは Google の実写3D（オンライン）です。地域係数はサンプル値です。</div>`;""",
    """      ${branchTable()}
      <div class="foot">工事名・発注者・工程・計画はすべて架空（サンプル）で、みらい建設工業の実際の工事ではありません。位置は実在の港湾地区内に置いた仮の施工範囲、施工範囲の地形は国土地理院の標高データ、周辺の街並みは Google の実写3D（オンライン）です。工事番号は仮採番、地域係数はサンプル値です。</div>`;""")
rep("""<span class="sid">${esc(s.id)}</span><span>・${esc(s.type)}</span>${delayBadge(s)}""",
    """<span class="sid">${esc(s.id)}</span><span>・${esc(s.cat)}</span>${delayBadge(s)}""")
rep("""<span style="color:var(--muted);font-size:11px">番地はダミー。位置＝ABR 町字代表点（${esc(s.machiaza||'')}）<br>${s.lat.toFixed(5)}, ${s.lon.toFixed(5)}</span></dd>
      <dt>発注者</dt><dd>${esc(s.client)}</dd><dt>構造・規模</dt><dd>${esc(s.scale)}</dd>""",
"""<span style="color:var(--muted);font-size:11px">${esc(s.port)}の港湾地区内に置いた仮の施工範囲（中心）。住所は国土地理院 逆ジオコーダ<br>${s.lat.toFixed(5)}, ${s.lon.toFixed(5)}${s.sea?`／水域側：${({N:'北',S:'南',E:'東',W:'西'})[s.sea]}`:''}</span></dd>
      <dt>工事番号</dt><dd>${esc(s.id)} <span class="badge" style="margin-left:4px">仮採番</span></dd>
      <dt>担当</dt><dd>${esc(s.dept)}</dd>
      <dt>発注者</dt><dd>${esc(s.client)}<br><span style="color:var(--muted);font-size:11px">発注区分：${esc(s.ccat)}</span></dd><dt>工種・規模</dt><dd>${esc(s.k.label)}／${esc(s.scale)}</dd>""")

# ---- 7. 土量（不足分は搬入土：購入土・浚渫土の流用） ----
rep("'不足＝購入土（地山）'", "'不足＝搬入土（地山）'")
rep('<tr><td>購入土（ほぐし）</td>', '<tr><td>搬入土（購入土・浚渫土流用、ほぐし）</td>')
rep('<td>Vc＋購入土</td>', '<td>Vc＋搬入土</td>')
rep('ゲートで残土・購入土を受け払いした場合', 'ゲートで残土・搬入土を受け払いした場合')
rep('状態 S(t)＝実地形（ABR座標×標高タイル）', '状態 S(t)＝実地形（港湾地区の座標×標高タイル）')
rep("'実績・ABR・標高'", "'実績・住所・標高'")

# ---- 8. ポートフォリオ（支店別の集計・工程の行ラベル） ----
rep("""  return `<table class="t"><tr><th>ID</th><th>工事名</th><th>都道府県</th>""",
    """  return `<table class="t"><tr><th>工事番号</th><th>工事名</th><th>担当支店</th>""")
rep("""<td class="nw">${esc(s.pref)}</td>""", """<td class="nw">${esc(s.brName)}</td>""")
rep("""</table><div class="note">土量 m³（切土：地山、盛土：締固め後、残土：ほぐし）。</div>`; }""",
    """</table><div class="note">土量 m³（切土：地山、盛土：締固め後、残土：ほぐし）。工事番号は仮採番。</div>`; }
function branchTable(){ const rows=Object.entries(BRANCHES).filter(([k])=>!state.br||k===state.br).map(([k,n])=>{ const set=SITES.filter(s=>s.br===k&&(!state.pref||s.pref===state.pref)); if(!set.length) return '';
    const late=set.filter(s=>delayOf(s)>14).length, avg=Math.round(set.reduce((a,s)=>a+actualAtBase(s),0)/set.length*100);
    return `<tr><td>${esc(n)}</td><td class="n">${set.length}</td><td class="n">${avg}%</td><td class="n ${late?'late':''}">${late}</td></tr>`; }).join('');
  return rows?`<table class="t" style="margin-bottom:10px"><tr><th>支店</th><th class="n">現場</th><th class="n">平均進捗</th><th class="n">遅延予測</th></tr>${rows}</table>`:''; }""")
rep("const set=SITES.filter(s=>!state.pref||s.pref===state.pref);", "const set=SITES.filter(inScope);", 2)
rep("function regionTable(){ const prefs=[...new Set(SITES.map(s=>s.pref))].filter(p=>!state.pref||p===state.pref);",
    "function regionTable(){ const prefs=[...new Set(SITES.filter(inScope).map(s=>s.pref))];")
rep("W=620, LW=96, RH=22", "W=640, LW=150, RH=22")
rep("""${s.id.slice(2)} ${esc(s.pref.replace(/(都|府|県)$/,''))}</text>""", """${esc(s.id)} ${esc(s.port)}</text>""")
rep("<span class=\"dtitle\">${state.pref?esc(state.pref):'全国'}のポートフォリオ</span>", "<span class=\"dtitle\">${esc(scopeName())}のポートフォリオ</span>")

# ---- 9. 3D：工事用ゲートの向き・水域の色・架空表示 ----
rep("const gt=s.gate, gy=sampleH(s,gt.x,gt.z); for(const k of [-1,1]) solid(box(gt.x+5*k,gy,gt.z,.6,4,.6),hex('#475569')); solid(box(gt.x,gy+3.6,gt.z,10.6,.5,.6),ORANGE);",
    "const gt=s.gate, gy=sampleH(s,gt.x,gt.z), ax=gt.ox?0:1, az=gt.ox?1:0; for(const k of [-1,1]) solid(box(gt.x+5*k*ax,gy,gt.z+5*k*az,.6,4,.6),hex('#475569')); solid(box(gt.x,gy+3.6,gt.z,ax?10.6:.6,.5,az?10.6:.6),ORANGE);")
rep("const col=mix(hex('#b9c99a'),hex('#c9b48a'),(c.C[k]-c.cmin)/rng*.85); COL.set(col,k*3); }",
    "const col=c.C[k]===-1?SEA:mix(hex('#b9c99a'),hex('#c9b48a'),(c.C[k]-c.cmin)/rng*.85); COL.set(col,k*3); }")
rep("function buildCtx(s){", "const SEA=hex('#7fa7c9');  // 標高データのない水域（海・河川）はデータ作成時に T.P.-1.0m ちょうどで埋めてあり、その値の点だけを水色で描く\nfunction buildCtx(s){")
rep("""`<div><span class="sw" style="background:#b9c99a"></span>周辺：標高データの地形（1km）</div>`""",
    """`<div><span class="sw" style="background:#b9c99a"></span>周辺：標高データの地形（1km）</div><div><span class="sw" style="background:#7fa7c9"></span>水域（標高データなし）</div>`""")
rep("""fe.textContent = useG() ? '工事・建物計画はすべて架空のサンプルです／周辺の街並みは Google の実写3D（実在）' : '工事・建物計画はすべて架空のサンプルです';""",
    """fe.textContent = useG() ? '工事・発注者・計画はすべて架空のサンプルです（当社の実工事ではありません）／周辺は Google の実写3D（実在）' : '工事・発注者・計画はすべて架空のサンプルです（当社の実工事ではありません）';""")
rep("""      <div class="fiction" id="fiction" hidden>工事・建物計画はすべて架空のサンプルです／周辺の街並みは Google の実写3D（実在）</div>""",
    """      <div class="fiction" id="fiction" hidden>工事・発注者・計画はすべて架空のサンプルです（当社の実工事ではありません）／周辺は Google の実写3D（実在）</div>""")

# ---- 9b. 揚重範囲：本版の工種はタワークレーンを使わないので、ボタンを出さない ----
rep("['route','搬出ルート'],['crane','揚重範囲'],['labels','ラベル']", "['route','搬出ルート'],['labels','ラベル']")
rep('<button class="btn ghost" data-ly="crane">3Dで揚重範囲</button>', '')

# ---- 10. ジオイド高の初期概算（現場のある都道府県） ----
rep("const GEOID0 = {'北海道':31,'宮城県':38,'新潟県':38,'東京都':37,'神奈川県':37,'埼玉県':37,'愛知県':38,'長野県':40,'大阪府':37,'兵庫県':37,'広島県':35,'愛媛県':35,'福岡県':33,'熊本県':33,'沖縄県':31};",
    "const GEOID0 = {'北海道':31,'宮城県':38,'東京都':37,'神奈川県':37,'愛知県':38,'静岡県':40,'大阪府':37,'兵庫県':37,'広島県':35,'岡山県':36,'福岡県':33,'熊本県':33};")

# ---- 11. 出典（左パネル下） ----
rep('アドレス・ベース・レジストリ（デジタル庁）を加工した Geolonia 住所データ（CC BY 4.0）／',
    'アドレス・ベース・レジストリ（デジタル庁）を加工した Geolonia 住所データ（CC BY 4.0）／現場の所在地：国土地理院 逆ジオコーダ／')

missing = [k for k in ('machiaza', 'lgcode/10000', "s.id.slice(2)") if k in t]
if missing:
    raise SystemExit(f'旧仕様の参照が残っています: {missing}')
open(outf, 'w', encoding='utf-8').write(t)
print('ok', outf, len(t.encode('utf-8')), 'bytes')
