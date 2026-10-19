#!/usr/bin/env python3
"""ヘッドレスブラウザで みらい建設工業版 3D現場ポータル を検証し、文書用の計算結果を書き出す。
使い方：python3 check_app.py <配信するフォルダ> <HTMLファイル名> <出力フォルダ>
"""
import functools, http.server, json, os, sys, threading, glob
from playwright.sync_api import sync_playwright

root, name, out = sys.argv[1:4]
os.makedirs(out, exist_ok=True)
H = functools.partial(http.server.SimpleHTTPRequestHandler, directory=root)
H.log_message = lambda *a: None
srv = http.server.ThreadingHTTPServer(('127.0.0.1', 0), H)
threading.Thread(target=srv.serve_forever, daemon=True).start()
url = f'http://127.0.0.1:{srv.server_address[1]}/' + name

DUMP = r"""() => SITES.map(s => ({
  id:s.id, name:s.name, port:s.port, br:s.br, brName:s.brName, dept:s.dept, cat:s.cat, kind:s.kind, label:s.k.label, scale:s.scale,
  client:s.client, ccat:s.ccat, pref:s.pref, addr:s.addr, lat:s.lat, lon:s.lon, sea:s.sea, w:s.area.w, d:s.area.d, src:s.terr.src,
  yRef:s.yRef, FH:s.FH, fh:s.k.fh, emin:s.g.minH+s.yRef, emax:Math.max(...s.g.E)+s.yRef, Vc:s.g.Vc, Vf:s.g.Vf,
  outLoose:s.cur.eb.outLoose, borrowLoose:s.cur.eb.borrowLoose, Q:s.cur.eb.Q, bn:s.cur.cap.bn, eta:s.eta, etaSrc:s.etaSrc,
  planStart:ds(s.planStart), planEnd:ds(s.planEnd), end:ds(s.cur.end), delay:s.cur.delay,
  actual:Math.round(actualAtBase(s)*100), plan:Math.round(planAtBase(s)*100),
  fleet:{ex:s.p0.ex, trucks:s.p0.trucks, rollers:s.p0.rollers, dExt:s.p0.dExt, rain:s.p0.rain, winterF:s.p0.winterF},
  tasks:s.tasks.map(t=>({n:t.n, ts:ds(t.ts), te:ds(t.te), w:t.w, a:t.a, role:t.role||(t.earth?'earth':'')})),
  finite:[s.FH,s.yRef,s.g.Vc,s.g.Vf,s.cur.end,s.cur.delay,s.cur.eb.Q,s.cur.cap.min].every(Number.isFinite)
}))"""

shells = sorted(glob.glob(os.path.expanduser('~/.cache/ms-playwright/chromium_headless_shell-*/chrome-*/chrome-headless-shell')))
errors, fails = [], []
with sync_playwright() as p:
    kw = dict(args=['--use-angle=swiftshader', '--enable-unsafe-swiftshader', '--ignore-gpu-blocklist'])
    try:
        b = p.chromium.launch(**kw)
    except Exception:
        b = p.chromium.launch(executable_path=shells[-1], **kw)
    pg = b.new_page(viewport={'width': 1440, 'height': 900})
    pg.on('console', lambda m: m.type == 'error' and errors.append(m.text))
    pg.on('pageerror', lambda e: errors.append('pageerror: ' + str(e)))
    pg.goto(url, wait_until='load', timeout=120000)
    pg.wait_for_timeout(4000)
    if pg.is_visible('#keyDlg'):
        pg.click('#keySkip')
    pg.wait_for_timeout(5000)
    data = pg.evaluate(DUMP)
    json.dump(data, open(os.path.join(out, 'sites_runtime.json'), 'w', encoding='utf-8'), ensure_ascii=False, indent=1)
    rows = pg.locator('#list .row').count()
    status = pg.inner_text('#netStatus')
    print('rows', rows, '/ sites', len(data), '/ status', status)
    for s in data:
        if not s['finite']:
            fails.append('非有限値: ' + s['id'])
    pg.screenshot(path=os.path.join(out, 'nation.png'))
    # 絞り込み（支店・工種区分）
    pg.select_option('#brSel', 'KS'); pg.wait_for_timeout(800)
    print('KS rows', pg.locator('#list .row').count())
    pg.select_option('#brSel', ''); pg.click('[data-chip="海岸"]'); pg.wait_for_timeout(500)
    print('海岸 rows', pg.locator('#list .row').count())
    pg.click('[data-chip="all"]'); pg.wait_for_timeout(300)
    pg.screenshot(path=os.path.join(out, 'nation_portfolio.png'))
    # 全現場 × 全タブ
    for s in data:
        pg.evaluate('id => select(id)', s['id'])
        for tab in ('earth', 'plan', 'const', 'sched', 'wm'):
            pg.evaluate('t => { state.tab=t; renderDock(); }', tab)
            if not pg.inner_text('#dockBody').strip():
                fails.append(f"空のタブ: {s['id']} {tab}")
        pg.evaluate("() => { state.tab='earth'; renderDock(); }")
    shots = {'TK': 'site_yard.png', 'TH': 'site_seawall.png', 'OS': 'site_whouse.png'}
    for s in data:
        key = {'yard': 'site_yard.png', 'seawall': 'site_seawall.png', 'whouse': 'site_whouse.png', 'reclaim': 'site_reclaim.png'}.get(s['kind'])
        if key and not os.path.exists(os.path.join(out, key)):
            pg.evaluate('id => select(id)', s['id']); pg.wait_for_timeout(6000)
            pg.screenshot(path=os.path.join(out, key))
    # 予測側へ時刻を動かしても落ちないこと
    pg.evaluate('() => setT(T_MAX)'); pg.wait_for_timeout(1500)
    pg.evaluate('() => select(null)'); pg.wait_for_timeout(1500)
    b.close()
srv.shutdown()
print('console errors:', len(errors))
for e in errors[:20]:
    print('  ', e[:300])
print('fails:', fails or 'なし')
