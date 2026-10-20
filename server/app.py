"""みらい建設工業 3D現場ポータル：配信とデータ（PostgreSQL）・ログインのサーバ。

起動：uvicorn server.app:app --host 0.0.0.0 --port 36621（systemd：tools/systemd/mirai-3d-portal.service）
- 画面の骨組み（index.html・loader.js・app.js）だけはログイン前でも返す（ログイン画面を出すため）
- 現場台帳・マスタ・Google のキーなどのデータは、ログインした人にだけ /api で返す（/data/* は返さない）
"""
import hmac
import os
import pathlib
import re
from datetime import datetime

from fastapi import FastAPI, HTTPException, Request
from fastapi.exceptions import RequestValidationError
from fastapi.responses import FileResponse, JSONResponse, Response
from fastapi.middleware.gzip import GZipMiddleware
from starlette.concurrency import run_in_threadpool
from psycopg.types.json import Jsonb
from pydantic import BaseModel, Field

import psycopg

from . import ai
from . import operations
from . import trends
from . import sites as site_ledger
from .db import connect
from .security import (require, require_csrf, login as do_login, logout as do_logout, set_cookie, clear_cookie, client_ip,
                       audit, hash_password, current_user, PH, check_password_policy, auth_mode, allowed_sites, check_site, scope_branches)

ROOT = pathlib.Path(__file__).resolve().parent.parent
STATIC = ROOT / 'online'
PUBLIC = {'/': 'index.html', '/index.html': 'index.html', '/loader.js': 'loader.js', '/app.js': 'app.js'}

app = FastAPI(title='みらい建設工業 3D現場ポータル', docs_url=None, redoc_url=None, openapi_url=None)
app.add_middleware(GZipMiddleware, minimum_size=2000)


@app.middleware('http')
async def headers(req: Request, call_next):
    resp = await call_next(req)
    resp.headers['X-Content-Type-Options'] = 'nosniff'
    resp.headers['X-Frame-Options'] = 'DENY'
    # Google のキーのリファラ制限に合うよう、他サイトへはオリジンだけを送る
    resp.headers['Referrer-Policy'] = 'strict-origin-when-cross-origin'
    if req.url.path.startswith('/api/'):
        resp.headers['Cache-Control'] = 'no-store'
    return resp


@app.exception_handler(HTTPException)
async def http_error(req: Request, exc: HTTPException):
    d = exc.detail
    body = {'error': d['message'], **{k: v for k, v in d.items() if k != 'message'}} if isinstance(d, dict) else {'error': d}
    return JSONResponse(body, status_code=exc.status_code)


@app.exception_handler(RequestValidationError)
async def validation_error(req: Request, exc: RequestValidationError):
    loc = ['.'.join(str(x) for x in e.get('loc', [])[1:]) for e in exc.errors()][:5]
    return JSONResponse({'error': '入力の値が正しくありません：' + '、'.join(x for x in loc if x)}, status_code=422)


@app.exception_handler(psycopg.errors.IntegrityError)
async def integrity_error(req: Request, exc: psycopg.errors.IntegrityError):
    # 制約違反（参照先が無い・範囲外など）は入力の誤りとして返す（中身は返さない）
    return JSONResponse({'error': '入力の値が正しくありません（参照先・範囲を確認してください）'}, status_code=400)


# ---------- 画面の骨組み ----------
@app.get('/')
@app.get('/index.html')
@app.get('/loader.js')
@app.get('/app.js')
def static_file(req: Request):
    f = STATIC / PUBLIC[req.url.path]
    return FileResponse(f, headers={'Cache-Control': 'no-cache'})


@app.get('/healthz')
def healthz():
    with connect() as c:
        c.execute('SELECT 1')
    return {'ok': True}


# ---------- ログイン ----------
class LoginIn(BaseModel):
    email: str = Field(max_length=254)
    password: str = Field(max_length=256)


@app.get('/api/auth/me')
def me(req: Request):
    u = current_user(req)
    if not u:
        # access だけの方式では、ログイン画面ではなく「Cloudflare Access 経由で開く」案内を出すため、方式を返す
        raise HTTPException(401, {'message': 'ログインしてください', 'authMode': auth_mode()})
    return user_info(u)


def user_info(u: dict) -> dict:
    br = scope_branches(u)
    return {'email': u['email'], 'role': u['role'], 'branches': sorted(br) if br is not None else None, 'via': u.get('via', 'password'), 'authMode': auth_mode()}


