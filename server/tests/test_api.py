"""サーバの検査：ログイン・権限・CSRF・データの取り出し・実績の保存・設定・取り込み口。"""
from .conftest import H, PW, login


def test_static_public_and_data_hidden(client):
    assert client.get('/').status_code == 200
    assert client.get('/loader.js').status_code == 200
    assert client.get('/app.js').status_code == 200
    for p in ('/data/sites.json', '/data/config.json', '/data/master.json', '/server/.env', '/tools/sites.json'):
        assert client.get(p).status_code == 404, p
    r = client.get('/')
    assert r.headers['x-frame-options'] == 'DENY' and r.headers['x-content-type-options'] == 'nosniff'
    assert 'private' in client.get('/app.js').headers['cache-control']      # 途中の CDN にキャッシュさせない


def test_api_requires_login(client):
    for p in ('/api/auth/me', '/api/bootstrap', '/api/vessels', '/api/settings', '/api/progress/tk_tokyo/history'):
        assert client.get(p).status_code == 401, p


def test_login_generic_error_and_cookie(client):
    r1 = client.post('/api/auth/login', json={'email': 'nobody@example.com', 'password': 'x' * 12}, headers=H)
    r2 = client.post('/api/auth/login', json={'email': 'viewer@example.com', 'password': 'wrong-password-1'}, headers=H)
    assert r1.status_code == r2.status_code == 401 and r1.json() == r2.json()
    r = client.post('/api/auth/login', json={'email': 'Viewer@Example.com', 'password': PW['viewer@example.com']}, headers=H)
    assert r.status_code == 200
    sc = r.headers['set-cookie'].lower()
    assert 'httponly' in sc and 'samesite=strict' in sc
    assert client.get('/api/auth/me').json()['role'] == 'viewer'


def test_csrf_header_required(client):
    assert client.post('/api/auth/login', json={'email': 'viewer@example.com', 'password': PW['viewer@example.com']}).status_code == 403
    login(client, 'editor@example.com')
    assert client.put('/api/progress/tk_tokyo', json={'a': [1, 0.5]}).status_code == 403
    assert client.put('/api/progress/tk_tokyo', json={'a': [1, 0.5]}, headers={**H, 'Origin': 'http://evil.example'}).status_code == 403


def test_lockout_after_five_failures(client):
    from server.db import connect
    from server.security import PH
    with connect() as c:
        c.execute("INSERT INTO portal.users(email, pw_hash, role) VALUES ('lock@example.com', %s, 'viewer')", (PH.hash('lock-pass-123456'),))
    for _ in range(5):
        assert client.post('/api/auth/login', json={'email': 'lock@example.com', 'password': 'bad-password-xx'}, headers=H).status_code == 401
    r = client.post('/api/auth/login', json={'email': 'lock@example.com', 'password': 'lock-pass-123456'}, headers=H)
    assert r.status_code == 423
    with connect() as c:
        n = c.execute("SELECT count(*) AS n FROM portal.audit_log WHERE action='login_fail'").fetchone()['n']
    assert n >= 5   # 失敗は記録されている（例外で取り消されていない）


def test_bootstrap_content(client):
    login(client, 'viewer@example.com')
    b = client.get('/api/bootstrap').json()
    assert len(b['sites']) == 17 and b['sites'][0]['key'] == 'hk_tomakomai'
    assert [s['seq'] for s in b['sites']] == list(range(17))
    assert 'region' in b['master'] and 'tide' in b['master'] and 'prefs' in b['japan']
    assert b['googleMapTilesKey'] == 'test-key-not-real'
    assert len([v for v in b['vessels'] if v['source'] == 'demo']) == 7
    assert b['features'] == {'ai': False, 'ais': False}
    assert any(s.get('survey') for s in b['sites'])


