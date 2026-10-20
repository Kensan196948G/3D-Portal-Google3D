#!/usr/bin/env python3
"""サーバ版（ログイン・DB）を実際のブラウザで確かめる。テスト用 DB（TEST_DATABASE_URL）を使い、本番の DB には触らない。
使い方：python3 tools/check_server.py <出力フォルダ>
- テスト用 DB を作り直し（マイグレーション・取り込み）、試験用の利用者を作ってから、uvicorn を 127.0.0.1 の空きポートで起動する
- ログイン画面 → 間違ったパスワード → ログイン → 画面の起動 → 実績の保存（DB）→ 読み込み直しても残る → 設定の文面確認 → ログアウト
"""
import os, pathlib, socket, subprocess, sys, time
import psycopg
from dotenv import load_dotenv
from playwright.sync_api import sync_playwright

ROOT = pathlib.Path(__file__).resolve().parents[1]
load_dotenv(ROOT / 'server' / '.env')
URL = os.environ['TEST_DATABASE_URL']
from psycopg.conninfo import conninfo_to_dict
if not str(conninfo_to_dict(URL).get('dbname', '')).endswith('_test'):   # スキーマを消すので試験用の DB に限る
    sys.exit('TEST_DATABASE_URL の DB 名は _test で終わる必要があります')
out = sys.argv[1]; os.makedirs(out, exist_ok=True)
import secrets
SVC_PW = secrets.token_urlsafe(24)
env = {**os.environ, 'DATABASE_URL': URL, 'GOOGLE_MAP_TILES_KEY': '', 'AI_ENABLED': '0', 'LOGIN_IP_MAX': '1000',
       'SNAPSHOT_EMAIL': 'snapshot-job@portal.invalid', 'SNAPSHOT_PASSWORD': SVC_PW}
sys.path.insert(0, str(ROOT))
os.environ.update(env)
from server.db import migrate
from server.manage import seed
from server.security import PH
with psycopg.connect(URL, autocommit=True) as c:
    c.execute('DROP SCHEMA IF EXISTS portal CASCADE')
migrate(URL); seed(URL)
USERS = {'admin@example.com': ('admin', 'admin-pass-123456'), 'editor@example.com': ('editor', 'editor-pass-123456')}
with psycopg.connect(URL, autocommit=True) as c:
    for e, (r, p) in USERS.items():
        c.execute('INSERT INTO portal.users(email, pw_hash, role) VALUES (%s,%s,%s)', (e, PH.hash(p), r))
    c.execute("INSERT INTO portal.users(email, pw_hash, role) VALUES ('snapshot-job@portal.invalid', %s, 'viewer')", (PH.hash(SVC_PW),))