@app.post('/api/auth/login')
def login(body: LoginIn, req: Request):
    require_csrf(req)
    tok, u = do_login(body.email, body.password, client_ip(req), req.headers.get('user-agent', ''))
    resp = JSONResponse({'email': u['email'], 'role': u['role']})
    set_cookie(resp, tok)
    return resp


@app.post('/api/auth/logout')
def logout(req: Request):
    require_csrf(req)
    u = current_user(req)
    do_logout(req)
    if u:
        with connect() as c:
            audit(c, u['id'], 'logout', {'via': u.get('via')}, client_ip(req))
    # Cloudflare Access でサインインした人は、Access のサインアウト（このホストの /cdn-cgi/access/logout）へ
    resp = JSONResponse({'ok': True, **({'logoutUrl': '/cdn-cgi/access/logout'} if u and u.get('via') == 'access' else {})})
    clear_cookie(resp)
    return resp


class PasswordIn(BaseModel):
    current: str = Field(max_length=256)
    new: str = Field(max_length=256)


@app.post('/api/auth/password')
def change_password(body: PasswordIn, req: Request):
    require_csrf(req)
    u = require(req)
    if u.get('via') == 'access':
        raise HTTPException(400, 'Cloudflare Access でサインインしているため、ここではパスワードを変えられません（社内 LAN の入口から変更してください）')
    try:
        check_password_policy(body.new)
    except ValueError as e:
        raise HTTPException(400, str(e))
    with connect() as c:
        row = c.execute('SELECT pw_hash FROM portal.users WHERE id=%s', (u['id'],)).fetchone()
        try:
            PH.verify(row['pw_hash'], body.current)
        except Exception:
            raise HTTPException(400, 'いまのパスワードが違います')
        c.execute('UPDATE portal.users SET pw_hash=%s, pw_changed_at=now() WHERE id=%s', (hash_password(body.new), u['id']))
        c.execute('DELETE FROM portal.sessions WHERE user_id=%s', (u['id'],))   # ほかの端末のセッションも切る
        audit(c, u['id'], 'password_change', {}, client_ip(req))
    resp = JSONResponse({'ok': True, 'relogin': True})
    clear_cookie(resp)
    return resp


# ---------- データ ----------
@app.get('/api/bootstrap')
def bootstrap(req: Request):
    u = require(req)
    with connect() as c:
        keys = allowed_sites(c, u)
    return {'user': user_info(u), **bootstrap_data(keys),
            'googleMapTilesKey': os.environ.get('GOOGLE_MAP_TILES_KEY', ''),
            'features': {'ai': ai.enabled(), 'ais': bool(os.environ.get('AIS_INGEST_TOKEN'))}}


def bootstrap_data(keys: set[str] | None = None) -> dict:
    """画面の起動に使うデータ（利用者・キーを除く）。keys＝見られる現場（None＝すべて。毎朝の定時処理は全現場）。"""
    ok = (lambda k: True) if keys is None else (lambda k: k in keys)
    with connect() as c:
        # 完了（archived）した現場は出さない。台帳の版（_version）は画面の編集で使う
        sites = [{**r['data'], '_version': r['version'], '_origin': r['origin']}
                 for r in c.execute('SELECT data, version, origin FROM portal.sites WHERE archived_at IS NULL ORDER BY (data->>\'seq\')::int NULLS LAST, key')
                 if ok(r['data']['key'])]
        active = {s['key'] for s in sites}
        master = {r['key']: r['data'] for r in c.execute('SELECT key, data FROM portal.master')}
        prog = {}
        for r in c.execute('SELECT site_key, task_idx, a, updated_at FROM portal.progress ORDER BY site_key, task_idx'):
            if r['site_key'] not in active:
                continue
            p = prog.setdefault(r['site_key'], {'a': {}, 'at': None})
            p['a'][r['task_idx']] = float(r['a'])
            p['at'] = max(p['at'] or r['updated_at'], r['updated_at'])
        vessels = list(c.execute('SELECT id, name, type, site_key AS site, lon, lat, heading, speed, source, extra, updated_at FROM portal.vessels ORDER BY source, id'))
        ops = operations.operations_data(c, active)       # 完了した現場の配船は、他支店と同じく伏せて期間だけ
    for p in prog.values():
        p['at'] = p['at'].isoformat() if p['at'] else None
    for v in vessels:
        v.update(v.pop('extra') or {})
        v['updated_at'] = v['updated_at'].isoformat()
        if v['site'] and v['site'] not in active:   # 船は全社で共有。範囲外の所属現場は伏せる
            v['site'] = None
    return {'sites': sites, 'master': master.get('master', {}), 'japan': master.get('japan', {}), 'progress': prog, 'vessels': vessels, **ops}


