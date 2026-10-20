"""ログイン（メールアドレス＋パスワード）・セッション・CSRF 対策・試行回数の制限。

- パスワードは Argon2id でハッシュ化して保存（平文は保存しない）
- セッションは DB に持ち、Cookie にはランダムなトークンだけを入れる（DB には SHA-256）
- Cookie は HttpOnly・SameSite=Strict（https のときは Secure も）
- 変更系の API は独自ヘッダ X-Portal-Request を必須にする（他サイトからのフォーム送信を防ぐ。CORS は許可しない）
- ログイン失敗：同じアカウントで 5 回続けて失敗すると 15 分ロック。同じ IP から 10 分に 20 回まで
"""
import hashlib
import os
import secrets
import threading
import time
from datetime import datetime, timedelta, timezone

from argon2 import PasswordHasher
from argon2.exceptions import VerifyMismatchError, InvalidHashError, VerificationError
from fastapi import HTTPException, Request

from .db import connect

PH = PasswordHasher()   # Argon2id（argon2-cffi の既定値）
COOKIE = 'mp_session'
SESSION_HOURS = float(os.environ.get('SESSION_HOURS', '12'))
COOKIE_SECURE = os.environ.get('COOKIE_SECURE', '0') == '1'
CSRF_HEADER = 'x-portal-request'
LOCK_FAILS, LOCK_MIN = 5, 15
IP_WINDOW, IP_MAX = 600, int(os.environ.get('LOGIN_IP_MAX', '20'))
MIN_PW = 12
ROLES = ('viewer', 'editor', 'admin')
# 存在しないアカウントでも同じだけ時間をかける（アカウントの有無を時間差で推測させない）
_DUMMY = PH.hash(secrets.token_urlsafe(16))
_ip_hits: dict[str, list[float]] = {}
_lock = threading.Lock()


def now() -> datetime:
    return datetime.now(timezone.utc)


def hash_token(tok: str) -> str:
    return hashlib.sha256(tok.encode()).hexdigest()


def client_ip(req: Request) -> str:
    return req.client.host if req.client else '-'


def check_password_policy(pw: str) -> None:
    if len(pw) < MIN_PW:
        raise ValueError(f'パスワードは {MIN_PW} 文字以上にしてください')
    if pw.strip() != pw:
        raise ValueError('パスワードの前後に空白は使えません')


def hash_password(pw: str) -> str:
    check_password_policy(pw)
    return PH.hash(pw)


def audit(c, user_id, action, detail=None, ip=None):
    from psycopg.types.json import Jsonb
    c.execute('INSERT INTO portal.audit_log(user_id, action, detail, ip) VALUES (%s,%s,%s,%s)', (user_id, action, Jsonb(detail or {}), ip))


def ip_limited(ip: str) -> bool:
    t = time.time()
    with _lock:
        hits = [x for x in _ip_hits.get(ip, []) if t - x < IP_WINDOW]
        hits.append(t)
        _ip_hits[ip] = hits
        return len(hits) > IP_MAX


