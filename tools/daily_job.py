#!/usr/bin/env python3
"""毎朝の定時処理（systemd の mirai-3d-portal-daily.timer から）：遅れの日次の記録 → 遅れの予兆のメール。

使い方：python3 tools/daily_job.py [--base-url=http://127.0.0.1:36621/] [--no-notify]
- 専用アカウント（server/.env の SNAPSHOT_EMAIL / SNAPSHOT_PASSWORD。python3 -m server.manage create-service-account で作る）で
  このサーバの画面にログインし、ワールドモデルが計算した正式な予測（s.base：初期計画の編成＋実績で較正した実効率）を保存する
- Google 実写3D のタイルは読み込まない（API の利用量を使わない）。地形は国土地理院から取得する
- メールは設定が有効で条件がそろい、予兆があるときだけ（server/trends.py の notify）。CI では動かさない
"""
import json
import os
import pathlib
import sys

from dotenv import load_dotenv
from playwright.sync_api import sync_playwright

ROOT = pathlib.Path(__file__).resolve().parents[1]
load_dotenv(ROOT / 'server' / '.env')
BASE = next((a.split('=', 1)[1] for a in sys.argv[1:] if a.startswith('--base-url=')), 'http://127.0.0.1:36621/')
if os.environ.get('CI'):
    sys.exit(print('CI では定時処理を動かしません') or 0)
email, pw = os.environ.get('SNAPSHOT_EMAIL', ''), os.environ.get('SNAPSHOT_PASSWORD', '')
if not email or not pw:
    sys.exit('SNAPSHOT_EMAIL / SNAPSHOT_PASSWORD が server/.env にありません（python3 -m server.manage create-service-account）')

with sync_playwright() as p:
    b = p.chromium.launch(args=['--use-angle=swiftshader', '--enable-unsafe-swiftshader', '--ignore-gpu-blocklist'])
    pg = b.new_page(viewport={'width': 1280, 'height': 800})
    errors = []
    pg.on('pageerror', lambda e: errors.append(str(e)))
    pg.route('**://tile.googleapis.com/**', lambda r: r.abort())
    pg.goto(BASE); pg.wait_for_selector('#loginForm', timeout=60000)
    pg.fill('#loginForm [name=email]', email); pg.fill('#loginForm [name=password]', pw); pg.click('#loginForm button')
    pg.wait_for_function("() => (typeof SITES!=='undefined' && document.querySelector('#boot').hidden) || document.querySelector('#boot.err') || document.querySelector('.loginErr:not([hidden])')", timeout=600000)
    if pg.evaluate("() => typeof SITES==='undefined'"):
        msg = pg.evaluate("() => (document.querySelector('.loginErr:not([hidden])')||document.querySelector('#bootMsg')||{}).textContent||''")
        sys.exit(f'画面を起動できませんでした：{msg.strip()[:200]}')
    failed = pg.evaluate("() => (GEO.fetched&&GEO.fetched.failed)||[]")
    items = pg.evaluate("""() => SITES.map(s=>({site_key:s.key, delay_days:Math.round(s.base.delay), forecast_end:isoOf(s.base.end),
        actual_pct:Math.round(actualAtBase(s)*1000)/10, plan_pct:Math.round(planAtBase(s)*1000)/10, eta:Math.min(10,Math.max(0,Math.round(s.eta*1000)/1000))}))""")
    r = pg.evaluate("items => api('POST','api/snapshots',items)", items)
    pg.evaluate("() => api('POST','api/auth/logout').catch(()=>{})")
    b.close()
print(f"日次の記録：{r['n']} 現場（{r['date']}）" + (f"／取得できなかった現場 {len(failed)} 件：{failed}" if failed else ''))
if errors:
    print('画面のエラー：', errors[:3])
if '--no-notify' not in sys.argv:
    sys.path.insert(0, str(ROOT))
    from server.trends import notify
    res = notify()
    print('メール：', json.dumps({k: v for k, v in res.items() if k != 'body'}, ensure_ascii=False))
    if res['status'] == 'failed':
        sys.exit(1)