class ProgressIn(BaseModel):
    a: list[float] = Field(min_length=1, max_length=50)
    note: str | None = Field(default=None, max_length=500)


@app.put('/api/progress/{site_key}')
def put_progress(site_key: str, body: ProgressIn, req: Request):
    require_csrf(req)
    u = require(req, 'editor')
    if not re.fullmatch(r'[a-z0-9_]{1,64}', site_key):
        raise HTTPException(400, '現場のキーが正しくありません')
    if any(not (0 <= x <= 1) for x in body.a):
        raise HTTPException(400, '出来高は 0〜1 の範囲にしてください')
    with connect() as c:
        check_site(c, u, site_key)
        if not c.execute('SELECT 1 FROM portal.sites WHERE key=%s AND archived_at IS NULL', (site_key,)).fetchone():
            raise HTTPException(404, '現場が見つかりません')
        old = {r['task_idx']: float(r['a']) for r in c.execute('SELECT task_idx, a FROM portal.progress WHERE site_key=%s', (site_key,))}
        changed = 0
        for i, a in enumerate(body.a):
            a = round(a, 4)
            if old.get(i) == a:
                continue
            c.execute("""INSERT INTO portal.progress(site_key, task_idx, a, updated_by) VALUES (%s,%s,%s,%s)
                         ON CONFLICT (site_key, task_idx) DO UPDATE SET a=EXCLUDED.a, updated_by=EXCLUDED.updated_by, updated_at=now()""", (site_key, i, a, u['id']))
            c.execute('INSERT INTO portal.progress_history(site_key, task_idx, a_old, a_new, note, user_id) VALUES (%s,%s,%s,%s,%s,%s)',
                      (site_key, i, old.get(i), a, body.note, u['id']))
            changed += 1
        audit(c, u['id'], 'progress_update', {'site': site_key, 'changed': changed}, client_ip(req))
    return {'ok': True, 'changed': changed, 'at': datetime.now().isoformat()}


@app.delete('/api/progress/{site_key}')
def reset_progress(site_key: str, req: Request):
    require_csrf(req)
    u = require(req, 'editor')
    with connect() as c:
        check_site(c, u, site_key)
        n = c.execute('DELETE FROM portal.progress WHERE site_key=%s', (site_key,)).rowcount
        audit(c, u['id'], 'progress_reset', {'site': site_key, 'rows': n}, client_ip(req))
    return {'ok': True}


@app.get('/api/progress/{site_key}/history')
def progress_history(site_key: str, req: Request):
    u = require(req)
    with connect() as c:
        check_site(c, u, site_key)
        rows = list(c.execute("""SELECT h.task_idx, h.a_old, h.a_new, h.note, h.at, u.email FROM portal.progress_history h
                                 LEFT JOIN portal.users u ON u.id=h.user_id WHERE h.site_key=%s ORDER BY h.at DESC LIMIT 100""", (site_key,)))
    return [{**r, 'a_old': float(r['a_old']) if r['a_old'] is not None else None, 'a_new': float(r['a_new']), 'at': r['at'].isoformat()} for r in rows]


@app.get('/api/vessels')
def vessels(req: Request):
    require(req)
    with connect() as c:
        rows = list(c.execute("SELECT id, name, type, lon, lat, heading, speed, source, updated_at FROM portal.vessels WHERE source='ais'"))
    return [{**r, 'updated_at': r['updated_at'].isoformat()} for r in rows]


class AisIn(BaseModel):
    id: str = Field(pattern=r'^[A-Za-z0-9_-]{1,32}$')
    name: str = Field(max_length=80)
    type: str = Field(default='other', max_length=20)
    lon: float = Field(ge=120, le=155)
    lat: float = Field(ge=20, le=47)
    heading: float | None = Field(default=None, ge=0, le=360)
    speed: float | None = Field(default=None, ge=0, le=60)


