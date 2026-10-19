#!/usr/bin/env python3
"""オフライン版を file:// で開き、外部通信を全部止めた状態で検証する。
使い方：python3 check_offline.py <オフライン版HTML> <出力フォルダ>
"""
import json, os, pathlib, sys
from playwright.sync_api import sync_playwright

html, out = sys.argv[1:3]
os.makedirs(out, exist_ok=True)
url = pathlib.Path(html).resolve().as_uri()
errors, blocked, fails = [], [], []

with sync_playwright() as p:
    b = p.chromium.launch(args=['--use-angle=swiftshader', '--enable-unsafe-swiftshader', '--ignore-gpu-blocklist'])
    ctx = b.new_context(viewport={'width': 1440, 'height': 900}, offline=True)
    pg = ctx.new_page()
    pg.route('**/*', lambda r: r.continue_() if r.request.url.startswith('file:') else (blocked.append(r.request.url), r.abort()))
    pg.on('console', lambda m: m.type == 'error' and errors.append(m.text))
    pg.on('pageerror', lambda e: errors.append('pageerror: ' + str(e)))
    pg.goto(url, wait_until='load', timeout=120000)
    pg.wait_for_timeout(3500)
    info = pg.evaluate("""() => ({status: document.querySelector('#netStatus').textContent, nogl: !document.querySelector('#nogl').hidden,
      canvas: !!document.querySelector('#cz canvas'), rows: document.querySelectorAll('#list .row').length, sites: SITES.length,
      finite: SITES.every(s=>[s.FH,s.g.Vc,s.g.Vf,s.cur.end].every(Number.isFinite))})""")
    print('起動:', info)
    if info['nogl'] or not info['canvas']: fails.append('3D が初期化されていない')
    if info['rows'] != info['sites'] or not info['finite']: fails.append('台帳・計算の異常')
    pg.screenshot(path=os.path.join(out, 'offline_nation.png'))
    # 全国地図のピンをクリックして現場へ
    sid = pg.evaluate("() => SITES.find(s=>s.id==='TH-2025-0001').id")
    pr = pg.evaluate("id => { const r=document.querySelector('#gl').getBoundingClientRect(), p=project(pinPos(byId(id))); return p&&{x:p.x+r.left,y:p.y+r.top}; }", sid)
    if pr:
        pg.mouse.click(pr['x'], pr['y']); pg.wait_for_timeout(2500)
    sel = pg.evaluate('() => state.sel')
    print('ピンのクリック →', sel)
    if sel != sid: fails.append(f'ピンのクリックで現場に入れない（{sel}）')
    pg.screenshot(path=os.path.join(out, 'offline_site.png'))
    # 視点・レイヤー・タブ・時刻
    for v in ('bird', 'top', 'eye', 'site'):
        pg.click(f'[data-view="{v}"]'); pg.wait_for_timeout(1200)
    pg.click('[data-layer="heat"]'); pg.wait_for_timeout(600)
    pg.screenshot(path=os.path.join(out, 'offline_site_heat.png'))
    pg.click('[data-layer="heat"]')
    for s in pg.evaluate('() => SITES.map(s=>s.id)'):
        pg.evaluate('id => select(id)', s)
        for tab in ('earth', 'plan', 'const', 'sched', 'wm'):
            pg.evaluate('t => { state.tab=t; renderDock(); }', tab)
            if not pg.inner_text('#dockBody').strip(): fails.append(f'空のタブ: {s} {tab}')
        pg.wait_for_timeout(150)
    pg.evaluate("() => select('KS-2026-0001')"); pg.wait_for_timeout(2500)
    pg.evaluate('() => setT(dn("2027-06-01"))'); pg.wait_for_timeout(1500)
    pg.screenshot(path=os.path.join(out, 'offline_site_future.png'))
    pg.keyboard.press('Escape'); pg.wait_for_timeout(2500)
    mode = pg.evaluate('() => state.mode')
    if mode != 'nation': fails.append('Esc で全国へ戻れない')
    # 住所検索（現場名に無い市）→ 地図に印
    pg.fill('#q', '室蘭市'); pg.press('#q', 'Enter'); pg.wait_for_timeout(2500)
    mark = pg.evaluate('() => state.mark && state.mark.label')
    print('住所検索 →', mark)
    if not mark: fails.append('住所検索の印が出ない')
    pg.screenshot(path=os.path.join(out, 'offline_address.png'))
    pg.press('#q', 'Escape'); pg.wait_for_timeout(300)
    ver = pg.evaluate("() => document.title")
    print('タイトル:', ver)
    if 'v' not in ver: fails.append('版番号がタイトルにない')
    pg.select_option('#brSel', 'TH'); pg.wait_for_timeout(2500)
    pg.screenshot(path=os.path.join(out, 'offline_branch.png'))
    b.close()

print('外部への通信（止めたもの）:', len(blocked), blocked[:5])
print('コンソールエラー:', len(errors))
for e in errors[:10]: print('  ', e[:300])
if blocked: fails.append('外部への通信がある')
print('不合格:', fails or 'なし')
sys.exit(1 if fails or errors else 0)