def login(email: str, password: str, ip: str, ua: str) -> tuple[str, dict]:
    """成功すればセッションのトークンと利用者を返す。失敗は理由を区別しない同じエラー。
    失敗の記録（回数・ロック・監査ログ）は確定させてから例外を投げる。"""
    fail = HTTPException(401, 'メールアドレスまたはパスワードが違います')
    if ip_limited(ip):
        raise HTTPException(429, 'ログインの試行が多すぎます。しばらく待ってからやり直してください')
    email = (email or '').strip().lower()
    err, result = None, None
    with connect() as c:
        u = c.execute('SELECT * FROM portal.users WHERE email=%s', (email,)).fetchone()
        if not u:
            try:
                PH.verify(_DUMMY, password or '')
            except VerificationError:
                pass
            audit(c, None, 'login_fail', {'email': email[:120], 'reason': 'unknown'}, ip)
            err = fail
        elif not u['active']:
            audit(c, u['id'], 'login_fail', {'reason': 'inactive'}, ip)
            err = fail
        elif u['locked_until'] and u['locked_until'] > now():
            audit(c, u['id'], 'login_fail', {'reason': 'locked'}, ip)
            err = HTTPException(423, 'ログインの失敗が続いたため、しばらくロックしています。15分ほどしてからやり直してください')
        else:
            try:
                PH.verify(u['pw_hash'], password or '')
                ok = True
            except (VerifyMismatchError, InvalidHashError, VerificationError):
                ok = False
            if not ok:
                # 同時に失敗が来ても数え漏れないよう、1つの UPDATE で加算とロックを決める（行ロックつき）
                r = c.execute("""UPDATE portal.users SET
                                   locked_until = CASE WHEN failed_count + 1 >= %s THEN now() + make_interval(mins => %s) ELSE locked_until END,
                                   failed_count = CASE WHEN failed_count + 1 >= %s THEN 0 ELSE failed_count + 1 END
                                 WHERE id=%s RETURNING locked_until""", (LOCK_FAILS, LOCK_MIN, LOCK_FAILS, u['id'])).fetchone()
                locked = bool(r and r['locked_until'] and r['locked_until'] > now())
                audit(c, u['id'], 'login_fail', {'reason': 'password', 'locked': locked}, ip)
                err = fail
            else:
                if PH.check_needs_rehash(u['pw_hash']):
                    c.execute('UPDATE portal.users SET pw_hash=%s WHERE id=%s', (PH.hash(password), u['id']))
                tok = secrets.token_urlsafe(32)
                c.execute('INSERT INTO portal.sessions(token_hash, user_id, expires_at, ip, user_agent) VALUES (%s,%s,%s,%s,%s)',
                          (hash_token(tok), u['id'], now() + timedelta(hours=SESSION_HOURS), ip, (ua or '')[:200]))
                c.execute('UPDATE portal.users SET failed_count=0, locked_until=NULL, last_login_at=now() WHERE id=%s', (u['id'],))
                c.execute('DELETE FROM portal.sessions WHERE expires_at < now()')
                audit(c, u['id'], 'login', {}, ip)
                result = (tok, {'id': u['id'], 'email': u['email'], 'role': u['role']})
    if err:
        raise err
    return result


def current_user(req: Request) -> dict | None:
    tok = req.cookies.get(COOKIE)
    if not tok:
        return None
    with connect() as c:
        r = c.execute("""SELECT u.id, u.email, u.role, u.active, s.expires_at FROM portal.sessions s JOIN portal.users u ON u.id=s.user_id
                         WHERE s.token_hash=%s""", (hash_token(tok),)).fetchone()
        if not r or not r['active'] or r['expires_at'] < now():
            return None
        c.execute('UPDATE portal.sessions SET last_seen_at=now() WHERE token_hash=%s', (hash_token(tok),))
        return {'id': r['id'], 'email': r['email'], 'role': r['role']}


def logout(req: Request) -> None:
    tok = req.cookies.get(COOKIE)
    if tok:
        with connect() as c:
            c.execute('DELETE FROM portal.sessions WHERE token_hash=%s', (hash_token(tok),))


def require(req: Request, role: str = 'viewer') -> dict:
    u = current_user(req)
    if not u:
        raise HTTPException(401, 'ログインしてください')
    if ROLES.index(u['role']) < ROLES.index(role):
        raise HTTPException(403, 'この操作の権限がありません')
    return u


def require_csrf(req: Request) -> None:
    """変更系の API：独自ヘッダが必須。Origin があれば、このサーバと同じであること。"""
    if req.headers.get(CSRF_HEADER) != '1':
        raise HTTPException(403, '不正なリクエストです（X-Portal-Request がありません）')
    origin = req.headers.get('origin')
    if origin and origin.split('://', 1)[-1] != req.headers.get('host', ''):
        raise HTTPException(403, '不正なリクエストです（Origin が違います）')


def set_cookie(resp, tok: str) -> None:
    resp.set_cookie(COOKIE, tok, max_age=int(SESSION_HOURS * 3600), httponly=True, samesite='strict', secure=COOKIE_SECURE, path='/')


def clear_cookie(resp) -> None:
    resp.delete_cookie(COOKIE, path='/')