@app.post('/api/ais/ingest')
def ais_ingest(items: list[AisIn], req: Request):
    """AIS 受信機・AIS サービスからの位置の取り込み口（AIS_INGEST_TOKEN がないときは無効）。"""
    tok = os.environ.get('AIS_INGEST_TOKEN', '')
    auth = req.headers.get('authorization', '')
    if not tok:
        raise HTTPException(404, 'AIS の取り込みは無効です')
    if not hmac.compare_digest(auth, f'Bearer {tok}'):
        raise HTTPException(401, '認証に失敗しました')
    if len(items) > 500:
        raise HTTPException(413, '一度に送れるのは 500 件までです')
    with connect() as c:
        for v in items:
            c.execute("""INSERT INTO portal.vessels(id, name, type, lon, lat, heading, speed, source) VALUES (%s,%s,%s,%s,%s,%s,%s,'ais')
                         ON CONFLICT (id) DO UPDATE SET name=EXCLUDED.name, type=EXCLUDED.type, lon=EXCLUDED.lon, lat=EXCLUDED.lat,
                         heading=EXCLUDED.heading, speed=EXCLUDED.speed, source='ais', updated_at=now()""",
                      ('ais-' + v.id, v.name, v.type, v.lon, v.lat, v.heading, v.speed))
        audit(c, None, 'ais_ingest', {'n': len(items)}, client_ip(req))
    return {'ok': True, 'n': len(items)}


# ---------- 連携の設定（desknet's NEO・メール・AI）：設定と文面の確認だけ。送信はしない ----------
SETTING_FIELDS = {
    'neo': {'enabled': bool, 'baseUrl': str, 'boardId': str, 'schedule': str, 'title': str, 'template': str},
    'mail': {'enabled': bool, 'smtpHost': str, 'smtpPort': int, 'tls': bool, 'smtpUser': str, 'from': str, 'to': list, 'schedule': str, 'subject': str, 'template': str},
    'ai': {'note': str},
    'warning': {'deltaDays': int, 'compareDays': int},
}
SECRET_ENV = {'neo': 'NEO_API_TOKEN', 'mail': 'SMTP_PASSWORD', 'ai': 'ANTHROPIC_API_KEY', 'warning': ''}
DEFAULTS = {
    'neo': {'enabled': False, 'baseUrl': '', 'boardId': '', 'schedule': '08:00', 'title': '【3D現場ポータル】遅延予測のお知らせ（{date}）',
            'template': '遅れの予兆（前週より悪化）：{rising} 件\n{rising_lines}\n\n遅延予測（14日超）：{late} 件／1〜14日：{warn} 件（全 {total} 現場）\n{lines}\n詳しくは 3D現場ポータルをご覧ください。'},
    'mail': {'enabled': False, 'smtpHost': '', 'smtpPort': 587, 'tls': True, 'smtpUser': '', 'from': '', 'to': [], 'schedule': '08:00',
             'subject': '【3D現場ポータル】遅れの予兆 {rising} 件（{date}）',
             'template': '各位\n\n前週より遅れが大きくなった現場（遅れの予兆）：{rising} 件\n{rising_lines}\n\n遅延予測（14日超）：{late} 件／1〜14日：{warn} 件（全 {total} 現場）\n{lines}\n\n3D現場ポータルから自動で作成しています（予兆がある日だけ、1日1回）。'},
    'ai': {'note': ''},
    'warning': dict(trends.WARNING_DEFAULT),
}


def _clean_settings(key, value: dict) -> dict:
    out = {}
    bad = HTTPException(400, '設定の値の型が正しくありません')
    for f, typ in SETTING_FIELDS[key].items():
        if f not in value:
            continue
        v = value[f]
        if typ is bool:
            if not isinstance(v, bool):
                raise bad
        elif typ is int:
            hi = {'compareDays': 60, 'deltaDays': 90}.get(f, 90) if key == 'warning' else 65535   # 判定（trends.warning_rule）の上限と同じ
            if isinstance(v, bool) or not isinstance(v, int) or not 1 <= v <= hi:
                raise HTTPException(400, f'{f} の値が正しくありません')
        elif typ is list:
            if not isinstance(v, list) or not all(isinstance(x, str) for x in v):
                raise bad
            v = [x.strip()[:254] for x in v if x.strip()][:50]
        else:
            if not isinstance(v, str):
                raise bad
            v = v[:2000]
        if f in ('baseUrl',) and v and not re.match(r'^https://', v):
            raise HTTPException(400, '接続先は https:// で始まる URL にしてください')
        out[f] = v
    return out


@app.get('/api/settings')
def get_settings(req: Request):
    require(req, 'admin')
    with connect() as c:
        rows = {r['key']: r['value'] for r in c.execute('SELECT key, value FROM portal.settings')}
    return {k: {**DEFAULTS[k], **rows.get(k, {}), 'secretSet': bool(os.environ.get(SECRET_ENV[k])), 'secretEnv': SECRET_ENV[k]} for k in SETTING_FIELDS}