s = socket.socket(); s.bind(('127.0.0.1', 0)); port = s.getsockname()[1]; s.close()
srv = subprocess.Popen([sys.executable, '-m', 'uvicorn', 'server.app:app', '--host', '127.0.0.1', '--port', str(port), '--log-level', 'warning'], cwd=ROOT, env=env)
base = f'http://127.0.0.1:{port}/'
fails, errors = [], []
try:
    for _ in range(50):
        try:
            socket.create_connection(('127.0.0.1', port), timeout=.2).close(); break
        except OSError:
            time.sleep(.2)
    with sync_playwright() as p:
        b = p.chromium.launch(args=['--use-angle=swiftshader', '--enable-unsafe-swiftshader', '--ignore-gpu-blocklist'])
        ctx = b.new_context(viewport={'width': 1440, 'height': 900}); pg = ctx.new_page()
        pg.on('pageerror', lambda e: errors.append(str(e)))
        pg.goto(base); pg.wait_for_selector('#loginForm', timeout=30000)
        pg.screenshot(path=os.path.join(out, 'srv_login.png'))
        pg.fill('#loginForm [name=email]', 'editor@example.com'); pg.fill('#loginForm [name=password]', 'wrong-password'); pg.click('#loginForm button')
        pg.wait_for_selector('.loginErr:not([hidden])', timeout=10000); print('誤ったパスワード →', pg.inner_text('.loginErr'))
        pg.fill('#loginForm [name=password]', USERS['editor@example.com'][1]); pg.click('#loginForm button')
        pg.wait_for_function("() => typeof SITES!=='undefined' && document.querySelector('#boot').hidden", timeout=180000)
        if pg.is_visible('#keyDlg'): pg.click('#keySkip')
        info = pg.evaluate("() => ({n:SITES.length, user:window.PORTAL_SERVER&&window.PORTAL_SERVER.user, chip:document.querySelector('.userchip')&&document.querySelector('.userchip').textContent})")
        print('ログイン後:', info)
        if info['n'] != 17 or info['user']['role'] != 'editor': fails.append('ログイン後の起動が正しくない')
        # 実績を UI から保存 → 読み込み直しても残る
        pg.evaluate("() => { select('TK-2025-0001'); state.tab='prog'; renderDock(); }"); pg.wait_for_timeout(1500)
        pg.fill('[data-pi="3"]', '40'); pg.fill('#progNote', 'E2E 試験'); pg.click('#progApply'); pg.wait_for_timeout(1500)
        pg.screenshot(path=os.path.join(out, 'srv_progress.png'))
        pg.reload(); pg.wait_for_function("() => typeof SITES!=='undefined' && document.querySelector('#boot').hidden", timeout=180000)
        a = pg.evaluate("() => byId('TK-2025-0001').tasks[3].a"); print('読み込み直した後の実績（工程4）:', a)
        if abs(a - .4) > 1e-6: fails.append('実績が DB に保存されていない')
        pg.evaluate("() => { select('TK-2025-0001'); state.tab='prog'; renderDock(); }"); pg.wait_for_timeout(2500)
        hist = pg.inner_text('#progHist'); print('履歴:', hist[:90].replace('\n', ' '))
        if 'E2E 試験' not in hist: fails.append('変更の履歴が出ない')
        # 運用（DB）：配船計画・深浅測量の時系列・協議記録・作業区域
        pg.on('dialog', lambda d: d.accept())
        pg.evaluate("() => { select('TK-2026-0001'); state.tab='fleet'; renderDock(); }"); pg.wait_for_timeout(1500)
        pg.select_option('#asgV', 'V01'); pg.fill('#asgS', '2026-11-01'); pg.fill('#asgE', '2026-12-15'); pg.fill('#asgR', '浚渫'); pg.click('#asgSave'); pg.wait_for_timeout(1500)
        pg.select_option('#asgV', 'V01'); pg.fill('#asgS', '2026-12-01'); pg.fill('#asgE', '2026-12-31'); pg.click('#asgSave'); pg.wait_for_timeout(1500)
        fl = pg.evaluate("() => ({n:OPS.assignments.length, msg:(document.querySelector('#asgMsg')||{}).textContent||'', svg:!!document.querySelector('#dockBody svg')})"); print('配船計画:', fl)
        if fl['n'] != 1 or '別の割り当て' not in fl['msg'] or not fl['svg']: fails.append('配船計画の保存・重なりの確認が正しくない')
        pg.screenshot(path=os.path.join(out, 'srv_fleet.png'))
        # 深浅測量：台帳の海底を 1m 深くした点群（現場からの m）を登録 → 残り土量が減る
        xyz = pg.evaluate("""() => { const s=byId('TK-2026-0001'), g=s.g, tp=decI16(s.terr.E), L=[]; for(let k=0;k<g.nv;k++) L.push(`${g.LX[k].toFixed(2)} ${(-g.LZ[k]).toFixed(2)} ${(tp[k]-1).toFixed(2)}`); return L.join('\\n'); }""")
        f = os.path.join(out, 'survey_test.xyz'); open(f, 'w').write(xyz)
        pg.evaluate("() => { state.tab='survey'; renderDock(); }"); pg.wait_for_selector('#svFile', timeout=20000)
        pg.fill('#svDate', '2026-10-01'); pg.select_option('#svKind', 'tp'); pg.set_input_files('#svFile', f); pg.click('#svUp')
        pg.wait_for_function("() => OPS.surveys.length===1 && document.querySelectorAll('#svSeries tr').length===3", timeout=30000)
        sv = pg.evaluate("() => [...document.querySelectorAll('#svSeries tr')].slice(1).map(r=>r.cells[1].textContent)"); print('測量の残り土量（台帳→登録）:', sv)
        num = [float(x.replace(',', '')) for x in sv]
        if not num[1] < num[0] * .8: fails.append('登録した測量で残り土量が減らない')
        pg.click('[data-svv="diff"]'); pg.wait_for_timeout(500); pg.screenshot(path=os.path.join(out, 'srv_survey.png'))
        # 協議記録・作業区域（描く）
        pg.evaluate("() => { state.tab='consult'; renderDock(); }"); pg.wait_for_selector('#cSave', timeout=10000)
        # 入力中・描画中に、再生（時刻の更新）や気象の取得で画面が描き直されて入力が消えないこと
        pg.fill('#cSum', '入力中の文章（消えないこと）'); pg.click('[data-draw="LineString"]'); pg.wait_for_timeout(3500)
        bx = pg.locator('.cesium-widget canvas').bounding_box(); cx, cy = bx['x'] + bx['width'] / 2, bx['y'] + bx['height'] / 2
        pg.mouse.click(cx - 60, cy); pg.mouse.click(cx + 60, cy)
        pg.click('#tlPlay'); pg.wait_for_timeout(3000); pg.click('#tlPlay')
        keep = pg.evaluate("() => ({txt:document.querySelector('#cSum').value, done:!document.querySelector('#zDone').hidden, pts:DRAW.pts.length})"); print('入力中に再生:', keep)
        if keep['txt'] != '入力中の文章（消えないこと）' or not keep['done'] or keep['pts'] != 2: fails.append('入力中・描画中に画面が描き直されて内容が消える')
        pg.click('#zCancel'); pg.evaluate("() => { setT(B); }")
        pg.select_option('#cParty', '漁協'); pg.fill('#cAtt', 'サンプル漁協 組合長／当社 所長'); pg.fill('#cSum', '浚渫土の運搬航路について協議（E2E）'); pg.fill('#cAgr', '8時〜16時は北側を通らない'); pg.click('#cSave'); pg.wait_for_timeout(1500)
        pg.fill('#cAtt', '連絡先 090-1234-5678'); pg.fill('#cSum', '個人情報の試験'); pg.click('#cSave'); pg.wait_for_timeout(1000)
        cs = pg.evaluate("() => ({n:OPS.consultations.length, msg:document.querySelector('#cMsg').textContent})"); print('協議記録:', cs)
        if cs['n'] != 1 or '連絡先' not in cs['msg']: fails.append('協議記録の保存・個人の連絡先の拒否が正しくない')
        pg.evaluate("() => renderConsultTab(byId('TK-2026-0001'))"); pg.click('[data-draw="Polygon"]'); pg.wait_for_timeout(4000)
        bx = pg.locator('.cesium-widget canvas').bounding_box(); cx, cy = bx['x'] + bx['width'] / 2, bx['y'] + bx['height'] / 2
        for dx, dy in ((-80, -50), (80, -50), (80, 50), (-80, 50)): pg.mouse.click(cx + dx, cy + dy); pg.wait_for_timeout(300)
        pg.fill('#zName', '浚渫の作業区域（E2E）'); pg.click('#zDone'); pg.wait_for_timeout(2000)
        zn = pg.evaluate("() => ({n:OPS.mapFeatures.length, pts:OPS.mapFeatures[0]&&OPS.mapFeatures[0].geometry.coordinates[0].length, ents:ZN.ents.length, near:OPS.mapFeatures[0]&&Math.hypot((OPS.mapFeatures[0].geometry.coordinates[0][0][0]-byId('TK-2026-0001').lon)*91,(OPS.mapFeatures[0].geometry.coordinates[0][0][1]-byId('TK-2026-0001').lat)*111)})")
        print('作業区域（描画）:', zn)
        if zn['n'] != 1 or zn['pts'] != 5 or zn['ents'] < 3 or zn['near'] > 1: fails.append('作業区域を描いて保存できない')
        pg.screenshot(path=os.path.join(out, 'srv_zone.png'))
        # 説明モード（発注者・漁協向け）に協議記録・配船が出ない
        pg.click('#presentBtn'); pg.evaluate("() => select('TK-2026-0001')"); pg.wait_for_timeout(2500)
        txt = pg.evaluate("() => document.body.innerText")
        leak = [w for w in ('E2E）', '組合長', '配船計画', '出来形の推移') if w in txt]; print('説明モードに出た社内情報:', leak or 'なし', '／区域の線:', pg.evaluate('() => ZN.ents.length'))
        if leak: fails.append('説明モードに協議記録・配船が出ている')
        pg.click('#presentEnd'); pg.wait_for_timeout(800)
        # 編集者は設定を見られない（パスワード変更だけ）
        pg.click('#setBtn'); pg.wait_for_timeout(800)
        if pg.is_visible('[data-prev]'): fails.append('編集者に連携の設定が見えている')
        pg.click('#setClose'); pg.click('#logoutBtn'); pg.wait_for_selector('#loginForm', timeout=30000)
        # 管理者：設定と文面の確認
        pg.fill('#loginForm [name=email]', 'admin@example.com'); pg.fill('#loginForm [name=password]', USERS['admin@example.com'][1]); pg.click('#loginForm button')
        pg.wait_for_function("() => typeof SITES!=='undefined' && document.querySelector('#boot').hidden", timeout=180000)
        if pg.is_visible('#keyDlg'): pg.click('#keySkip')
        pg.click('#setBtn'); pg.wait_for_selector('[data-prev="neo"]', timeout=10000)
        pg.fill('#neoUrl', 'https://neo.example.co.jp/api'); pg.click('[data-save="neo"]'); pg.wait_for_timeout(800)
        pg.click('[data-prev="neo"]'); pg.wait_for_selector('#prevBox pre', timeout=10000)
        prev = pg.inner_text('#prevBox'); print('NEO の文面:', prev[:120].replace('\n', ' '))
        if '遅延予測' not in prev or '送信はしません' not in prev: fails.append('NEO の文面確認が正しくない')
        pg.screenshot(path=os.path.join(out, 'srv_settings.png'))
        # 毎朝の定時処理：専用アカウントで日次の記録 → 8日前の記録（遅れを 10 日小さく）を足すと「予兆」になる
        job = subprocess.run([sys.executable, 'tools/daily_job.py', f'--base-url={base}', '--no-notify'], cwd=ROOT, env=env, capture_output=True, text=True, timeout=900)
        print('定時処理:', (job.stdout + job.stderr).strip()[:300])
        with psycopg.connect(URL, autocommit=True) as c:
            n = c.execute('SELECT count(*) FROM portal.delay_snapshots WHERE snap_date=current_date').fetchone()[0]
            c.execute("""INSERT INTO portal.delay_snapshots(site_key, snap_date, delay_days, forecast_end)
                         SELECT site_key, snap_date-8, delay_days-10, forecast_end FROM portal.delay_snapshots WHERE site_key='hk_ishikari' AND snap_date=current_date""")
        if job.returncode != 0 or n != 17: fails.append(f'定時処理の日次の記録が正しくない（{n} 件）')
        from server.trends import notify
        nt = notify(dry_run=True); print('予兆のメール（確認のみ）:', {k: v for k, v in nt.items() if k != 'body'})
        if nt.get('rising') != 1: fails.append('予兆の判定が正しくない')
        pg.click('#setClose'); pg.reload(); pg.wait_for_function("() => typeof SITES!=='undefined' && document.querySelector('#boot').hidden && TREND.ok", timeout=180000)
        pg.evaluate("() => { select(null); }"); pg.wait_for_timeout(2500)
        rs = pg.evaluate("() => { const c=[...document.querySelectorAll('#dockBody .card')].find(x=>/遅れの予兆/.test(x.textContent)); return c?{rows:c.querySelectorAll('tr.click').length, txt:c.textContent.slice(0,140)}:null; }")
        print('全国表示の遅れの予兆:', rs)
        if not rs or rs['rows'] != 1: fails.append('全国表示に遅れの予兆が出ない')
        pg.screenshot(path=os.path.join(out, 'srv_trend.png'))
        pg.evaluate("() => { select('HK-2026-0002'); state.tab='ai'; renderDock(); }"); pg.wait_for_timeout(2000)
        tr = pg.evaluate("() => /遅れの推移/.test(document.querySelector('#dockBody').textContent) && !!document.querySelector('#dockBody polyline')"); print('遅れの推移（グラフ）:', tr)
        if not tr: fails.append('遅れの推移が出ない')
        b.close()
finally:
    srv.terminate(); srv.wait(10)
print('ページのエラー:', errors[:5])
print('不合格:', fails or 'なし')
sys.exit(1 if fails or errors else 0)
