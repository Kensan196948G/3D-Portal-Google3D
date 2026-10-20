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
from fastapi.responses import FileResponse, JSONResponse, Response
from fastapi.middleware.gzip import GZipMiddleware
from psycopg.types.json import Jsonb
from pydantic import BaseModel, Field

from . import ai
from .db import connect
from .security import (require, require_csrf, login as do_login, logout as do_logout, set_cookie, clear_cookie, client_ip,
                       audit, hash_password, current_user, PH, check_password_policy)

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
    return JSONResponse({'error': exc.detail}, status_code=exc.status_code)


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
        raise HTTPException(401, 'ログインしてください')
    return {'email': u['email'], 'role': u['role']}


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
            audit(c, u['id'], 'logout', {}, client_ip(req))
    resp = JSONResponse({'ok': True})
    clear_cookie(resp)
    return resp


class PasswordIn(BaseModel):
    current: str = Field(max_length=256)
    new: str = Field(max_length=256)


@app.post('/api/auth/password')
def change_password(body: PasswordIn, req: Request):
    require_csrf(req)
    u = require(req)
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
        sites = [r['data'] for r in c.execute('SELECT data FROM portal.sites ORDER BY (data->>\'seq\')::int NULLS LAST, key')]
        master = {r['key']: r['data'] for r in c.execute('SELECT key, data FROM portal.master')}
        prog = {}
        for r in c.execute('SELECT site_key, task_idx, a, updated_at FROM portal.progress ORDER BY site_key, task_idx'):
            p = prog.setdefault(r['site_key'], {'a': {}, 'at': None})
            p['a'][r['task_idx']] = float(r['a'])
            p['at'] = max(p['at'] or r['updated_at'], r['updated_at'])
        vessels = list(c.execute('SELECT id, name, type, site_key AS site, lon, lat, heading, speed, source, extra, updated_at FROM portal.vessels'))
    for p in prog.values():
        p['at'] = p['at'].isoformat() if p['at'] else None
    for v in vessels:
        v.update(v.pop('extra') or {})
        v['updated_at'] = v['updated_at'].isoformat()
    return {'user': {'email': u['email'], 'role': u['role']}, 'sites': sites, 'master': master.get('master', {}), 'japan': master.get('japan', {}),
            'progress': prog, 'vessels': vessels, 'googleMapTilesKey': os.environ.get('GOOGLE_MAP_TILES_KEY', ''),
            'features': {'ai': ai.enabled(), 'ais': bool(os.environ.get('AIS_INGEST_TOKEN'))}}


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
        if not c.execute('SELECT 1 FROM portal.sites WHERE key=%s', (site_key,)).fetchone():
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
        n = c.execute('DELETE FROM portal.progress WHERE site_key=%s', (site_key,)).rowcount
        audit(c, u['id'], 'progress_reset', {'site': site_key, 'rows': n}, client_ip(req))
    return {'ok': True}


@app.get('/api/progress/{site_key}/history')
def progress_history(site_key: str, req: Request):
    require(req)
    with connect() as c:
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
}
SECRET_ENV = {'neo': 'NEO_API_TOKEN', 'mail': 'SMTP_PASSWORD', 'ai': 'ANTHROPIC_API_KEY'}
DEFAULTS = {
    'neo': {'enabled': False, 'baseUrl': '', 'boardId': '', 'schedule': '08:00', 'title': '【3D現場ポータル】遅延予測のお知らせ（{date}）',
            'template': '遅延予測（14日超）：{late} 件／1〜14日：{warn} 件（全 {total} 現場）\n{lines}\n詳しくは 3D現場ポータルをご覧ください。'},
    'mail': {'enabled': False, 'smtpHost': '', 'smtpPort': 587, 'tls': True, 'smtpUser': '', 'from': '', 'to': [], 'schedule': '08:00',
             'subject': '【3D現場ポータル】遅延予測 {late} 件（{date}）', 'template': '各位\n\n遅延予測（14日超）：{late} 件／1〜14日：{warn} 件（全 {total} 現場）\n{lines}\n\n3D現場ポータルから自動で作成しています。'},
    'ai': {'note': ''},
}


def _clean_settings(key, value: dict) -> dict:
    out = {}
    for f, typ in SETTING_FIELDS[key].items():
        if f not in value:
            continue
        v = value[f]
        if typ is bool:
            v = bool(v)
        elif typ is int:
            v = int(v)
            if not 1 <= v <= 65535:
                raise HTTPException(400, f'{f} の値が正しくありません')
        elif typ is list:
            v = [str(x).strip()[:254] for x in (v or []) if str(x).strip()][:50]
        else:
            v = str(v)[:2000]
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
    """送る文面の確認（送信はしない）。遅延の件数は画面のワールドモデルが計算した値を受け取る。"""
    require_csrf(req)
    require(req, 'admin')
    if channel not in ('neo', 'mail'):
        raise HTTPException(404, '通知先が見つかりません')
    with connect() as c:
        row = c.execute('SELECT value FROM portal.settings WHERE key=%s', (channel,)).fetchone()
    s = {**DEFAULTS[channel], **(row['value'] if row else {})}
    vals = {'date': datetime.now().strftime('%Y/%m/%d'), 'total': body.total, 'late': body.late, 'warn': body.warn,
            'lines': '\n'.join('・' + x[:120] for x in body.lines[:30])}
    fmt = lambda t: re.sub(r'\{(date|total|late|warn|lines)\}', lambda m: str(vals[m.group(1)]), t)
    out = {'channel': channel, 'enabled': s.get('enabled', False), 'secretSet': bool(os.environ.get(SECRET_ENV[channel])), 'sent': False,
           'note': '設定と文面の確認のみです。送信の機能はまだありません。'}
    if channel == 'neo':
        out.update({'title': fmt(s['title']), 'body': fmt(s['template']), 'endpoint': s['baseUrl'] or '（未設定）', 'board': s['boardId'] or '（未設定）',
                    'apiNote': "desknet's NEO の API の仕様（エンドポイント・認証方式・掲示板の指定方法）は要確認です。"})
    else:
        out.update({'subject': fmt(s['subject']), 'body': fmt(s['template']), 'from': s['from'] or '（未設定）', 'to': s['to'] or ['（未設定）'],
                    'server': f"{s['smtpHost'] or '（未設定）'}:{s['smtpPort']}"})
    return out


# ---------- AI による文章化（任意） ----------
@app.post('/api/ai/explain')
async def ai_explain(analysis: dict, req: Request):
    require_csrf(req)
    u = require(req)
    if not ai.enabled():
        raise HTTPException(404, 'AI による文章化は無効です')
    try:
        out = await ai.explain(analysis)
    except ai.AIError as e:
        raise HTTPException(e.status, e.message)
    with connect() as c:
        audit(c, u['id'], 'ai_explain', {'site': str(analysis.get('site', ''))[:40]}, client_ip(req))
    return out


@app.get('/{path:path}')
def not_found(path: str):
    return Response(status_code=404)