def test_progress_roles_validation_and_history(client):
    login(client, 'viewer@example.com')
    assert client.put('/api/progress/tk_tokyo', json={'a': [1, 0.5]}, headers=H).status_code == 403
    login(client, 'editor@example.com')
    assert client.put('/api/progress/tk_tokyo', json={'a': [1.5]}, headers=H).status_code == 400
    assert client.put('/api/progress/no_such_site', json={'a': [1]}, headers=H).status_code == 404
    assert client.put('/api/progress/BAD-KEY', json={'a': [1]}, headers=H).status_code == 400
    r = client.put('/api/progress/tk_tokyo', json={'a': [1, 0.9, 0.4], 'note': '週報より'}, headers=H)
    assert r.status_code == 200 and r.json()['changed'] == 3
    assert client.put('/api/progress/tk_tokyo', json={'a': [1, 0.9, 0.5]}, headers=H).json()['changed'] == 1
    p = client.get('/api/bootstrap').json()['progress']['tk_tokyo']['a']
    assert p == {'0': 1.0, '1': 0.9, '2': 0.5}
    h = client.get('/api/progress/tk_tokyo/history').json()
    assert h[0]['a_new'] == 0.5 and h[0]['email'] == 'editor@example.com'
    assert client.delete('/api/progress/tk_tokyo', headers=H).status_code == 200
    assert 'tk_tokyo' not in client.get('/api/bootstrap').json()['progress']


def test_settings_admin_only_no_secrets_no_send(client):
    login(client, 'editor@example.com')
    assert client.get('/api/settings').status_code == 403
    login(client, 'admin@example.com')
    s = client.get('/api/settings').json()
    assert set(s) == {'neo', 'mail', 'ai', 'warning'} and s['neo']['secretSet'] is False
    assert all('token' not in k.lower() and 'password' not in k.lower() for k in s['mail'])
    assert client.put('/api/settings/neo', json={'baseUrl': 'http://insecure.example'}, headers=H).status_code == 400
    assert client.put('/api/settings/neo', json={'enabled': True, 'baseUrl': 'https://neo.example.co.jp/api', 'boardId': 'B1', 'evil': 'x'}, headers=H).status_code == 200
    s = client.get('/api/settings').json()
    assert s['neo']['baseUrl'] == 'https://neo.example.co.jp/api' and 'evil' not in s['neo']
    for bad in ({'enabled': 'false'}, {'smtpPort': 'abc'}, {'smtpPort': None}, {'to': 'a@example.com'}, {'smtpHost': 123}):
        assert client.put('/api/settings/mail', json=bad, headers=H).status_code == 400, bad
    r = client.post('/api/notify/preview/mail', json={'total': 17, 'late': 3, 'warn': 9, 'lines': ['HK-2026-0002 石狩湾新港 +105日']}, headers=H).json()
    assert r['sent'] is False and ('石狩湾新港' in r['body'] or '日次の記録' in r['note'])


def test_ais_ingest_and_ai_disabled(client, monkeypatch):
    assert client.post('/api/ais/ingest', json=[]).status_code == 404
    monkeypatch.setenv('AIS_INGEST_TOKEN', 'tok-123')
    item = [{'id': 'MMSI431000001', 'name': '試験船', 'lon': 139.78, 'lat': 35.59, 'heading': 90, 'speed': 4.5}]
    assert client.post('/api/ais/ingest', json=item, headers={'Authorization': 'Bearer nope'}).status_code == 401
    assert client.post('/api/ais/ingest', json=item, headers={'Authorization': 'Bearer tok-123'}).status_code == 200
    assert client.post('/api/ais/ingest', json=[{**item[0], 'lat': 99}], headers={'Authorization': 'Bearer tok-123'}).status_code == 422
    login(client, 'viewer@example.com')
    assert [v['id'] for v in client.get('/api/vessels').json()] == ['ais-MMSI431000001']
    assert client.post('/api/ai/explain', json={'site': 'x'}, headers=H).status_code == 404


def test_password_change_and_logout(client):
    from server.db import connect
    from server.security import PH
    with connect() as c:
        c.execute("INSERT INTO portal.users(email, pw_hash, role) VALUES ('pw@example.com', %s, 'viewer')", (PH.hash('old-password-1234'),))
    PW['pw@example.com'] = 'old-password-1234'
    login(client, 'pw@example.com')
    assert client.post('/api/auth/password', json={'current': 'old-password-1234', 'new': 'short'}, headers=H).status_code == 400
    assert client.post('/api/auth/password', json={'current': 'wrong-password', 'new': 'new-password-12345'}, headers=H).status_code == 400
    assert client.post('/api/auth/password', json={'current': 'old-password-1234', 'new': 'new-password-12345'}, headers=H).status_code == 200
    assert client.get('/api/auth/me').status_code == 401          # セッションは切れる
    PW['pw@example.com'] = 'new-password-12345'
    login(client, 'pw@example.com')
    assert client.post('/api/auth/logout', headers=H).status_code == 200
    assert client.get('/api/auth/me').status_code == 401
