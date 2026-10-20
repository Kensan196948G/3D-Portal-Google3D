#!/usr/bin/env python3
"""オンライン版（データを起動時に取得する版）を Webサーバ経由で開いて検証する。
使い方：python3 check_online.py <online フォルダ> <sites.json（gen_sites.py の出力）> <expected_runtime.json> <出力フォルダ>
- 起動時に取得した地形（E・C）が gen_sites.py の結果と一致するか、計算結果（FH・切土・盛土・竣工・遅延）が埋め込み版と一致するかを確かめる
- 通信先がすべて決められた宛先の中にあるかを確かめる
- 国土地理院の標高タイルを止めたとき、空白ではなくエラー画面が出るかを確かめる
"""
import base64, functools, http.server, json, os, struct, sys, threading
from urllib.parse import urlparse
from playwright.sync_api import sync_playwright

args = [a for a in sys.argv[1:] if not a.startswith('--base-url=')]
BASE = next((a.split('=', 1)[1] for a in sys.argv[1:] if a.startswith('--base-url=')), None)   # 例：--base-url=http://192.168.0.185:36621/（常駐サービスを検証）
root, sitesf, expf, out = args[:4]
os.makedirs(out, exist_ok=True)
H = functools.partial(http.server.SimpleHTTPRequestHandler, directory=root); H.log_message = lambda *a: None
srv = http.server.ThreadingHTTPServer(('127.0.0.1', 0), H); threading.Thread(target=srv.serve_forever, daemon=True).start()
url = BASE or f'http://127.0.0.1:{srv.server_address[1]}/index.html'
# 環境変数 GOOGLE_MAP_TILES_KEY があれば、data/config.json をメモリ上で差し込んで Google 実写3D も確かめる（キーはファイルにも出力にも書かない）
GKEY = os.environ.get('GOOGLE_MAP_TILES_KEY', '').strip()
HASCFG = os.path.exists(os.path.join(root, 'data', 'config.json'))  # サーバに置いた config.json（中身は読まない）
ALLOWED = {'tile.googleapis.com', 'assets.ion.cesium.com'} if (GKEY or HASCFG) else set()   # Google 表示中は Google のロゴ画像を Cesium の配信元から読む
ALLOWED |= {urlparse(url).hostname, 'www.jma.go.jp', 'www.data.jma.go.jp', 'disaportaldata.gsi.go.jp', '127.0.0.1', 'cyberjapandata.gsi.go.jp', 'mreversegeocoder.gsi.go.jp', 'msearch.gsi.go.jp', 'maps.gsi.go.jp', 'cdn.jsdelivr.net'}
ref = json.load(open(sitesf, encoding='utf-8')); exp = {s['id']: s for s in json.load(open(expf, encoding='utf-8'))}
dec = lambda b: struct.unpack('<%dh' % (len(base64.b64decode(b)) // 2), base64.b64decode(b))
fails, errors, hosts, nf = [], [], set(), []
ARGS = ['--use-angle=swiftshader', '--enable-unsafe-swiftshader', '--ignore-gpu-blocklist']

with sync_playwright() as p:
    b = p.chromium.launch(args=ARGS)
    pg = b.new_page(viewport={'width': 1440, 'height': 900})
    pg.on('request', lambda r: hosts.add(urlparse(r.url).hostname))
    pg.on('response', lambda r: r.status == 404 and nf.append(r.url))
    if GKEY: pg.route('**/data/config.json', lambda r: r.fulfill(status=200, content_type='application/json', body=json.dumps({'googleMapTilesKey': GKEY})))
    pg.on('console', lambda m: m.type == 'error' and errors.append(m.text))
    pg.on('pageerror', lambda e: errors.append('pageerror: ' + str(e)))
    pg.goto(url, wait_until='load', timeout=120000)
    pg.wait_for_function("() => (typeof SITES!=='undefined' && document.querySelector('#boot').hidden) || document.querySelector('#boot.err')", timeout=180000)
    if pg.is_visible('#boot.err'):
        fails.append('起動時の取得に失敗: ' + pg.inner_text('#bootErr')[:400])
    else:
        pg.wait_for_timeout(3000)
        if pg.is_visible('#keyDlg'): pg.click('#keySkip')
        pg.wait_for_timeout(4000)
        st = pg.inner_text('#netStatus'); print('3D の状態:', st)
        if GKEY or HASCFG:
            pg.wait_for_function("() => /Google 実写3D|未接続/.test(document.querySelector('#netStatus').textContent)", timeout=60000)
            st = pg.inner_text('#netStatus'); print('Google 3D:', st)
            if 'Google 実写3D' not in st: fails.append('Google 実写3D に接続できない: ' + st)
        else: print('Google 実写3D：キー（環境変数 GOOGLE_MAP_TILES_KEY）がないため確認しない')
        # 1) 地形の一致（gen_sites.py の結果と）
        terr = pg.evaluate('() => GEO.terr'); sel = pg.evaluate('() => GEO.sel')
        nE = nC = 0; dE = dC = 0
        for i, (t, r) in enumerate(zip(terr, ref)):
            rt = r['terr']
            if (t['nx'], t['nz'], t['src']) != (rt['nx'], rt['nz'], rt['src']): fails.append(f'格子・ソースの違い {r["sel"]["key"]}')
            a, b2 = dec(t['E']), dec(rt['E']); diff = [abs(x - y) for x, y in zip(a, b2)]; nE += sum(1 for d in diff if d); dE = max(dE, max(diff))
            a, b2 = dec(t['C']), dec(rt['C']); diff = [abs(x - y) for x, y in zip(a, b2)]; nC += sum(1 for d in diff if d); dC = max(dC, max(diff))
            if abs(t['emed'] - rt['emed']) > .05: fails.append(f'emed の違い {r["sel"]["key"]} {t["emed"]:.3f} / {rt["emed"]:.3f}')
            if (sel[i]['pref'], sel[i]['city'], sel[i]['town']) != (r['sel']['pref'], r['sel']['city'], r['sel']['town']): fails.append(f'所在地の違い {r["sel"]["key"]} {sel[i]["city"]}{sel[i]["town"]}')
        print(f'地形 E：違う点 {nE}（最大 {dE/10:.1f} m）／周辺 C：違う点 {nC}（最大 {dC/10:.1f} m）')
        # 2) 計算結果の一致（埋め込み版と）
        run = pg.evaluate("() => SITES.map(s => ({id:s.id, FH:s.FH, Vc:s.g.Vc, Vf:s.g.Vf, end:ds(s.cur.end), delay:s.cur.delay}))")
        bad = [r['id'] for r in run if r['id'] not in exp or abs(r['FH'] - exp[r['id']]['FH']) > 1e-6 or abs(r['Vc'] - exp[r['id']]['Vc']) > .5
               or abs(r['Vf'] - exp[r['id']]['Vf']) > .5 or r['end'] != exp[r['id']]['end'] or r['delay'] != exp[r['id']]['delay']]
        print('計算結果が埋め込み版と違う現場:', bad or 'なし')
        if bad: fails.append('計算結果の違い: ' + ','.join(bad))
        print('台帳:', pg.locator('#list .row').count(), '件 / 状態:', pg.inner_text('#netStatus'))
        pg.screenshot(path=os.path.join(out, 'online_nation.png'))
        # 2b) 気象庁（気象・海象）：全現場が予報区域に結び付き、タブが出ること
        pg.wait_for_function("() => WX.state==='ok' || WX.state==='error'", timeout=90000)
        wx = pg.evaluate("() => ({state:WX.state, err:WX.err, total:SITES.length, n:SITES.filter(s=>WX.site[s.id]).length, lv:SITES.map(s=>[s.id,(WX.site[s.id]||{}).level,(WX.site[s.id]||{r:{}}).r.name20,((WX.site[s.id]||{}).days||[]).length])})")
        print('気象庁:', wx['state'], wx['err'], f"区域に結び付いた現場 {wx['n']}/{wx['total']}", [(i, l, n, d) for i, l, n, d in wx['lv']][:15])
        if wx['state'] != 'ok' or wx['n'] != wx['total']: fails.append('気象庁データの結び付けが不完全')
        fresh = pg.evaluate("() => { const t=Math.max(...SITES.map(s=>WX.site[s.id]&&WX.site[s.id].warnReport?new Date(WX.site[s.id].warnReport).getTime():0)); return (Date.now()-t)/86400000; }")
        act = pg.evaluate("() => SITES.flatMap(s=>(WX.site[s.id]||{warns:[]}).warns.map(w=>s.port+':'+w.name))")
        print(f'警報・注意報：いちばん新しい発表は {fresh:.1f} 日前／発表中', act)
        if fresh > 7: fails.append('警報・注意報のデータが古い（気象庁の提供形式が変わった可能性）')
        # 2c) 実績入力（デモ）：反映で予測が変わり、元に戻せる
        r0 = pg.evaluate("() => { const s=byId('TK-2025-0001'); return s.cur.end; }")
        r1 = pg.evaluate("() => { const s=byId('TK-2025-0001'); progApply(s, s.tasks.map(t=>t.a*0.8)); return s.cur.end; }")
        r2 = pg.evaluate("() => { const s=byId('TK-2025-0001'); progApply(s, PROG0[s.id]); return s.cur.end; }")
        print('実績入力（デモ）: 竣工予測', r0, '→', r1, '→ 戻す', r2)
        if not (r1 != r0 and r2 == r0): fails.append('実績入力の反映・復元が正しくない')
        # 2d) CSV 出力（BOM 付き・全現場）
        with pg.expect_download() as dl:
            pg.evaluate("() => exportCSV()")
        csv = open(dl.value.path(), 'rb').read().decode('utf-8')
        print('CSV:', dl.value.suggested_filename, '行数', len(csv.strip().splitlines()), 'BOM', csv.startswith('\ufeff'))
        if not csv.startswith('\ufeff') or len(csv.strip().splitlines()) != wx['total'] + 2: fails.append('CSV の形式')
        # 2e) 印刷用の現場概要（印刷ダイアログは開かない）
        ok = pg.evaluate("() => { window.print=()=>{}; printSite(byId('KS-2025-0002')); return document.querySelector('#printSheet').textContent.includes('熊本港'); }")
        print('印刷用の現場概要:', ok)
        if not ok: fails.append('印刷用の現場概要が作れない')
        # 2f) 潮位（気象庁 潮位表）：潮位曲線と干潮時の作業時間帯
        pg.evaluate("() => { select('TK-2025-0001'); state.tab='tide'; renderDock(); }")
        pg.wait_for_function("() => document.querySelector('#tideWin') && document.querySelector('#tideWin').textContent.trim().length>0 || /取得できません|ありません/.test((document.querySelector('#tideChart')||{}).textContent||'')", timeout=60000)
        tide = pg.evaluate("() => ({chart:!!document.querySelector('#tideChart svg'), win:document.querySelector('#tideWin').textContent.slice(0,80), st:TIDE.st&&TIDE.st.code})")
        print('潮位:', tide)
        if not tide['chart']: fails.append('潮位の曲線が出ない')
        pg.evaluate("() => { TIDE.playing=true; }"); pg.wait_for_timeout(3000)
        tp = pg.evaluate("() => !!TIDE.prim"); print('潮位面（3D）:', tp)
        if not tp: fails.append('潮位面が 3D に出ない')
        pg.screenshot(path=os.path.join(out, 'online_tide.png')); pg.evaluate("() => { TIDE.playing=false; }")
        # 2g) 遅れの分析と挽回編成
        pg.evaluate("() => { select('HK-2026-0002'); state.tab='ai'; renderDock(); }"); pg.wait_for_timeout(1500)
        ai = pg.evaluate("() => ({txt:document.querySelector('#dockBody').textContent.slice(0,120), plans:document.querySelectorAll('[data-plan]').length})")
        print('遅れの分析:', ai)
        if ai['plans'] < 1: fails.append('挽回編成の提案が出ない')
        pg.screenshot(path=os.path.join(out, 'online_ai.png'))
        # 2g1) 深浅測量の比較：台帳の測量をワールドモデルと同じ計画面・メッシュ法で計算すると、WM の土量と一致する
        sm = pg.evaluate("""() => SITES.filter(s=>s.k.marine).map(s=>{ const m=surveyModel(s,decI16(s.terr.E)); return {id:s.id, kind:s.kind, Vc:s.g.Vc, Vf:s.g.Vf, mVc:m.Vc, mVf:m.Vf, remain:m.remain}; })""")
        print('測量の比較（台帳の測量＝WM の土量）:', [(x['id'], round(x['remain']), round(x['Vc'] if x['kind'] == 'dredge' else x['Vf'])) for x in sm])
        if len(sm) < 2 or any(abs(x['mVc'] - x['Vc']) > 1e-6 * max(1, x['Vc']) or abs(x['mVf'] - x['Vf']) > 1e-6 * max(1, x['Vf']) for x in sm):
            fails.append('測量の比較の土量がワールドモデルと一致しない')
        # 2g2) 海上工事：深浅測量の取り込み（いまの海底を 1m 浅くした点を入れると、浚渫土量が増える）
        sv = pg.evaluate("""() => { const s=byId('TK-2026-0001'); if(!s) return null; const v0=s.g.Vc, g=s.g, lines=[];
          for(let k=0;k<g.nv;k+=3) lines.push(`${g.LX[k].toFixed(2)},${(-g.LZ[k]).toFixed(2)},${(g.E[k]+s.yRef+1).toFixed(2)}`);
          const r=importSurvey(s,lines.join('\\n')); return {v0, v1:s.g.Vc, used:r.used, total:r.total}; }""")
        print('深浅測量の取り込み:', sv)
        if not sv or not (sv['v1'] > sv['v0'] * 1.1): fails.append('深浅測量の取り込みで土量が変わらない')
        # 2i) 作業可能日（潮位×波×工程）・類似工事・会議資料・重機アニメーションの削除
        pg.evaluate("() => { select('KS-2026-0002'); state.tab='work'; renderDock(); }")
        pg.wait_for_function("() => document.querySelectorAll('#workCal .wc').length>0 || /できません/.test(document.querySelector('#dockBody').textContent)", timeout=60000)
        wk = pg.evaluate("() => ({n:document.querySelectorAll('#workCal .wc').length, ok:document.querySelectorAll('#workCal .wc.ok').length, tide:document.querySelectorAll('#workCal .wc.tide').length, cand:document.querySelectorAll('#workList tr').length})")
        print('作業可能日（ケーソン据付）:', wk)
        if wk['n'] != 30: fails.append('作業可能日のカレンダーが出ない')
        pg.screenshot(path=os.path.join(out, 'online_work.png'))
        pg.evaluate("() => { state.tab='cmp'; renderDock(); }"); pg.wait_for_timeout(500)
        cm = pg.evaluate("() => ({rows:document.querySelectorAll('#dockBody table.t tr').length, svg:!!document.querySelector('#dockBody svg')})"); print('類似工事:', cm)
        if cm['rows'] < 2 or not cm['svg']: fails.append('類似工事の比較が出ない')
        eq = pg.evaluate("() => ({btn:!!document.querySelector('[data-layer=\"equip\"]'), dyn:(()=>{ const s=byId('KS-2026-0002'); computeEquip(s); return dynItems(s,1).sol.length; })()})"); print('重機アニメーション:', eq)
        if eq['btn'] or eq['dyn'] > 0: fails.append('重機のアニメーションが残っている')
        pg.evaluate("() => select(null)"); pg.wait_for_timeout(1500)
        rp = pg.evaluate("async () => { window.print=()=>{}; await meetingReport({recovery:true, all:false, ai:false}); const el=document.querySelector('#printSheet'); return {ok:/工程会議資料/.test(el.textContent), sites:el.querySelectorAll('.ps-site').length}; }")
        print('会議資料:', rp)
        if not rp['ok'] or rp['sites'] < 1: fails.append('会議資料が作れない')
        kd = pg.evaluate("() => /工種別の比較/.test(document.querySelector('#dockBody').textContent) && !!document.querySelector('#rptBtn')"); print('工種別の比較・会議資料ボタン:', kd)
        if not kd: fails.append('ポートフォリオに工種別の比較・会議資料ボタンがない')
        # 2h) 会議巡回・説明モード・浸水想定・作業船
        pg.evaluate("() => select(null)"); pg.wait_for_timeout(1500)
        pg.click('#tourBtn'); pg.wait_for_timeout(2500)
        tour = pg.evaluate("() => ({on:TOUR.on, n:TOUR.list.length, first:TOUR.list[0]&&TOUR.list[0].id, sel:state.sel})"); print('会議巡回:', tour)
        if not (tour['on'] and tour['first'] == tour['sel']): fails.append('会議巡回が動かない')
        pg.screenshot(path=os.path.join(out, 'online_tour.png')); pg.keyboard.press('Escape'); pg.wait_for_timeout(1500)
        if pg.evaluate('() => TOUR.on'): fails.append('Esc で会議巡回が止まらない')
        pg.click('#presentBtn'); pg.evaluate("() => select('TH-2025-0001')"); pg.wait_for_timeout(4000)
        pr = pg.evaluate(r"() => ({on:document.body.classList.contains('present'), T:state.T, end:byId('TH-2025-0001').cur.end, delayShown:/遅延|予測 \+/.test(document.querySelector('#summary').textContent+document.querySelector('#dockBody').textContent)})")
        print('説明モード:', pr)
        if not pr['on'] or pr['delayShown'] or pr['T'] <= pr['end']: fails.append('説明モードで遅れが見える／完成後の姿でない')
        pg.screenshot(path=os.path.join(out, 'online_present.png')); pg.click('#presentEnd'); pg.evaluate("() => select(null)"); pg.wait_for_timeout(2500)
        g_was = pg.evaluate('() => useG()')
        pg.evaluate("() => setLayer('tsunami', true)"); pg.wait_for_timeout(1500)
        hz = pg.evaluate("() => ({layer:!!HZ.tsunami.layer, google:useG()})"); print('浸水想定:', hz, '（Google 表示中だった:', g_was, '）')
        if not hz['layer'] or hz['google']: fails.append('浸水想定が地理院地図に重ならない')
        pg.evaluate("() => flyPoint(141.03,38.26)"); pg.wait_for_timeout(5000); pg.screenshot(path=os.path.join(out, 'online_tsunami.png'))
        pg.evaluate("() => setLayer('tsunami', false)")
        vs = pg.evaluate("() => ({n:VESSELS.length, pts:!!VS.pts})"); print('作業船:', vs)
        if vs['n'] < 1 or not vs['pts']: fails.append('作業船が出ない')
        # 3) 住所検索（国土地理院・オンライン）
        pg.fill('#q', '室蘭市'); pg.wait_for_timeout(2500); pg.press('#q', 'Enter'); pg.wait_for_timeout(3500)
        mark = pg.evaluate('() => state.mark && state.mark.label'); g_on = pg.evaluate('() => useG()'); print('住所検索 →', mark, '（Google 表示中は印を出さない決まり）' if g_on else '')
        if g_on and mark: fails.append('Google 表示中に Google 以外の住所検索の印が出た')
        if not g_on and not mark: fails.append('住所検索の印が出ない')
        pg.press('#q', 'Escape')
        # 4) 現場・航空写真・全タブ
        pg.evaluate("() => select('TK-2025-0001')"); pg.wait_for_timeout(5000)
        if pg.is_visible('[data-layer="photo"]'):
            pg.click('[data-layer="photo"]'); pg.wait_for_timeout(5000)
        pg.screenshot(path=os.path.join(out, 'online_site_photo.png'))
        pg.evaluate("() => { state.tab='wx'; renderDock(); }"); pg.wait_for_timeout(500); pg.screenshot(path=os.path.join(out, 'online_wx.png'))
        for s in [r['id'] for r in run]:
            pg.evaluate('id => select(id)', s)
            for tab in ('earth', 'plan', 'const', 'sched', 'wm', 'wx', 'tide', 'work', 'fleet', 'survey', 'consult', 'ai', 'cmp', 'prog'):
                pg.evaluate('t => { state.tab=t; renderDock(); }', tab)
                if not pg.inner_text('#dockBody').strip(): fails.append(f'空のタブ: {s} {tab}')
        pg.evaluate('() => select(null)'); pg.wait_for_timeout(2000)
    b.close()
    # 5) 標高タイルを止めたとき：エラー画面が出ること
    b = p.chromium.launch(args=ARGS); pg = b.new_page(viewport={'width': 1280, 'height': 800})
    pg.route('**/cyberjapandata.gsi.go.jp/**', lambda r: r.abort())
    pg.goto(url, wait_until='load')
    try:
        pg.wait_for_selector('#boot.err', timeout=120000); print('標高タイル遮断 → エラー画面:', pg.inner_text('#bootMsg')[:80])
        pg.screenshot(path=os.path.join(out, 'online_error.png'))
    except Exception:
        fails.append('標高タイルを止めてもエラー画面が出ない')
    b.close()
srv.shutdown()
extra = sorted(h for h in hosts if h and h not in ALLOWED)
print('通信先:', sorted(h for h in hosts if h))
if extra: fails.append('許可していない通信先: ' + ', '.join(extra))
# 国土地理院のタイルは、海など地形データのない所では 404 を返す（仕様）。それ以外の 404 とエラーは不合格
bad404 = [u for u in nf if not u.startswith(('https://cyberjapandata.gsi.go.jp/xyz/', 'https://disaportaldata.gsi.go.jp/raster/')) and not u.endswith(('/data/config.json', '/api/auth/me'))]  # 静的な配信では /api が無い（サーバ版かどうかの判定）  # 地図タイルは「データなし」で 404（仕様）、config.json は任意
errors = [e for e in errors if 'status of 404' not in e]
print(f'404（国土地理院タイルのデータなし）: {len(nf) - len(bad404)} 件／それ以外の 404: {bad404[:5]}')
if bad404: fails.append('想定外の 404')
print('コンソールエラー（404 以外）:', len(errors)); [print('  ', e[:300]) for e in errors[:10]]
print('不合格:', fails or 'なし')
sys.exit(1 if fails or errors else 0)
