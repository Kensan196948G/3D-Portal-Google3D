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
out = sys.argv[1]; os.makedirs(out, exist_ok=True)
env = {**os.environ, 'DATABASE_URL': URL, 'GOOGLE_MAP_TILES_KEY': '', 'AI_ENABLED': '0', 'LOGIN_IP_MAX': '1000'}
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
        b.close()
finally:
    srv.terminate(); srv.wait(10)
print('ページのエラー:', errors[:5])
print('不合格:', fails or 'なし')
sys.exit(1 if fails or errors else 0)
