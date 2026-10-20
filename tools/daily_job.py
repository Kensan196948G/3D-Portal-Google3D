#!/usr/bin/env python3
"""毎朝の定時処理（systemd の mirai-3d-portal-daily.timer から）：遅れの日次の記録 → 遅れの予兆のメール。

使い方：python3 tools/daily_job.py [--base-url=http://127.0.0.1:36621/] [--no-notify]
- DB（server/.env の DATABASE_URL）から台帳・実績を読み、このサーバの画面（ログイン前でも配る骨組み）をヘッドレスで開いて
  その計算（ワールドモデル）に渡し、正式な予測（s.base：初期計画の編成＋実績で較正した実効率。What-if は含まない）を DB へ保存する
- ログインはしない（画面の /api への問い合わせはこの処理の中で答える）。新しいアカウント・パスワード・書き込み口は作らない
- Google 実写3D は使わない（キーを渡さない）。地形は国土地理院から取得する
- メールは設定が有効で条件がそろい、予兆があるときだけ（server/trends.py の notify）。CI では動かさない
"""
import json
import os
import pathlib
import sys

ROOT = pathlib.Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT))
from server.app import bootstrap_data          # noqa: E402（server/.env を読む）
from server.trends import save_snapshots, notify  # noqa: E402
from playwright.sync_api import sync_playwright  # noqa: E402

BASE = next((a.split('=', 1)[1] for a in sys.argv[1:] if a.startswith('--base-url=')), 'http://127.0.0.1:36621/')
if os.environ.get('CI'):
    sys.exit(print('CI では定時処理を動かしません') or 0)

boot = {'user': {'email': 'daily-job', 'role': 'viewer'}, **bootstrap_data(), 'googleMapTilesKey': '', 'features': {'ai': False, 'ais': False}}
body = json.dumps(boot, ensure_ascii=False, default=str)


def api(route):
    path = route.request.url.split('?')[0]
    if path.endswith('/api/auth/me'):
        return route.fulfill(status=200, content_type='application/json', body=json.dumps(boot['user']))
    if path.endswith('/api/bootstrap'):
        return route.fulfill(status=200, content_type='application/json', body=body)
    return route.fulfill(status=404, content_type='application/json', body='{"error":"daily job"}')


with sync_playwright() as p:
    b = p.chromium.launch(args=['--use-angle=swiftshader', '--enable-unsafe-swiftshader', '--ignore-gpu-blocklist'])
    pg = b.new_page(viewport={'width': 1280, 'height': 800})
    errors = []
    pg.on('pageerror', lambda e: errors.append(str(e)))
    pg.route('**/api/**', api)
    pg.goto(BASE)
    pg.wait_for_function("() => (typeof SITES!=='undefined' && document.querySelector('#boot').hidden) || document.querySelector('#boot.err')", timeout=600000)
    if pg.evaluate("() => typeof SITES==='undefined'"):
        sys.exit('画面を起動できませんでした：' + pg.evaluate("() => (document.querySelector('#bootMsg')||{}).textContent||''").strip()[:200])
    failed = pg.evaluate("() => (GEO.fetched&&GEO.fetched.failed)||[]")
    items = pg.evaluate("""() => SITES.map(s=>({site_key:s.key, delay_days:Math.round(s.base.delay), forecast_end:isoOf(s.base.end),
        actual_pct:Math.round(actualAtBase(s)*1000)/10, plan_pct:Math.round(planAtBase(s)*1000)/10, eta:Math.min(10,Math.max(0,Math.round(s.eta*1000)/1000))}))""")
    b.close()
n = save_snapshots(items)
print(f'日次の記録：{n} 現場' + (f'／地形を取得できなかった現場 {len(failed)} 件：{failed}' if failed else ''))
if errors:
    print('画面のエラー：', errors[:3])
if '--no-notify' not in sys.argv:
    res = notify()
    print('メール：', json.dumps({k: v for k, v in res.items() if k != 'body'}, ensure_ascii=False))
    if res['status'] == 'failed':
        sys.exit(1)
