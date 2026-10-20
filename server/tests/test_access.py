"""Cloudflare Access（Entra ID）：JWT の検証（RS256・発行元・AUD・有効期限）、登録済み・有効な利用者だけ、方式ごとの動き、接続元 IP。"""
import base64
import hashlib
import hmac
import json
import time
from types import SimpleNamespace

import jwt
import psycopg
import pytest
from cryptography.hazmat.primitives import serialization
from cryptography.hazmat.primitives.asymmetric import rsa

from .conftest import H, PW, TEST_URL, login

TEAM, AUD = 'mirai-test.cloudflareaccess.com', 'aud-test-0123456789'
KEY = rsa.generate_private_key(public_exponent=65537, key_size=2048)
OTHER = rsa.generate_private_key(public_exponent=65537, key_size=2048)


def tok(email='viewer@example.com', key=KEY, **over):
    now = int(time.time())
    claims = {'email': email, 'iss': f'https://{TEAM}', 'aud': [AUD], 'iat': now, 'nbf': now, 'exp': now + 600, 'type': 'app', 'sub': 'x', **over}
    return jwt.encode(claims, key, algorithm='RS256', headers={'kid': 'k1'})


@pytest.fixture
def access(monkeypatch):
    import server.security as sec
    monkeypatch.setenv('CF_ACCESS_TEAM_DOMAIN', TEAM)
    monkeypatch.setenv('CF_ACCESS_AUD', AUD)
    monkeypatch.setattr(sec, '_signing_key', lambda token, team: KEY.public_key())     # 偽の IdP の公開鍵
    def mode(m):
        monkeypatch.setenv('AUTH_MODE', m)
    return mode


def me(client, t):
    return client.get('/api/auth/me', headers={'Cf-Access-Jwt-Assertion': t})


def test_valid_token_maps_to_registered_user(client, access):
    access('access')
    r = me(client, tok())
    assert r.status_code == 200 and r.json()['email'] == 'viewer@example.com' and r.json()['via'] == 'access' and r.json()['authMode'] == 'access'
    assert client.get('/api/bootstrap', headers={'Cf-Access-Jwt-Assertion': tok()}).status_code == 200
    with psycopg.connect(TEST_URL) as c:
        assert c.execute("SELECT count(*) FROM portal.audit_log WHERE action='login_access'").fetchone()[0] >= 1


def test_bad_tokens_are_rejected(client, access):
    access('access')
    now = int(time.time())
    hs = '.'.join(base64.urlsafe_b64encode(json.dumps(x).encode()).rstrip(b'=').decode() for x in ({'alg': 'HS256', 'typ': 'JWT'},
          {'email': 'viewer@example.com', 'iss': f'https://{TEAM}', 'aud': AUD, 'iat': now, 'exp': now + 600}))
    pem = KEY.public_key().public_bytes(serialization.Encoding.PEM, serialization.PublicFormat.SubjectPublicKeyInfo)
    hs += '.' + base64.urlsafe_b64encode(hmac.new(pem, hs.encode(), hashlib.sha256).digest()).rstrip(b'=').decode()   # 公開鍵を HMAC の鍵にする攻撃
    none = jwt.encode({'email': 'viewer@example.com', 'iss': f'https://{TEAM}', 'aud': AUD, 'iat': now, 'exp': now + 600}, None, algorithm='none')
    for t in (tok(aud=['other-app']), tok(iss='https://evil.cloudflareaccess.com'), tok(exp=now - 3600, iat=now - 7200, nbf=now - 7200),
              tok(key=OTHER), hs, none, tok(email='nobody@example.com'), tok(email=''), 'garbage', tok(nbf=now + 3600)):
        assert me(client, t).status_code == 401, t[:40]
    r = me(client, '')
    assert r.status_code == 401 and r.json()['authMode'] == 'access'


def test_inactive_user_and_key_fetch_failure(client, access, monkeypatch):
    access('access')
    with psycopg.connect(TEST_URL, autocommit=True) as c:
        c.execute("INSERT INTO portal.users(email, pw_hash, role, active) VALUES ('gone@example.com','x','viewer',false) ON CONFLICT DO NOTHING")
    assert me(client, tok('gone@example.com')).status_code == 401
    import server.security as sec
    def fail(*a): raise jwt.PyJWKClientError('network')
    monkeypatch.setattr(sec, '_signing_key', fail)
    assert me(client, tok()).status_code == 401          # 公開鍵を取れなければ通さない


def test_modes(client, access):
    access('access')
    r = client.post('/api/auth/login', json={'email': 'viewer@example.com', 'password': PW['viewer@example.com']}, headers=H)
    assert r.status_code == 403                                                      # access だけ：パスワードのログインは無効
    access('password')
    login(client, 'viewer@example.com')                                              # 既定：これまでどおり
    assert me(client, tok('admin@example.com')).json()['email'] == 'viewer@example.com'   # password 方式では JWT を見ない
    access('access')
    assert client.get('/api/auth/me').status_code == 401                             # access だけ：パスワードのセッションは使わない
    access('both')
    assert client.get('/api/auth/me').json()['email'] == 'viewer@example.com'        # 併用：セッションも使える
    assert me(client, tok('admin@example.com')).json()['email'] == 'admin@example.com'    # 併用：JWT を優先
    access('access')
    hdr = {**H, 'Cf-Access-Jwt-Assertion': tok('editor@example.com')}
    assert client.post('/api/auth/password', json={'current': 'x', 'new': 'y' * 12}, headers=hdr).status_code == 400
    assert client.post('/api/auth/logout', headers=hdr).json()['logoutUrl'] == '/cdn-cgi/access/logout'


def test_unconfigured_access_lets_nobody_in(client, monkeypatch):
    monkeypatch.setenv('AUTH_MODE', 'access')
    monkeypatch.delenv('CF_ACCESS_TEAM_DOMAIN', raising=False); monkeypatch.delenv('CF_ACCESS_AUD', raising=False)
    assert me(client, tok()).status_code == 401


def test_client_ip_behind_tunnel(monkeypatch):
    from server.security import client_ip
    req = lambda peer, hdr: SimpleNamespace(client=SimpleNamespace(host=peer), headers=hdr)
    monkeypatch.delenv('TRUST_CF_CONNECTING_IP', raising=False)
    assert client_ip(req('127.0.0.1', {'cf-connecting-ip': '203.0.113.5'})) == '127.0.0.1'      # 既定：ヘッダーを信用しない
    monkeypatch.setenv('TRUST_CF_CONNECTING_IP', '1')
    assert client_ip(req('127.0.0.1', {'cf-connecting-ip': '203.0.113.5'})) == '203.0.113.5'    # トンネル（このサーバ自身）から
    assert client_ip(req('192.168.0.50', {'cf-connecting-ip': '203.0.113.5'})) == '192.168.0.50'   # LAN から直接：偽れない


def test_pyjwt_is_patched():
    """GHSA-ffc3-869f-jxw9（critical）などを直した PyJWT 2.14.0 以上であること。"""
    assert tuple(int(x) for x in jwt.__version__.split('.')[:2]) >= (2, 14)