@app.put('/api/settings/{key}')
def put_settings(key: str, value: dict, req: Request):
    require_csrf(req)
    u = require(req, 'admin')
    if key not in SETTING_FIELDS:
        raise HTTPException(404, '設定の項目が見つかりません')
    v = _clean_settings(key, value)
    with connect() as c:
        c.execute("""INSERT INTO portal.settings(key, value, updated_by) VALUES (%s,%s,%s)
                     ON CONFLICT (key) DO UPDATE SET value=EXCLUDED.value, updated_by=EXCLUDED.updated_by, updated_at=now()""", (key, Jsonb(v), u['id']))
        audit(c, u['id'], 'settings_update', {'key': key, 'fields': sorted(v)}, client_ip(req))
    return {'ok': True}


class Summary(BaseModel):
    total: int = Field(ge=0, le=10000)
    late: int = Field(ge=0, le=10000)
    warn: int = Field(ge=0, le=10000)
    lines: list[str] = Field(default_factory=list, max_length=100)


@app.post('/api/notify/preview/{channel}')
def notify_preview(channel: str, body: Summary, req: Request):
    """送る文面の確認（送信はしない）。日次の記録があれば、定時処理が送るのと同じ値（最新の記録）で作る。
    まだ無いときは、画面のワールドモデルが計算した値（body）で作る。"""
    require_csrf(req)
    require(req, 'admin')
    if channel not in ('neo', 'mail'):
        raise HTTPException(404, '通知先が見つかりません')
    with connect() as c:
        row = c.execute('SELECT value FROM portal.settings WHERE key=%s', (channel,)).fetchone()
        db = trends.summary(c)
    s = {**DEFAULTS[channel], **(row['value'] if row else {})}
    if db['latestDate']:
        vals, src = db, f"最新の日次の記録（{db['date']}）の値です。"
    else:
        vals = {'date': datetime.now().strftime('%Y/%m/%d'), 'total': body.total, 'late': body.late, 'warn': body.warn,
                'lines': '\n'.join('・' + x[:120] for x in body.lines[:30]), 'rising': 0, 'rising_lines': '（日次の記録がまだ無いため判定できません）'}
        src = '日次の記録がまだ無いため、いま画面で計算した値です。'
    out = {'channel': channel, 'enabled': s.get('enabled', False), 'secretSet': bool(os.environ.get(SECRET_ENV[channel])), 'sent': False}
    if channel == 'neo':
        out.update({'title': trends.fill(s['title'], vals), 'body': trends.fill(s['template'], vals), 'endpoint': s['baseUrl'] or '（未設定）', 'board': s['boardId'] or '（未設定）',
                    'note': src + 'desknet\'s NEO へは送信しません（文面の確認のみ）。',
                    'apiNote': "desknet's NEO の API の仕様（エンドポイント・認証方式・掲示板の指定方法）は要確認です。"})
    else:
        miss = trends.mail_ready(s)
        out.update({'subject': trends.fill(s['subject'], vals), 'body': trends.fill(s['template'], vals), 'from': s['from'] or '（未設定）', 'to': s['to'] or ['（未設定）'],
                    'server': f"{s['smtpHost'] or '（未設定）'}:{s['smtpPort']}",
                    'note': src + ('毎朝の定時処理が、予兆がある日だけ 1日1回送ります。' if not miss else '送信の条件がそろっていません：' + '、'.join(miss) + '。')})
    return out


# ---------- AI による文章化（任意） ----------
@app.post('/api/ai/explain')
async def ai_explain(analysis: dict, req: Request):
    require_csrf(req)
    u = await run_in_threadpool(require, req)      # DB は同期処理なので別スレッドで（イベントループを止めない）
    if not ai.enabled():
        raise HTTPException(404, 'AI による文章化は無効です')
    try:
        out = await ai.explain(analysis)
    except ai.AIError as e:
        raise HTTPException(e.status, e.message)

    def log():
        with connect() as c:
            audit(c, u['id'], 'ai_explain', {'site': str(analysis.get('site', ''))[:40]}, client_ip(req))
    await run_in_threadpool(log)
    return out


app.include_router(site_ledger.router)
app.include_router(trends.router)
app.include_router(operations.router)   # 配船計画・深浅測量・協議記録・区域（下の「見つからない」より前に）


@app.get('/{path:path}')
def not_found(path: str):
    return Response(status_code=404)
